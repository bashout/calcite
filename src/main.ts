import { spawn } from "child_process";
import * as path from "path";
import { App, MarkdownRenderChild, Notice, Plugin, TFile } from "obsidian";
import { EngineSupervisor } from "./engine/supervisor";
import { renderGrid, renderStatus } from "./view/grid";
import { confirmDialog, promptText } from "./view/prompt";

const SPREADSHEET_EXTENSIONS = ["ods", "xlsx", "xls", "csv", "fods"];
const SAVE_DEBOUNCE_MS = 1000;
const OWN_SAVE_GRACE_MS = 3000;

interface LoadedDoc {
  docId: number;
  sheets: string[];
  readOnly: boolean;
}

export default class CalcitePlugin extends Plugin {
  private supervisor!: EngineSupervisor;
  private docs = new Map<string, LoadedDoc>();
  private embeds = new Map<string, Set<CalciteEmbed>>();
  private lastOwnSave = new Map<string, number>();

  async onload() {
    const vaultRoot = (this.app.vault.adapter as any).getBasePath();
    // manifest.dir is vault-relative; anchor it to the vault root.
    this.supervisor = new EngineSupervisor(vaultRoot);
    let wasReady = false;
    this.supervisor.on("state", (s, err) => {
      console.log(`[calcite] engine ${s} ${err}`);
      // Propagate engine state to every embed so edits lock during respawns.
      for (const set of this.embeds.values()) {
        for (const embed of set) {
          embed.engineBusy = s !== "ready";
          embed.render().catch(() => {});
        }
      }
      // After a respawn the engine's docIds are gone; reload all open docs.
      if (s === "ready" && wasReady) {
        void (async () => {
          for (const p of [...this.docs.keys()]) {
            try {
              await this.reloadDoc(p);
            } catch (e) {
              console.error(`[calcite] reload after restart failed for ${p}`, e);
            }
          }
        })();
      }
      wasReady = s === "ready";
    });

    this.registerMarkdownPostProcessor((el, ctx) => {
      const embeds = el.querySelectorAll("span.internal-embed, a.internal-link");
      for (const link of Array.from(embeds)) {
        const href = link.getAttribute("src") ?? link.getAttribute("href") ?? "";
        const [pathPart, subpath] = href.split("#");
        const ext = pathPart.split("|")[0].split(".").pop()?.toLowerCase();
        if (!ext || !SPREADSHEET_EXTENSIONS.includes(ext)) continue;

        const file = this.app.metadataCache.getFirstLinkpathDest(pathPart.split("|")[0], ctx.sourcePath);
        if (!(file instanceof TFile)) continue;

        const sheet = subpath ? decodeURIComponent(subpath) : undefined;
        const container = el.createDiv({ cls: "calcite-embed" });
        link.replaceWith(container);
        const embed = new CalciteEmbed(container, this.supervisor, this.app.vault.adapter as any, file, this, this.app, sheet);
        ctx.addChild(embed);
        let set = this.embeds.get(file.path);
        if (!set) this.embeds.set(file.path, (set = new Set()));
        set.add(embed);
      }
    });

    // External modification of an embedded spreadsheet: reload it in the engine.
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (!(f instanceof TFile)) return;
        if (!this.docs.has(f.path)) return;
        const last = this.lastOwnSave.get(f.path) ?? 0;
        if (Date.now() - last < OWN_SAVE_GRACE_MS) return; // our own save
        void this.reloadDoc(f.path);
      })
    );
  }

  async reloadDoc(vaultPath: string, retryIfReadOnly = true) {
    const old = this.docs.get(vaultPath);
    const embeds = [...(this.embeds.get(vaultPath) ?? [])];
    // Let pending saves finish (or cancel them) before closing the doc,
    // otherwise store() races doc.close() -> SfxBaseModel Io Abort.
    for (const embed of embeds) embed.cancelPendingSave();
    await Promise.all(embeds.map((e) => e.waitForSave()));
    if (old) {
      await this.supervisor.closeDoc(old.docId);
      this.docs.delete(vaultPath);
    }
    const loaded = await this.supervisor.loadFile(vaultPath);
    this.docs.set(vaultPath, { docId: loaded.docId, sheets: loaded.sheets, readOnly: loaded.readOnly ?? false });
    // A read-only load usually means a foreign (possibly dying) soffice held
    // the lock; retry once so the embed recovers to read-write on its own.
    if ((loaded.readOnly ?? false) && retryIfReadOnly) {
      setTimeout(() => {
        void this.reloadDoc(vaultPath, false).catch((e) => console.error("[calcite] read-only retry failed", e));
      }, 5000);
    }
    for (const embed of embeds) {
      embed.doc = this.docs.get(vaultPath);
      await embed.refresh();
    }
  }

  markOwnSave(vaultPath: string) {
    this.lastOwnSave.set(vaultPath, Date.now());
  }

  /** Re-render every embed of a file except the given one. */
  refreshEmbeds(vaultPath: string, except?: CalciteEmbed) {
    for (const embed of this.embeds.get(vaultPath) ?? []) {
      if (embed !== except) embed.refresh().catch((e) => console.error("[calcite] refresh failed", e));
    }
  }

  getDoc(vaultPath: string): LoadedDoc | undefined {
    return this.docs.get(vaultPath);
  }

  setDoc(vaultPath: string, doc: LoadedDoc) {
    this.docs.set(vaultPath, doc);
  }

  async onunload() {
    for (const doc of this.docs.values()) await this.supervisor.closeDoc(doc.docId);
    await this.supervisor.stop();
  }
}

