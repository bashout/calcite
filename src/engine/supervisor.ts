import { ChildProcess, spawn, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { EventEmitter } from "events";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { createServer, Socket } from "net";
import * as os from "os";
import * as path from "path";
import bridgePySource from "../../bridge/bridge.py";
import { locatePythonUno, locateSoffice } from "./locator";
import { EngineInfo, engineFile, pidAlive, pruneWindows, readEngineInfo, removeEngineInfo, stateDir, writeEngineInfo } from "./registry";

export interface CellData {
  v: string | number | boolean | null;
  s: string;
  f?: string;
  err?: number;
}

export interface GridData {
  sheet: string;
  range: { startCol: number; startRow: number; endCol: number; endRow: number } | null;
  rows: CellData[][];
}

export type EngineState = "stopped" | "starting" | "ready" | "error";

interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

// bridge.py is embedded into main.js at build time (esbuild ".py": "text"
// loader) and extracted here to the per-user state dir, so a release is a
// single-file install — GitHub release assets cannot carry path separators,
// so shipping bridge/bridge.py as a separate asset is not an option.
// CALCITE_BRIDGE overrides for tests.
function bridgePath(): string {
  if (process.env.CALCITE_BRIDGE) return process.env.CALCITE_BRIDGE;
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, "bridge.py");
  try {
    // Rewrite when the embedded source changed, so the extracted script
    // always matches the shipped main.js.
    if (readFileSync(f, "utf8") !== bridgePySource) throw new Error("stale");
  } catch {
    // Atomic write: a concurrently starting engine never sees a partial file.
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, bridgePySource, { mode: 0o600 });
    renameSync(tmp, f);
  }
  return f;
}

const REQUEST_TIMEOUT_MS = 30000;
const MAX_RESTARTS = 5;
const HEARTBEAT_MS = 5000;
const PING_TIMEOUT_MS = 5000;
const ENGINE_POLL_MS = 4000;
/** Bump when bridge.py's command set changes; stale engines are respawned. */
const BRIDGE_VERSION = "9-macos-intree-a1";

/** Convert an absolute OS path to a file:// URL (Windows needs file:///C:/...). */
function pathToFileUrl(p: string): string {
  const abs = path.resolve(p);
  if (process.platform === "win32") return "file:///" + abs.replace(/\\/g, "/");
  return "file://" + abs;
}

/**
 * Kill an engine and its whole process tree. POSIX (Linux + macOS): the engine
 * is spawned detached, so it owns a process group — kill the negative pid.
 * Windows has no process groups/signals; use taskkill /T (tree), /F for the
 * forced pass, then fall back to a direct kill.
 */
function killEngine(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try {
      spawnSync("taskkill", args, { timeout: 10000, stdio: "ignore" });
    } catch {
      /* taskkill missing — direct kill below still applies */
    }
  } else {
    try {
      process.kill(-pid, signal); // process group (soffice.bin is in it)
    } catch {
      /* group already gone */
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already dead */
  }
}

interface ProcInfo {
  pid: number;
  ppid: number;
  cmd: string;
}

/**
 * Best-effort process table with command lines, per platform:
 * Linux reads /proc, macOS uses ps, Windows uses PowerShell/CIM.
 * Returns [] when the mechanism is unavailable — callers treat it as
 * "cannot determine" and skip (never delete/kill blindly).
 */
function listProcesses(): ProcInfo[] {
  try {
    if (process.platform === "linux") {
      const out: ProcInfo[] = [];
      for (const pid of readdirSync("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
          if (!cmdline) continue;
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
          out.push({ pid: Number(pid), ppid, cmd: cmdline.replace(/\0/g, " ") });
        } catch {
          /* process vanished */
        }
      }
      return out;
    }
    if (process.platform === "darwin") {
      const r = spawnSync("ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 64 * 1024 * 1024,
      });
      const out: ProcInfo[] = [];
      if (r.status === 0 && r.stdout) {
        for (const line of r.stdout.split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
          if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
        }
      }
      return out;
    }
    if (process.platform === "win32") {
      const r = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 }
      );
      if (r.status === 0 && r.stdout) {
        const j = JSON.parse(r.stdout);
        const arr = Array.isArray(j) ? j : [j];
        return arr
          .filter((p: any) => p && p.ProcessId != null)
          .map((p: any) => ({
            pid: Number(p.ProcessId),
            ppid: Number(p.ParentProcessId ?? 0),
            cmd: String(p.CommandLine ?? ""),
          }));
      }
      return [];
    }
  } catch {
    /* best effort */
  }
  return [];
}

