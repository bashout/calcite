import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface EngineInfo {
  /** PID of the soffice wrapper owning the engine process group. */
  pid: number;
  unoPort: number;
  unoToken: string;
  bridgePort: number;
  bridgeToken: string;
  /** Bridge code version; mismatched engines are torn down and respawned. */
  bridgeVersion: string;
  /** window/plugin id -> last heartbeat (ms epoch) */
  windows: Record<string, number>;
}

/**
 * Per-user registry location. Linux follows XDG_STATE_HOME; macOS uses
 * ~/Library/Application Support; Windows uses %APPDATA%. CALCITE_STATE_DIR
 * overrides everything (used by tests).
 */
export function stateDir(): string {
  if (process.env.CALCITE_STATE_DIR) return process.env.CALCITE_STATE_DIR;
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "obsidian-calcite");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "obsidian-calcite");
  }
  return process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state", "obsidian-calcite");
}

export function engineFile(): string {
  return path.join(stateDir(), "engine.json");
}

export function readEngineInfo(): EngineInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(engineFile(), "utf8")) as EngineInfo;
    if (typeof info.unoPort !== "number" || typeof info.unoToken !== "string" || typeof info.pid !== "number"
      || typeof info.bridgePort !== "number" || typeof info.bridgeToken !== "string") return null;
    if (typeof info.bridgeVersion !== "string") info.bridgeVersion = "0-legacy"; // forces respawn
    return info;
  } catch {
    return null;
  }
}

export function writeEngineInfo(info: EngineInfo): void {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const f = engineFile();
  fs.writeFileSync(f, JSON.stringify(info), { mode: 0o600 });
  fs.chmodSync(f, 0o600); // re-apply even if the file pre-existed looser
}

export function removeEngineInfo(): void {
  try {
    fs.unlinkSync(engineFile());
  } catch {
    /* already gone */
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Drop heartbeat entries whose owning process is dead. */
export function pruneWindows(info: EngineInfo): EngineInfo {
  const windows: Record<string, number> = {};
  for (const [wid, ts] of Object.entries(info.windows)) {
    // window ids are "<pid>-<hex>"; liveness is judged by the pid part
    const pid = Number(wid.split("-")[0]);
    if (pidAlive(pid)) windows[wid] = ts;
  }
  return { ...info, windows };
}