class CalciteEmbed extends MarkdownRenderChild {
  doc?: LoadedDoc;
  private sheet?: string;
  private dirty = false;
  private error: string | null = null;
  private selected: { col: number; row: number } | null = null;
  engineBusy = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private inflightSave: Promise<void> | null = null;

  constructor(
    containerEl: HTMLElement,
    private supervisor: EngineSupervisor,
    private adapter: any,
    private file: TFile,
    private plugin: CalcitePlugin,
    private app: App,
    sheetName?: string
  ) {
    super(containerEl);
    this.sheet = sheetName;
  }

  async onload() {
    renderStatus(this.containerEl, "loading", `Loading ${this.file.name}…`);
    try {
      this.doc = this.plugin.getDoc(this.file.path);
      if (!this.doc) {
        const loaded = await this.supervisor.loadFile(this.file.path);
        this.doc = { docId: loaded.docId, sheets: loaded.sheets, readOnly: loaded.readOnly ?? false };
        this.plugin.setDoc(this.file.path, this.doc);
      }
      // The engine is the source of truth for the sheet list — another window
      // may have added/renamed/deleted sheets since this doc was cached.
      this.doc.sheets = await this.supervisor.listSheets(this.doc.docId);
      if (!this.sheet || !this.doc.sheets.includes(this.sheet)) {
        this.sheet = this.doc.sheets[0];
      }
      await this.render();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      renderStatus(this.containerEl, "error", `Calcite: ${msg.split("\n")[0]}`);
    }
  }

  async refresh() {
    if (this.doc) {
      // Re-validate against the engine: the sheet list may have changed
      // (e.g. deleted from another window).
      try {
        this.doc.sheets = await this.supervisor.listSheets(this.doc.docId);
      } catch {
        /* engine busy; keep cached list */
      }
      if (!this.sheet || !this.doc.sheets.includes(this.sheet)) {
        this.sheet = this.doc.sheets[0];
      }
    }
    await this.render();
  }

  private lastRange: { startCol: number; startRow: number; endCol: number; endRow: number } | null = null;
  private pendingWindow: { startCol: number; startRow: number; endCol: number; endRow: number } | null = null;

  async render() {
    if (!this.doc || !this.sheet) return;
    // The pending window (set by structural edits) must reach every concurrent
    // render, otherwise a save-triggered render can win and hide the change.
    const win = this.pendingWindow;
    const grid = await this.supervisor.dumpSheet(this.doc.docId, this.sheet, 500, 100, win ?? undefined);
    if (grid.range) {
      this.lastRange = grid.range;
      // keep the pending window until a render actually covers it (a
      // save-triggered render may have raced us and lost)
      if (win && grid.range.startCol <= win.startCol && grid.range.startRow <= win.startRow
        && grid.range.endCol >= win.endCol && grid.range.endRow >= win.endRow) {
        this.pendingWindow = null;
      }
    }
    console.log(`[calcite] render ${this.file.name}#${this.sheet}: ${grid.rows.length}x${grid.rows[0]?.length ?? 0}`);
    renderGrid(this.containerEl, grid, {
      sheets: this.doc.sheets,
      activeSheet: this.sheet,
      dirty: this.dirty,
      error: this.error,
      selected: this.selected,
      readOnly: this.doc.readOnly,
      engineBusy: this.engineBusy || this.supervisor.state !== "ready",
      callbacks: {
        onSheetChange: (s) => {
          this.sheet = s;
          this.selected = null;
          this.render().catch((e) => console.error("[calcite] sheet switch failed", e));
        },
        onReload: () => {
          this.plugin.reloadDoc(this.file.path).catch((e) => console.error("[calcite] reload failed", e));
        },
        onOpenExternal: () => this.openExternal(),
        onCellEdit: (col, row, text) => {
          this.selected = { col, row };
          this.editCell(col, row, text).catch((e) => console.error("[calcite] edit failed", e));
        },
        onInsertRow: (row) => this.structure((s) => s.insertRows(this.doc!.docId, this.sheet!, row, 1), "insert row", { row }),
        onDeleteRow: (row) => this.structure((s) => s.deleteRows(this.doc!.docId, this.sheet!, row, 1), "delete row"),
        onInsertCol: (col) => this.structure((s) => s.insertCols(this.doc!.docId, this.sheet!, col, 1), "insert column", { col }),
        onDeleteCol: (col) => this.structure((s) => s.deleteCols(this.doc!.docId, this.sheet!, col, 1), "delete column"),
        // NOTE: the pending window makes inserted blank rows/cols visible even
        // at the edge of (or beyond) the used range, e.g. on empty sheets.
        // NOTE: ensure window makes the inserted blank row/col visible even at
        // the edge of (or beyond) the used range, e.g. on an empty sheet.
        onAddSheet: () => this.addSheet(),
        onRenameSheet: (name) => this.renameSheet(name),
        onDeleteSheet: (name) => this.deleteSheet(name),
      },
    });
  }