/**
 * One shared headless LibreOffice engine per user, multiplexed across
 * Obsidian windows/vaults. The first window spawns the engine and registers
 * it in the per-user registry; later windows attach. The last window out
 * shuts the engine down. No obsidian imports — testable standalone.
 */
export class EngineSupervisor extends EventEmitter {
  state: EngineState = "stopped";
  lastError = "";
  /** "owner" spawned the shared engine, "attached" connected to an existing one. */
  mode: "owner" | "attached" | null = null;

  private sofficeBin: string | null = null;
  private pythonBin: string | null = null;
  private sofficeProc: ChildProcess | null = null;
  /** Tail of soffice's piped stderr, for diagnosing why it exited. */
  private sofficeErrBuf = "";
  private bridgeProc: ChildProcess | null = null;
  private sock: Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | null = null;
  private connectStr: string | null = null;
  private profileDir: string | null = null;
  private bridgePort = 0;
  private bridgeToken = "";
  private engineInfo: EngineInfo | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private enginePollTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Unique per plugin instance (window), not just per process. */
  private windowId = `${process.pid}-${randomBytes(4).toString("hex")}`;

  constructor(private vaultRoot: string) {
    super();
  }

  assertInVault(absPath: string): string {
    const resolved = path.resolve(absPath);
    const root = path.resolve(this.vaultRoot);
    // Windows paths are case-insensitive (and drive-letter casing varies).
    if (process.platform === "win32") {
      const r = resolved.toLowerCase();
      const rt = root.toLowerCase();
      if (r !== rt && !r.startsWith(rt + path.sep)) {
        throw new Error(`path outside vault: ${resolved}`);
      }
      return resolved;
    }
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`path outside vault: ${resolved}`);
    }
    return resolved;
  }

  async start(): Promise<void> {
    if (this.state === "ready") return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private setState(s: EngineState, err = "") {
    this.state = s;
    this.lastError = err;
    this.emit("state", s, err);
    if (s === "ready") this.startEnginePoll();
    else this.stopEnginePoll();
  }

  /** Actively ping the engine so a dead soffice (e.g. killed externally) is
   *  detected even when no child-process exit event fires (attached mode). */
  private startEnginePoll() {
    this.stopEnginePoll();
    this.enginePollTimer = setInterval(() => {
      if (this.state !== "ready") return;
      this.request("ping", {}, PING_TIMEOUT_MS).catch((e) => {
        if (this.state !== "ready") return;
        console.log(`[calcite] engine heartbeat failed: ${e.message}`);
        // Force-kill the registered engine (its bridge may still be listening
        // while soffice is dead — re-attaching to it would hang). Then respawn.
        const info = readEngineInfo();
        if (info && pidAlive(info.pid)) killEngine(info.pid, "SIGKILL");
        removeEngineInfo();
        this.scheduleRestart("engine heartbeat failed");
      });
    }, ENGINE_POLL_MS);
  }

  private stopEnginePoll() {
    if (this.enginePollTimer) {
      clearInterval(this.enginePollTimer);
      this.enginePollTimer = null;
    }
  }

  private async doStart(): Promise<void> {
    this.sofficeBin = locateSoffice();
    if (!this.sofficeBin) throw new Error("LibreOffice (soffice) not found on this system");
    this.pythonBin = locatePythonUno();
    // On macOS the bridge runs inside the soffice process tree (macOS 26+
    // SIGKILLs direct spawns of the bundled interpreter — launch constraints
    // in the TDF signature), so no standalone python-uno is needed there.
    if (process.platform !== "darwin" && !this.pythonBin) {
      throw new Error("python-uno not found (install python3-uno or LibreOffice's bundled python)");
    }
    this.reapOrphanEngines();

    // Try to attach to an existing shared engine first.
    const existing = readEngineInfo();
    if (existing) {
      const pruned = pruneWindows(existing);
      if (pruned.bridgeVersion !== BRIDGE_VERSION && pidAlive(pruned.pid)) {
        // Engine runs an older bridge without the current command set: tear it
        // down so we respawn with fresh code.
        console.log(`[calcite] engine bridge version ${pruned.bridgeVersion} != ${BRIDGE_VERSION}, respawning`);
        killEngine(pruned.pid, "SIGTERM");
      } else if (pidAlive(pruned.pid)) {
        try {
          await this.attach(pruned);
          return;
        } catch (e) {
          console.log(`[calcite] existing engine unreachable (${e}), starting a new one`);
        }
      }
      removeEngineInfo();
    }

    // Become the owner: spawn soffice + a shared bridge, register the engine.
    this.setState("starting");
    const unoPort = await getFreePort();
    const unoToken = randomBytes(24).toString("hex");
    this.bridgePort = await getFreePort();
    this.bridgeToken = randomBytes(24).toString("hex");
    this.profileDir = path.join(os.tmpdir(), `calcite-lo-${process.pid}-${Date.now()}`);
    const accept = `socket,host=127.0.0.1,port=${unoPort},token=${unoToken};urp;`;

    if (process.platform === "darwin") {
      // macOS: the bridge must live inside the soffice process tree, so
      // soffice itself starts it as a user script (see spawnSofficeInTree).
      this.sofficeProc = this.spawnSofficeInTree(accept);
    } else {
      this.sofficeProc = spawn(
        this.sofficeBin,
        ["--headless", "--norestore", "--nolockcheck", "--nodefault", `-env:UserInstallation=${pathToFileUrl(this.profileDir)}`, `--accept=${accept}`],
        // detached => own process group (POSIX), so killEngine can take down
        // soffice.bin too; windowsHide avoids a console flash on Windows.
        { stdio: ["ignore", "ignore", "pipe"], detached: true, windowsHide: true }
      );
    }
    // soffice's stderr is piped but otherwise unread — keep a rolling tail so
    // an unexpected exit (e.g. code 0 before the in-tree bridge comes up) can
    // be diagnosed instead of showing only the exit code.
    this.sofficeErrBuf = "";
    this.sofficeProc.stderr?.on("data", (c: Buffer) => {
      this.sofficeErrBuf += c.toString("utf8");
      if (this.sofficeErrBuf.length > 4000) this.sofficeErrBuf = this.sofficeErrBuf.slice(-4000);
    });
    this.sofficeProc.on("exit", (code) => {
      if (this.state !== "stopped" && this.mode === "owner") {
        this.scheduleRestart(`soffice exited (${code})${this.sofficeStderrTail() ? ` stderr: ${this.sofficeStderrTail()}` : ""}`);
      }
    });

    this.connectStr = `socket,host=127.0.0.1,port=${unoPort},token=${unoToken};urp;StarOffice.ComponentContext`;
    if (process.platform === "darwin") {
      // No separate bridge process: wait for the in-tree bridge's socket.
      await this.waitForBridgeSocket(this.bridgePort, this.bridgeToken, 60000);
    } else {
      await this.spawnBridgeAndWaitReady(this.connectStr);
      await this.connectBridgeSocket(this.bridgePort, this.bridgeToken);
    }

    this.mode = "owner";
    this.engineInfo = {
      pid: this.sofficeProc.pid!,
      unoPort, unoToken,
      bridgePort: this.bridgePort,
      bridgeToken: this.bridgeToken,
      bridgeVersion: BRIDGE_VERSION,
      windows: {},
    };
    this.registerWindow();
    this.setState("ready");
    this.restartCount = 0;
  }

  private async attach(info: EngineInfo): Promise<void> {
    this.setState("starting");
    this.engineInfo = info;
    this.connectStr = `socket,host=127.0.0.1,port=${info.unoPort},token=${info.unoToken};urp;StarOffice.ComponentContext`;
    await this.connectBridgeSocket(info.bridgePort, info.bridgeToken, 10000);
    this.mode = "attached";
    this.registerWindow();
    this.setState("ready");
    this.restartCount = 0;
  }

  /** Connect to the shared bridge's token-authenticated socket. */
  private connectBridgeSocket(port: number, token: string, timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      let buf = "";
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("bridge socket timed out"));
      }, timeoutMs);
      sock.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      sock.connect(port, "127.0.0.1", () => {
        sock.write(token + "\n");
      });
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const idx = buf.indexOf("\n");
        if (idx < 0) return;
        const line = buf.slice(0, idx).trim();
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.event === "ok") {
          clearTimeout(timer);
          sock.off("data", onData);
          this.sock = sock;
          this.attachTransport(sock, () => this.onTransportExit());
          resolve();
        } else if (msg.event === "fatal") {
          clearTimeout(timer);
          sock.off("data", onData);
          sock.destroy();
          reject(new Error(msg.error));
        }
      };
      sock.on("data", onData);
    });
  }

  private registerWindow() {
    if (!this.engineInfo) return;
    const write = () => {
      const info = pruneWindows({
        ...this.engineInfo!,
        windows: { ...this.engineInfo!.windows, [this.windowId]: Date.now() },
      });
      writeEngineInfo(info);
      this.engineInfo = info;
    };
    write();
    this.heartbeatTimer = setInterval(write, HEARTBEAT_MS);
  }

  private deregisterWindow(): EngineInfo | null {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const info = readEngineInfo();
    if (!info) return null;
    delete info.windows[this.windowId];
    const pruned = pruneWindows(info);
    if (Object.keys(pruned.windows).length === 0) {
      removeEngineInfo();
      return null; // we were the last window
    }
    writeEngineInfo(pruned);
    return pruned;
  }

  /**
   * macOS process model: the bundled LibreOfficePython.framework interpreter
   * is only permitted to launch from inside the LibreOffice process tree
   * (parent-launch constraints in the TDF signature; macOS 26+ SIGKILLs any
   * other spawn). So instead of spawning python from Node, bridge.py is
   * copied into the engine profile's user scripts dir and soffice runs it
   * via the scripting framework. The bridge then uses the in-process UNO
   * context (no CALCITE_UNO_CONNECT) and serves the same token-authenticated
   * localhost socket, which waitForBridgeSocket attaches to.
   */
  private spawnSofficeInTree(accept: string): ChildProcess {
    const bridgeSrc = bridgePath();
    if (!existsSync(bridgeSrc)) {
      throw new Error(`bridge script not found: ${bridgeSrc}`);
    }
    const scriptsDir = path.join(this.profileDir!, "user", "scripts", "python");
    mkdirSync(scriptsDir, { recursive: true });
    copyFileSync(bridgeSrc, path.join(scriptsDir, "calcite_bridge.py"));
    const scriptUri = "vnd.sun.star.script:calcite_bridge.py$main?language=Python&location=user";
    return spawn(
      this.sofficeBin!,
      [
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        `-env:UserInstallation=${pathToFileUrl(this.profileDir!)}`,
        `--accept=${accept}`,
        scriptUri,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
        windowsHide: true,
        env: {
          ...process.env,
          // No CALCITE_UNO_CONNECT: the in-tree bridge uses the local context.
          CALCITE_BRIDGE_LISTEN: String(this.bridgePort),
          CALCITE_BRIDGE_TOKEN: this.bridgeToken,
        },
      }
    );
  }

  /**
   * Poll the bridge socket until the in-tree (macOS) bridge accepts and
   * completes the token handshake. Fails fast if soffice died first.
   */
  /** Last few stderr lines of the soffice process ("" when silent). */
  private sofficeStderrTail(): string {
    return this.sofficeErrBuf.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
  }

  private async waitForBridgeSocket(port: number, token: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      if (this.sofficeProc && this.sofficeProc.exitCode !== null) {
        const tail = this.sofficeStderrTail();
        throw new Error(`soffice exited before the in-tree bridge came up (code=${this.sofficeProc.exitCode})${tail ? ` stderr: ${tail}` : ""}`);
      }
      try {
        await this.connectBridgeSocket(port, token, 5000);
        return;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`in-tree bridge socket not ready after ${timeoutMs}ms: ${lastErr}`);
  }

  private async spawnBridgeAndWaitReady(connect: string, timeoutMs = 30000): Promise<void> {
    const bridgePath_ = bridgePath();
    if (!existsSync(bridgePath_)) {
      throw new Error(`bridge script not found: ${bridgePath_}`);
    }
    this.bridgeProc = spawn(this.pythonBin!, [bridgePath_], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        CALCITE_UNO_CONNECT: connect,
        CALCITE_BRIDGE_LISTEN: String(this.bridgePort),
        CALCITE_BRIDGE_TOKEN: this.bridgeToken,
      },
    });

    await new Promise<void>((resolve, reject) => {
      let buf = "";
      let errBuf = "";
      this.bridgeProc?.stderr?.on("data", (c: Buffer) => {
        errBuf += c.toString("utf8");
        if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
      });
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.event === "ready" || msg.event === "listening") {
            cleanup();
            resolve();
          } else if (msg.event === "fatal") {
            cleanup();
            reject(new Error(msg.error));
          }
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`bridge exited before ready (code=${code}) python=${this.pythonBin} bridge=${bridgePath_} stderr: ${errBuf.trim().split("\n").slice(-3).join(" | ")}`));
      };
      const bridge = this.bridgeProc;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("bridge startup timed out"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        bridge?.stdout?.off("data", onData);
        bridge?.off("exit", onExit);
      };
      bridge?.stdout?.on("data", onData);
      bridge?.on("exit", onExit);
    });
  }

  private onTransportExit() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge connection lost"));
    }
    this.pending.clear();
    if (this.state !== "stopped" && this.mode === "owner") this.scheduleRestart("bridge connection lost");
  }

  private attachTransport(readable: NodeJS.ReadableStream, onExit: () => void) {
    let buf = "";
    readable.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error));
        }
      }
    });
    readable.on("close", onExit);
    readable.on("error", onExit);
  }

  private scheduleRestart(reason: string) {
    if (this.restartTimer || this.state === "stopped" || this.state === "starting") return;
    if (this.restartCount >= MAX_RESTARTS) {
      this.setState("error", `engine lost: ${reason}`);
      return;
    }
    this.restartCount++;
    this.setState("starting", reason);
    const delay = Math.min(1000 * 2 ** (this.restartCount - 1), 10000);
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      void this.killProcs();
      try {
        await this.doStart();
      } catch (e) {
        this.scheduleRestart(e instanceof Error ? e.message : String(e));
      }
    }, delay);
  }

  private async killProcs(): Promise<void> {
    const soffice = this.sofficeProc;
    for (const p of [this.bridgeProc, this.sofficeProc]) {
      if (p && p.exitCode === null && p.pid) {
        try {
          if (p === soffice) killEngine(p.pid, "SIGTERM"); // whole tree (soffice.bin)
          else p.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }
    }
    this.bridgeProc = null;
    this.sofficeProc = null;
    if (soffice?.pid && soffice.exitCode === null) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        killEngine(soffice.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }

  /**
   * Kill leftover headless engines from dead sessions (profiles under
   * <tmpdir>/calcite-lo-*, reparented to init). A live Obsidian window keeps
   * a live parent, so parallel vaults never kill each other. Best effort on
   * all platforms: /proc on Linux, ps on macOS, CIM on Windows; if the process
   * table can't be read, nothing is reaped.
   */
  private reapOrphanEngines(): void {
    const procs = listProcesses();
    if (!procs.length) return;
    // The spawned engines carry -env:UserInstallation=file://<tmpdir>/calcite-lo-...
    const profilePrefix = pathToFileUrl(path.join(os.tmpdir(), "calcite-lo-"));
    const orphans: number[] = [];
    for (const p of procs) {
      if (p.pid === process.pid) continue;
      if (!p.cmd.includes("soffice") || !p.cmd.includes(profilePrefix)) continue;
      // Orphaned when reparented to init (pid 1 on POSIX) or, on Windows, when
      // the parent process no longer exists.
      const orphaned = p.ppid === 1 || (process.platform === "win32" && p.ppid !== 0 && !pidAlive(p.ppid));
      if (orphaned) orphans.push(p.pid);
    }
    for (const pid of orphans) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`[calcite] reaped orphan engine pid ${pid}`);
      } catch {
        /* already dead */
      }
    }
    if (orphans.length) {
      setTimeout(() => {
        for (const pid of orphans) {
          try {
            killEngine(pid, "SIGKILL");
          } catch {
            /* already dead */
          }
        }
      }, 1500).unref();
    }
  }

  /**
   * LibreOffice lock files (.~lock.<name>#) name the profile that holds them.
   * If no live soffice process uses that profile, the lock is stale (e.g. from
   * a killed instance) and makes loads fail — remove it. Best effort on all
   * platforms; skipped when the process table can't be read.
   */
  private removeStaleLock(absPath: string): void {
    const lock = path.join(path.dirname(absPath), `.~lock.${path.basename(absPath)}#`);
    if (!existsSync(lock)) return;
    try {
      const content = readFileSync(lock, "utf8");
      const m = content.match(/file:\/\/[^\s;"']+/);
      if (!m) return;
      const profileUrl = m[0]; // e.g. file:///tmp/calcite-lo-... or file:///C:/.../calcite-lo-...
      const procs = listProcesses();
      if (!procs.length) return; // cannot tell — never delete blindly
      for (const p of procs) {
        if (p.cmd.includes("soffice") && p.cmd.includes(profileUrl)) return; // live holder
      }
      unlinkSync(lock);
      console.log(`[calcite] removed stale lock: ${lock}`);
    } catch {
      /* best effort */
    }
  }

  /** Serialize all engine requests so commands never interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  async request(cmd: string, params: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    return this.enqueue(async () => {
      // Wait for the engine to become ready (e.g. mid-restart) instead of failing.
      if (this.state !== "ready") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.off("state", onState);
            reject(new Error(`engine not ready (state=${this.state})`));
          }, timeoutMs);
          const onState = (s: EngineState) => {
            if (s === "ready") {
              clearTimeout(timer);
              this.off("state", onState);
              resolve();
            } else if (s === "error" || s === "stopped") {
              clearTimeout(timer);
              this.off("state", onState);
              reject(new Error(`engine not ready (state=${s})`));
            }
          };
          this.on("state", onState);
        });
      }
      const writable = this.sock ?? this.bridgeProc?.stdin;
      if (this.state !== "ready" || !writable) {
        throw new Error(`engine not ready (state=${this.state})`);
      }
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`request '${cmd}' timed out`));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        writable.write(JSON.stringify({ id, cmd, params }) + "\n");
      });
    });
  }

  /** Path to the system soffice binary, if located. */
  get sofficePath(): string | null {
    return this.sofficeBin;
  }

  /** Test hook: current UNO connect string (contains the auth token). */
  connectStringForTest(): string | null {
    return this.connectStr;
  }

  async ping(): Promise<string> {
    const r = await this.request("ping");
    return r.version;
  }

  async listSheets(docId: number): Promise<string[]> {
    await this.start();
    const r = await this.request("sheets", { docId });
    return r.sheets;
  }

  async loadFile(vaultPath: string): Promise<{ docId: number; sheets: string[]; readOnly?: boolean }> {
    // Accept vault-relative paths (Obsidian TFile.path) or absolute paths.
    const abs = path.isAbsolute(vaultPath)
      ? this.assertInVault(vaultPath)
      : this.assertInVault(path.join(this.vaultRoot, vaultPath));
    this.removeStaleLock(abs);
    await this.start();
    // "root" lets the engine enforce that paths stay under a registered vault.
    return this.request("load", { path: abs, root: path.resolve(this.vaultRoot) });
  }

  async dumpSheet(docId: number, sheet: string, maxRows = 500, maxCols = 100, window?: { startCol: number; startRow: number; endCol: number; endRow: number }): Promise<GridData> {
    await this.start();
    const params: Record<string, unknown> = { docId, sheet, maxRows, maxCols };
    if (window) params.window = window;
    return this.request("dump", params);
  }

  async setCell(docId: number, sheet: string, col: number, row: number, text: string): Promise<void> {
    await this.start();
    await this.request("setCell", { docId, sheet, col, row, text });
  }

  async insertRows(docId: number, sheet: string, row: number, count: number): Promise<{ sheets: string[] }> {
    await this.start();
    return this.request("insertRows", { docId, sheet, row, count });
  }

  async insertCols(docId: number, sheet: string, col: number, count: number): Promise<{ sheets: string[] }> {
    await this.start();
    return this.request("insertCols", { docId, sheet, col, count });
  }

  async deleteRows(docId: number, sheet: string, row: number, count: number): Promise<{ sheets: string[] }> {
    await this.start();
    return this.request("deleteRows", { docId, sheet, row, count });
  }

  async deleteCols(docId: number, sheet: string, col: number, count: number): Promise<{ sheets: string[] }> {
    await this.start();
    return this.request("deleteCols", { docId, sheet, col, count });
  }

  async addSheet(docId: number, name: string): Promise<{ sheets: string[] }> {
    await this.start();
    return this.request("addSheet", { docId, name });
  }

  async renameSheet(docId: number, oldName: string, newName: string): Promise<{ sheets: string[] }> {
    await this.start();
    return this.request("renameSheet", { docId, old: oldName, new: newName });
  }

  async deleteSheet(docId: number, name: string): Promise<{ sheets: string[] }> {
    await this.start();
    return this.request("deleteSheet", { docId, name });
  }

  async saveDoc(docId: number): Promise<void> {
    await this.start();
    await this.request("save", { docId });
  }

  async closeDoc(docId: number): Promise<void> {
    if (this.state !== "ready") return;
    try {
      await this.request("close", { docId });
    } catch {
      /* engine may be gone */
    }
  }

  async stop(): Promise<void> {
    this.setState("stopped");
    this.stopEnginePoll();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("supervisor stopped"));
    }
    this.pending.clear();

    const remaining = this.deregisterWindow();
    const lastWindow = remaining === null;

    // Close our connection to the shared bridge (owner also stops its bridge process).
    const writable = this.sock ?? this.bridgeProc?.stdin;
    if (writable) {
      try {
        writable.write(JSON.stringify({ id: this.nextId++, cmd: "shutdown", params: {} }) + "\n");
      } catch {
        /* ignore */
      }
    }
    if (this.sock) {
      try {
        this.sock.destroy();
      } catch {
        /* ignore */
      }
      this.sock = null;
    }

    if (lastWindow) {
      // Last window out: tear the shared engine down completely.
      await this.killProcs();
      if (this.engineInfo && pidAlive(this.engineInfo.pid)) killEngine(this.engineInfo.pid, "SIGTERM");
      removeEngineInfo();
      if (this.mode === "owner" && this.profileDir) {
        try {
          rmSync(this.profileDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        this.profileDir = null;
      }
    } else {
      // Other windows still use the shared engine and its bridge — leave both
      // running. (The owner's bridgeProc is only stopped in the lastWindow path.)
    }
    this.mode = null;
    this.engineInfo = null;
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("no port"));
      }
    });
  });
}
