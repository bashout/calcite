import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EngineSupervisor } from "../src/engine/supervisor";
import { locatePythonUnoIn, macOsFrameworkPythonCandidates, macOsUnoResourcesDir } from "../src/engine/locator";

async function main() {
  // Isolate the shared-engine registry so tests never touch the user's engine.
  process.env.CALCITE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "calcite-state-"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "calcite-smoke-"));
  const csv = path.join(tmp, "sample.csv");
  fs.writeFileSync(csv, "name,price,qty,total\napple,1.5,4,=B2*C2\npear,2,3,=B3*C3\n");
  const ods = path.join(tmp, "sample.ods");
  execFileSync("soffice", ["--headless", "--convert-to", "ods", "--outdir", tmp, csv], { timeout: 60000 });
  if (!fs.existsSync(ods)) throw new Error("ods conversion failed");

  // --- macOS bundle layout: framework interpreter + Contents/Resources uno.py ---
  {
    const fakeContents = path.join(tmp, "FakeLibreOffice.app", "Contents");
    const resources = path.join(fakeContents, "Resources");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, "uno.py"), "# fake uno module\n");
    const mkPy = (ver: string) => {
      const binDir = path.join(fakeContents, "Frameworks", "LibreOfficePython.framework", "Versions", ver, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const shim = path.join(binDir, `python${ver}`);
      // Fake bundled interpreter: `-c 'import uno'` succeeds only when a dir
      // on PYTHONPATH contains uno.py (mirrors the Contents/Resources layout).
      fs.writeFileSync(
        shim,
        [
          "#!/bin/sh",
          'if [ "$1" = "-c" ] && [ "$2" = "import uno" ]; then',
          '  oldIFS="$IFS"; IFS=":"',
          "  for d in $PYTHONPATH; do",
          '    [ -n "$d" ] && [ -f "$d/uno.py" ] && exit 0',
          "  done",
          "  exit 1",
          "fi",
          "exit 0",
          "",
        ].join("\n")
      );
      fs.chmodSync(shim, 0o755);
    };
    mkPy("3.10");
    mkPy("3.11");
    fs.symlinkSync("3.11", path.join(fakeContents, "Frameworks", "LibreOfficePython.framework", "Versions", "Current"));

    const cands = macOsFrameworkPythonCandidates(fakeContents);
    // "Current" symlink first, then numeric versions newest-first.
    if (cands.length !== 3) throw new Error(`expected 3 framework candidates, got ${cands.length}: ${cands}`);
    if (!cands[0].includes(path.join("Current", "bin", "python3.11"))) throw new Error(`Current not first: ${cands[0]}`);
    if (!cands[1].includes(path.join("3.11", "bin", "python3.11"))) throw new Error(`newest version not second: ${cands[1]}`);
    if (!cands[2].includes(path.join("3.10", "bin", "python3.10"))) throw new Error(`oldest version not last: ${cands[2]}`);

    const resourcesDir = macOsUnoResourcesDir(fakeContents);
    if (!resourcesDir.endsWith(path.join("Contents", "Resources"))) throw new Error(`resources dir wrong: ${resourcesDir}`);
    // Probing with Contents/Resources on PYTHONPATH must find the interpreter...
    const found = locatePythonUnoIn(cands.map((bin) => ({ bin, env: { ...process.env, PYTHONPATH: resourcesDir } })));
    if (!found || !found.includes("python3.11")) throw new Error(`framework python not found with Resources PYTHONPATH: ${found}`);
    // ...and without it the import must fail (uno.py is not next to the binary).
    const notFound = locatePythonUnoIn(cands.map((bin) => ({ bin })));
    if (notFound) throw new Error(`probe succeeded without Contents/Resources on PYTHONPATH: ${notFound}`);
    console.log("MACOS-LOCATOR PASS");
  }

  const sup = new EngineSupervisor(tmp, path.resolve(__dirname, ".."));
  sup.on("state", (s, err) => console.log(`[state] ${s} ${err}`));

  const version = await sup.ping().catch(() => null);
  console.log("ping before start (expected fail):", version);

  const loaded = await sup.loadFile(ods);
  console.log("loaded:", JSON.stringify(loaded));
  if (!loaded.sheets.includes("sample")) throw new Error("sheet missing");

  const grid = await sup.dumpSheet(loaded.docId, loaded.sheets[0]);
  console.log("range:", JSON.stringify(grid.range));
  for (const row of grid.rows) console.log(row.map((c) => c.s + (c.f ? ` [${c.f}]` : "")).join(" | "));

  // assertions
  if (grid.rows[0][0].s !== "name") throw new Error("header mismatch");
  if (parseFloat(grid.rows[1][3].s) !== 6) throw new Error(`formula recalc wrong: got ${grid.rows[1][3].s}`);
  if (grid.rows[1][3].f !== "=B2*C2") throw new Error(`formula missing: ${grid.rows[1][3].f}`);

  // path validation (client-side and engine-side)
  let rejected = false;
  try {
    sup.assertInVault("/etc/passwd");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("path validation failed");
  let engineRejected = false;
  try {
    await sup.request("load", { path: "/etc/passwd", root: tmp });
  } catch {
    engineRejected = true;
  }
  if (!engineRejected) throw new Error("engine accepted path outside registered roots");

  // dump by explicit sheet name
  const byName = await sup.dumpSheet(loaded.docId, "sample");
  if (byName.rows[0][0].s !== "name") throw new Error("named-sheet dump wrong");

  // token enforcement: connecting without the token must be refused
  const cs = sup.connectStringForTest();
  if (!cs || !cs.includes("token=")) throw new Error("no token in connect string");
  const noToken = cs.replace(/,token=[0-9a-f]+/, "");
  let tokenEnforced = false;
  try {
    execFileSync(
      "python3",
      ["-c", `import uno; from com.sun.star.bridge import UnoUrlResolver as R; l = uno.getComponentContext(); r = l.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", l); r.resolve("uno:${noToken}")`],
      { timeout: 20000, stdio: "pipe" }
    );
  } catch {
    tokenEnforced = true;
  }
  if (!tokenEnforced) throw new Error("UNO socket accepted a tokenless connection");

  // multiplex: second doc in same engine
  const loaded2 = await sup.loadFile(ods);
  const grid2 = await sup.dumpSheet(loaded2.docId, loaded2.sheets[0]);
  if (grid2.rows.length !== 3) throw new Error("second doc dump wrong");

  // editing round-trip: E2 (col 4, row 1) = B2*C2*2 = 1.5*4*2 = 12
  await sup.setCell(loaded.docId, loaded.sheets[0], 4, 1, "=B2*C2*2");
  const edited = await sup.dumpSheet(loaded.docId, loaded.sheets[0]);
  const e2 = edited.rows[1][4];
  console.log("E2 after setCell:", JSON.stringify(e2));
  if (parseFloat(e2.s) !== 12) throw new Error(`setCell value wrong: got ${e2.s}`);
  if (e2.f !== "=B2*C2*2") throw new Error(`setCell formula missing: ${e2.f}`);

  // save, close, reload: the edit must persist on disk
  await sup.saveDoc(loaded.docId);
  await sup.closeDoc(loaded.docId);
  const reloaded = await sup.loadFile(ods);
  const persisted = await sup.dumpSheet(reloaded.docId, reloaded.sheets[0]);
  const e2r = persisted.rows[1][4];
  console.log("E2 after reload:", JSON.stringify(e2r));
  if (parseFloat(e2r.s) !== 12) throw new Error(`persisted value wrong: got ${e2r.s}`);
  if (e2r.f !== "=B2*C2*2") throw new Error(`persisted formula missing: ${e2r.f}`);

  // structural round-trip on the first sup before it stops (cleanup in finally)
  try {
    const before = await sup.dumpSheet(loaded.docId, "sample");

    const added = await sup.addSheet(loaded.docId, "Notes");
    if (!added.sheets.includes("Notes")) throw new Error(`addSheet did not add Notes: ${added.sheets}`);

    await sup.insertRows(loaded.docId, "sample", 0, 1);
    const afterRows = await sup.dumpSheet(loaded.docId, "sample");
    // Inserting at the top edge pushes content down: the used range's endRow
    // grows by 1 (the blank inserted row sits outside the used-area bbox).
    console.log(`range after insertRows: ${JSON.stringify(before.range)} -> ${JSON.stringify(afterRows.range)}`);
    if (!before.range || !afterRows.range || afterRows.range.endRow !== before.range.endRow + 1) {
      throw new Error(`insertRows did not grow the used range: ${JSON.stringify(before.range)} -> ${JSON.stringify(afterRows.range)}`);
    }
    // window now starts at A1, so the inserted blank row sits at index 0
    if (afterRows.rows[1]?.[0]?.s !== "name") throw new Error("insertRows lost the header row");

    await sup.insertCols(loaded.docId, "sample", 0, 1);
    const afterCols = await sup.dumpSheet(loaded.docId, "sample");
    console.log(`range after insertCols: ${JSON.stringify(afterRows.range)} -> ${JSON.stringify(afterCols.range)}`);
    if (!afterCols.range || afterCols.range.endCol !== afterRows.range!.endCol + 1) {
      throw new Error(`insertCols did not grow the used range: ${JSON.stringify(afterRows.range)} -> ${JSON.stringify(afterCols.range)}`);
    }
    if (afterCols.rows[1]?.[1]?.s !== "name") throw new Error("insertCols lost the header cell"); // row 0 is the blank from insertRows, col 0 the blank from insertCols

    const removed = await sup.deleteSheet(loaded.docId, "Notes");
    if (removed.sheets.includes("Notes")) throw new Error(`deleteSheet did not remove Notes: ${removed.sheets}`);

    // delete rows/cols via the dispatcher path (removeCells is not exposed)
    await sup.deleteCols(loaded.docId, "sample", 0, 1);
    const afterDelCols = await sup.dumpSheet(loaded.docId, "sample");
    if (afterDelCols.range!.endCol !== afterCols.range!.endCol - 1) {
      throw new Error(`deleteCols did not shrink the used range: ${JSON.stringify(afterDelCols.range)}`);
    }
    await sup.deleteRows(loaded.docId, "sample", 0, 1);
    const afterDelRows = await sup.dumpSheet(loaded.docId, "sample");
    if (afterDelRows.range!.endRow !== afterRows.range!.endRow - 1) {
      throw new Error(`deleteRows did not shrink the used range: ${JSON.stringify(afterDelRows.range)}`);
    }
    if (afterDelRows.rows[0]?.[0]?.s !== "name") throw new Error("deleteRows lost the header row"); // delete at row 0 removes the blank, header back at row 0
    console.log("STRUCTURAL PASS");
  } finally {
    await sup.closeDoc(reloaded.docId);
    await sup.closeDoc(loaded.docId);
    await sup.closeDoc(loaded2.docId);
    await sup.stop();
  }

  // --- multi-window: shared engine, attach mode, refcounted docs ---
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "calcite-state-"));
  process.env.CALCITE_STATE_DIR = stateDir;
  const supA = new EngineSupervisor(tmp, path.resolve(__dirname, ".."));
  const a = await supA.loadFile(ods);
  if (supA.mode !== "owner") throw new Error(`A should own engine, got ${supA.mode}`);
  const supB = new EngineSupervisor(tmp, path.resolve(__dirname, ".."));
  const b = await supB.loadFile(ods);
  if (supB.mode !== "attached") throw new Error(`B should attach, got ${supB.mode}`);
  if (b.docId !== a.docId) throw new Error("same file should share docId across windows");
  await supB.closeDoc(b.docId); // refcounted: doc stays open for A
  const gA = await supA.dumpSheet(a.docId, a.sheets[0]);
  if (gA.rows.length === 0) throw new Error("doc wrongly closed while another window uses it");
  await supA.stop(); // engine must survive: B still attached
  await supB.ping();
  await supB.stop(); // last window: engine shuts down, registry removed
  if (fs.existsSync(path.join(stateDir, "engine.json"))) throw new Error("registry not removed after last window");
  console.log("MULTI-WINDOW PASS");

  // --- engine crash recovery: SIGKILL the engine, supervisor must respawn ---
  const supC = new EngineSupervisor(tmp, path.resolve(__dirname, ".."));
  await supC.loadFile(ods);
  const info = JSON.parse(fs.readFileSync(path.join(stateDir, "engine.json"), "utf8"));
  process.kill(info.pid, "SIGKILL"); // simulate external kill of soffice
  const deadline = Date.now() + 30000;
  while (supC.state !== "ready" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  if (supC.state !== "ready") throw new Error(`engine did not recover after kill (state=${supC.state})`);
  await supC.ping();
  // docIds are invalidated by the respawn; retry load+dump in case a restart
  // lands between the two calls.
  let g2 = null as any;
  for (let i = 0; i < 3 && !g2; i++) {
    try {
      const l = await supC.loadFile(ods);
      g2 = await supC.dumpSheet(l.docId, "sample");
    } catch {
      /* engine may have respawned again mid-pair */
    }
  }
  if (!g2 || g2.rows.length === 0) throw new Error("dump after recovery empty");
  await supC.stop();
  console.log("RECOVERY PASS");
  console.log("SMOKE TEST PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("SMOKE TEST FAIL:", e);
  process.exit(1);
});