  private async editCell(col: number, row: number, text: string) {
    if (!this.doc || !this.sheet) return;
    try {
      await this.supervisor.setCell(this.doc.docId, this.sheet, col, row, text);
      this.error = null;
    } catch (e) {
      this.error = `edit failed: ${String(e).split("\n")[0]}`;
      console.error("[calcite] edit failed", e);
    }
    this.scheduleSave();
    await this.render();
  }

  cancelPendingSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  waitForSave(): Promise<void> {
    return this.inflightSave ?? Promise.resolve();
  }

  private scheduleSave() {
    if (!this.doc) return;
    if (this.doc.readOnly) {
      this.error = "file is read-only (locked by another LibreOffice instance?)";
      this.render().catch(() => {});
      return;
    }
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.doc) return;
      this.plugin.markOwnSave(this.file.path);
      this.inflightSave = this.supervisor
        .saveDoc(this.doc.docId)
        .then(() => {
          this.dirty = false;
          this.render().catch(() => {});
        })
        .catch((e) => {
          this.dirty = false;
          this.error = `save failed: ${String(e).split("\n")[0]}`;
          console.error("[calcite] save failed", e);
          this.render().catch(() => {});
        })
        .finally(() => {
          this.inflightSave = null;
        });
    }, SAVE_DEBOUNCE_MS);
    this.render().catch(() => {});
  }

  /** Run a structural engine command, then refresh + save. */
  private async structure(op: (s: EngineSupervisor) => Promise<{ sheets: string[] } | void>, label: string, insertAt?: { row?: number; col?: number }) {
    if (!this.doc || !this.sheet) return;
    // After an insert, render the union of the current window and the inserted
    // index, grown by one in the insert direction, so the blank row/col is
    // always visible (even at edges or on empty sheets).
    if (insertAt && this.lastRange) {
      const r = this.lastRange;
      this.pendingWindow = insertAt.col !== undefined
        ? { startCol: Math.min(r.startCol, insertAt.col), startRow: r.startRow, endCol: Math.max(r.endCol, insertAt.col + 1), endRow: r.endRow }
        : { startCol: r.startCol, startRow: Math.min(r.startRow, insertAt.row!), endCol: r.endCol, endRow: Math.max(r.endRow, insertAt.row! + 1) };
    }
    try {
      const r = await op(this.supervisor);
      if (r && "sheets" in r) this.doc.sheets = r.sheets;
      this.error = null;
      console.log(`[calcite] ${label} ok`);
    } catch (e) {
      this.error = `${label} failed: ${String(e).split("\n")[0]}`;
      console.error(`[calcite] ${label} failed`, e);
      new Notice(`Calcite: ${this.error}`);
    }
    this.scheduleSave();
    await this.render();
    // Other embeds of the same file share the doc — refresh them too.
    this.plugin.refreshEmbeds(this.file.path, this);
  }

  private async addSheet() {
    if (!this.doc) return;
    const name = await promptText(this.app, "New sheet", `Sheet${this.doc.sheets.length + 1}`);
    if (!name) return;
    await this.structure(async (s) => {
      const r = await s.addSheet(this.doc!.docId, name);
      this.sheet = name;
      return r;
    }, "add sheet");
  }

  private async renameSheet(oldName: string) {
    if (!this.doc) return;
    const name = await promptText(this.app, `Rename sheet "${oldName}"`, oldName);
    if (!name || name === oldName) return;
    await this.structure(async (s) => {
      const r = await s.renameSheet(this.doc!.docId, oldName, name);
      if (this.sheet === oldName) this.sheet = name;
      return r;
    }, "rename sheet");
  }

  private async deleteSheet(name: string) {
    if (!this.doc) return;
    if (!(await confirmDialog(this.app, `Delete sheet "${name}"?`, "This cannot be undone."))) return;
    await this.structure(async (s) => {
      const r = await s.deleteSheet(this.doc!.docId, name);
      if (this.sheet === name) this.sheet = r.sheets[0];
      return r;
    }, "delete sheet");
    new Notice(`Sheet "${name}" deleted`);
  }

  private openExternal() {
    const soffice = this.supervisor.sofficePath;
    if (!soffice) return;
    const abs = path.join(this.adapter.getBasePath(), this.file.path);
    // On macOS a .app bundle binary is best launched via `open -a` so the GUI
    // instance attaches correctly; elsewhere spawn the binary directly.
    if (process.platform === "darwin") {
      const app = soffice.match(/\/([^/]+\.app)\//)?.[1];
      if (app) {
        spawn("open", ["-a", app.replace(/\.app$/, ""), abs], { detached: true, stdio: "ignore" }).unref();
        return;
      }
    }
    spawn(soffice, [abs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
}
