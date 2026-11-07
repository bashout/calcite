# Calcite

An [Obsidian](https://obsidian.md) plugin that renders **and edits** Calc
spreadsheets (`.ods`, `.xlsx`) directly inside your notes, backed by the real
LibreOffice Calc engine — not a re-implementation. Formulas recalculate, cells
are editable, and structural changes (rows, columns, sheets) persist to the
file on disk.

## Features

- **Embed spreadsheets in notes** with the standard wiki-link syntax:
  `![[file.ods]]` (also works with `.xlsx`).
- **Sheet selection** via subpath: `![[file.ods#SheetName]]`.
- **Live HTML grid** rendered from engine-computed values — Obsidian-themed,
  selectable, keyboard-navigable (arrows to move, `Enter`/`F2` to edit,
  double-click a cell to edit inline).
- **Formula bar** showing and editing the underlying formula/value of the
  selected cell.
- **Structural editing**: insert/delete rows and columns (context menus on
  row/column headers), add sheets (`+` tab), rename/delete sheets
  (right-click a tab).
- **Toolbar buttons**: **Reload** (re-reads the file from disk, e.g. after an
  external edit) and **Open in LibreOffice**.
- **Automatic recalculation** — the engine recomputes dependent cells after
  every edit.
- **One shared engine**: a single headless LibreOffice process serves all
  Obsidian windows and vaults on your machine; the last window out shuts it
  down, and a dead engine is detected via heartbeat and respawned
  automatically.

## Requirements

- **Obsidian desktop** (the plugin is desktop-only; it needs Node.js process
  APIs that Obsidian mobile does not provide). Minimum Obsidian version:
  **1.5.0**.
- **LibreOffice installed** on your system (any recent version). The plugin
  locates `soffice` automatically; if it is missing, embeds show an inline
  message instead of a grid.

The python-uno bridge into the engine is resolved per platform — no manual
step is needed:

| Platform | soffice | python-uno bridge |
| --- | --- | --- |
| Linux | system LibreOffice (`soffice` on PATH or `/usr/lib/libreoffice`) | `python3-uno` package (Debian/Ubuntu) or LibreOffice's bundled `program/python` |
| macOS | `LibreOffice.app` in `/Applications` (or Homebrew) | LibreOffice's bundled `LibreOfficePython.framework` interpreter — started **inside** the soffice process automatically (required on macOS 26+, where direct spawns of the bundled interpreter are killed by the OS) |
| Windows | LibreOffice installed | bundled `program\python.exe` |

No network access is required at runtime.

## Installation

### From Community Plugins (recommended)

1. Open **Settings → Community plugins → Browse**.
2. Search for **Calcite** and click **Install**, then **Enable**.
3. Make sure LibreOffice is installed (see Requirements).

### Manual install

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`) from
   the [Releases](https://github.com/bashout/calcite/releases) page.
2. Copy them into `<your-vault>/.obsidian/plugins/calcite/`.
3. Reload Obsidian (**Settings → Community plugins → Reload**) and enable
   **Calcite**.

## Usage

Embed any spreadsheet stored in your vault:

```markdown
![[budget.ods]]
![[data.xlsx#Q3 Summary]]
```

The optional `#SheetName` subpath picks the sheet to display; omit it for the
first sheet. Switch sheets at any time using the tabs above the grid.

### Editing

- Click a cell to select it; the formula bar shows its content (`=B2*C2` for
  formulas, the literal value otherwise).
- Press `Enter`/`F2` or double-click to edit — inline in the cell, or in the
  formula bar — then `Enter` to commit. Edits are written through the engine
  (`setFormula`/`setValue`) and saved to the file (debounced).
- Error cells are labelled non-destructively and highlighted.

### Structural edits

- Right-click a **row or column header** to insert or delete rows/columns.
- Click the **`+` tab** to add a sheet; right-click a **tab** to rename or
  delete that sheet.

### Buttons

- **Reload** — re-reads the file from disk (useful after editing it in an
  external app; external modifications are also detected automatically).
- **Open in LibreOffice** — opens the file in the full desktop app.

## Architecture

LibreOffice's Calc engine cannot run inside Obsidian's renderer process, so it
runs **out of process** and the plugin talks to it over IPC:

```
renderer (Chromium)            main process (Node)          engine
┌──────────────────┐  JSON     ┌────────────────────┐  stdio ┌──────────────────┐
│ HTML grid table  │ ◄───────► │ bridge supervisor  │ ◄────► │ python-uno bridge│
│ built from cell  │           │ spawn/health-check │        │  ▲ UNO socket    │
│ values           │           │                    │ ────── │  ▼ soffice headless│
└──────────────────┘           └────────────────────┘ token  └──────────────────┘
```

- **Rendering:** a custom HTML grid in the note. The engine never renders; it
  is a pure calc backend.
- **Bridge:** `python-uno` (ships with LibreOffice, no compilation). One shared
  headless `soffice` + bridge per user, listening on a
  **token-authenticated localhost socket** (JSON-lines RPC). Later windows and
  vaults attach to the shared engine instead of spawning their own; documents
  are deduplicated by absolute path and refcounted across windows.
  On Linux/Windows the bridge is a separate python process spawned by the
  plugin; on **macOS** the bridge runs *inside* the soffice process (started
  as a LibreOffice user script), because macOS 26+ kills direct spawns of the
  bundled interpreter — the socket transport is identical either way.
- **Process registry:** `~/.local/state/obsidian-calcite/engine.json`
  (mode 0600) tracks the engine pid, port, token, and a heartbeated window
  list; the last window out shuts the engine down and orphaned engines are
  reaped.

See [docs/architecture.md](docs/architecture.md) for the full design rationale
and decision log.

## Security

- The UNO socket binds to **127.0.0.1 only** and every connection must present
  a random 24-byte token (enforced by the engine; covered by a negative test
  in the smoke suite).
- Document paths requested by a window are **validated against that window's
  vault root** — both client-side and engine-side — so an embed cannot read or
  write files outside the vault.
- The plugin never sends data over the network.

## Development

```sh
npm install
npm run dev      # watch build (inline sourcemap)
npm run build    # typecheck (tsc --noEmit) + production bundle to main.js
```

### Smoke test

The smoke test (`test/smoke.ts`) exercises the real engine end-to-end: it
converts a CSV to `.ods` with headless `soffice`, loads it through the
supervisor, checks recalculation, path validation, token enforcement, an
edit → save → reload persistence round-trip, and structural edits. It needs
`soffice` and `python3-uno` on the machine:

```sh
npx esbuild test/smoke.ts --bundle --platform=node --format=cjs --outfile=test/smoke.cjs
node test/smoke.cjs
```

`test/make-demo.py` generates a demo spreadsheet for manual testing.

## Roadmap & limitations

Done so far: engine detection/spawn, read-only grid embed, cell + formula-bar
editing with debounced save, structural edits (rows/columns/sheets), engine
respawn on failure, external-change reload.

Known limitations:

- Formula entry uses the document locale's argument separator (`;` under
  `en_GB`, `,` under `en-US`).
- Grids are capped at 500 rows × 100 columns per dump.
- No undo/redo, no multi-cell ranges, no formatting — the embed is a data
  grid, not a full Calc UI.

## License

[MIT](LICENSE)
