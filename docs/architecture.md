# Architecture & decision log

This document holds the deep design rationale behind Calcite. For day-to-day
usage see the [README](../README.md).

## Why an out-of-process engine

LibreOffice's Calc engine (`sc/` in [libreoffice/core](https://github.com/LibreOffice/core))
cannot run inside Obsidian's renderer. The engine runs **out of process**; the
plugin talks to it over IPC. Two embedding surfaces exist upstream:

- **LibreOfficeKit (LOK)** — the C API in `include/LibreOfficeKit/LibreOfficeKit.h`
  (`paintTile`, `postKeyEvent`, `saveAs`, ...). Tile rendering + input injection.
  Used by Collabora Online, but there LO runs server-side and the browser just
  paints tiles. In-process use inside Electron is not viable (LO needs its own
  VCL event loop on the main thread, which Electron owns).
- **UNO** — the component API reachable from Python (`python-uno`, ships with
  LibreOffice). Load/save documents, read/write cells, recalculate. No rendering.

## Chosen design

```
renderer (Chromium)                main process (Node)              engine
┌──────────────────┐  JSON/stdin   ┌────────────────────┐  stdio   ┌────────────────────┐
│ HTML grid table  │ ◄───────────► │ bridge supervisor  │ ◄──────► │ python-uno bridge  │
│ built from cell  │   JSON/stdout │ spawn/health-check │  JSON    │  ▲ UNO socket      │
│ values           │               │                    │ ──────── │  ▼ soffice headless│
└──────────────────┘               └────────────────────┘  token   └────────────────────┘
```

- **Rendering:** custom HTML grid in the note (Obsidian-themed, selectable,
  accessible). The engine never renders; it is a pure calc backend.
- **Bridge:** `python-uno` (no compilation, ships with LibreOffice). One shared
  engine per user: the first Obsidian window spawns a headless `soffice` plus a
  bridge process that listens on a token-authenticated localhost socket
  (JSON-lines RPC); later windows/vaults attach to it instead of spawning
  their own engine. The registry (`~/.local/state/obsidian-calcite/engine.json`,
  mode 0600) tracks the engine pid, ports, tokens, and a heartbeated window list;
  the last window out shuts the engine down. Documents are deduplicated by
  absolute path and refcounted across windows, so two windows embedding the same
  file share one document in the engine. Document paths are validated against
  the calling window's vault root.
- **Dependency:** system LibreOffice, detected and version-checked; missing LO
  degrades to an inline message. Desktop-only.

## DECISIONS

1. Rendering model: HTML grid (DOM), not LOK tile/canvas.
2. Bridge: python-uno over stdio JSON-RPC; UNO socket to soffice with token.
3. Transport: stdio between Node and bridge; localhost UNO socket inside.
4. Process model: ONE shared headless soffice + bridge per user, multiplexed
   across all Obsidian windows/vaults (attach-or-start via a per-user registry
   with heartbeats; last window out shuts down; orphans reaped by PPID==1).
5. Save policy: engine-authoritative debounced save (`store()` after edits);
   read-only mode no longer applies since editing shipped.
6. Dependency: system LibreOffice required, graceful fallback.
7. Embed surface: `![[file.ods]]` post-processor with optional `#SheetName`
   subpath for sheet selection; option codeblocks later.
8. Input: cell + formula-bar editing via UNO `setFormula`/`setValue`, keyboard
   nav (arrows/Enter/F2), inline cell editor, non-destructive error label,
   error-cell highlighting; structural edits via row/column-header context
   menus and sheet tabs.
9. Security: random-token-authenticated localhost UNO socket (verified by a
   negative test), vault path validation on both sides of the bridge.
10. Failure: respawn with backoff, status banner in embed; dead engines are
    detected via heartbeat and killed/respawned instead of hanging; after a
    respawn all open docs are reloaded automatically.
11. macOS process model: on macOS the bridge never runs as a direct child of
    Node. TDF's signed builds (LO 25.2+) embed parent-launch constraints in
    the macOS signature, and macOS 26+ SIGKILLs any spawn of the bundled
    `LibreOfficePython.framework` interpreter that is not inside the
    LibreOffice process tree. So on macOS the supervisor copies `bridge.py`
    into the engine profile's `user/scripts/python/` and starts it via
    `soffice ... "vnd.sun.star.script:calcite_bridge.py$main?language=Python&location=user"`;
    the in-tree bridge uses the in-process UNO context (no `CALCITE_UNO_CONNECT`)
    and serves the same token-authenticated localhost socket. On Linux/Windows
    the bridge remains a directly spawned python process (`python3-uno` /
    bundled `python.exe`). Locator: LO 25.x macOS bundles keep the interpreter
    at `Contents/Frameworks/LibreOfficePython.framework/Versions/<ver>/bin/python3.x`
    (`Contents/MacOS/python` is gone) and `uno.py` in `Contents/Resources`, so
    the framework interpreter is probed with `PYTHONPATH=<bundle>/Contents/Resources`.
12. Packaging: `bridge.py` is embedded into `main.js` at build time (esbuild
    `".py": "text"` loader) and extracted at runtime to `<state dir>/bridge.py`
    (atomic rewrite when the embedded source changes). Releases therefore ship
    only `main.js`, `manifest.json`, `styles.css` — GitHub release assets cannot
    contain path separators, so a separate `bridge/bridge.py` asset would land
    in the wrong place and break installs; embedding also guarantees the
    extracted script always matches the shipped `main.js`.

## Render pipeline notes

- The render window always starts at A1 (not the used range's start), and grows
  by one on edge inserts so blank inserted rows/columns stay visible even on
  empty sheets.
- Grids are capped at 500 rows × 100 columns per dump.
- While the engine is reconnecting/respawning, editing is locked and the embed
  shows an "engine reconnecting…" state; a **Reload** button re-reads the file
  from disk.
