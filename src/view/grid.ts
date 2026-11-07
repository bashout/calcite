import { Menu } from "obsidian";
import { CellData, GridData } from "../engine/supervisor";

export type EmbedStatus = "loading" | "ready" | "error";

export interface CellRef {
  col: number;
  row: number;
}

export interface GridCallbacks {
  onSheetChange(sheet: string): void;
  onReload(): void;
  onOpenExternal(): void;
  onCellEdit(col: number, row: number, text: string): void;
  onInsertRow(row: number): void;
  onDeleteRow(row: number): void;
  onInsertCol(col: number): void;
  onDeleteCol(col: number): void;
  onAddSheet(): void;
  onRenameSheet(name: string): void;
  onDeleteSheet(name: string): void;
}

export interface GridOptions {
  sheets: string[];
  activeSheet: string;
  dirty: boolean;
  error: string | null;
  selected: CellRef | null;
  readOnly?: boolean;
  /** True while the engine is starting/respawning — edits are locked. */
  engineBusy?: boolean;
  callbacks: GridCallbacks;
}

function colLabel(i: number): string {
  let s = "";
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export function cellName(ref: CellRef): string {
  return `${colLabel(ref.col)}${ref.row + 1}`;
}

export function renderGrid(container: HTMLElement, grid: GridData, opts: GridOptions): void {
  container.empty();
  container.addClass("calcite-grid");
  if (opts.engineBusy) container.addClass("calcite-busy");

  const bar = container.createDiv({ cls: "calcite-bar" });
  const tabs = bar.createDiv({ cls: "calcite-tabs" });
  for (const name of opts.sheets) {
    const tab = tabs.createEl("button", { cls: "calcite-tab", text: name });
    if (name === opts.activeSheet) tab.addClass("calcite-tab-active");
    tab.onClickEvent(() => opts.callbacks.onSheetChange(name));
    tab.oncontextmenu = (e: MouseEvent) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Rename sheet").onClick(() => opts.callbacks.onRenameSheet(name)));
      if (opts.sheets.length > 1) {
        menu.addItem((i) => i.setTitle("Delete sheet").onClick(() => opts.callbacks.onDeleteSheet(name)));
      }
      menu.showAtMouseEvent(e);
    };
  }
  const addTab = tabs.createEl("button", { cls: "calcite-tab calcite-tab-add", text: "+" });
  addTab.setAttr("title", "New sheet");
  addTab.onClickEvent(() => opts.callbacks.onAddSheet());
  const actions = bar.createDiv({ cls: "calcite-actions" });
  if (opts.engineBusy) actions.createEl("span", { cls: "calcite-dirty", text: "engine reconnecting…" });
  if (opts.dirty) actions.createEl("span", { cls: "calcite-dirty", text: "saving…" });
  if (opts.readOnly) actions.createEl("span", { cls: "calcite-error", text: "read-only (locked?)" });
  if (opts.error) {
    const errEl = actions.createEl("span", { cls: "calcite-error", text: opts.error });
    errEl.setAttr("title", opts.error); // full message on hover (label is truncated)
  }
  const refresh = actions.createEl("button", { cls: "calcite-btn", text: "Reload" });
  refresh.setAttr("title", "Recalculate and reload from disk");
  refresh.onClickEvent(() => opts.callbacks.onReload());
  const open = actions.createEl("button", { cls: "calcite-btn", text: "Open in LibreOffice" });
  open.onClickEvent(() => opts.callbacks.onOpenExternal());

  renderFormulaBar(container, grid, opts);

  if (!grid.range || grid.rows.length === 0) {
    container.createEl("div", { cls: "calcite-empty", text: "Sheet is empty" });
    return;
  }
  const { startCol, startRow } = grid.range;
  const nCols = grid.rows[0].length;
  const nRows = grid.rows.length;
  const table = container.createEl("table", { cls: "calcite-table" });
  const thead = table.createEl("thead");
  const hr = thead.createEl("tr");
  hr.createEl("th", { cls: "calcite-corner" });
  for (let c = 0; c < nCols; c++) {
    const th = hr.createEl("th", { text: colLabel(startCol + c) });
    th.oncontextmenu = (e: MouseEvent) => {
      e.preventDefault();
      const col = startCol + c;
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Insert column left").onClick(() => opts.callbacks.onInsertCol(col)));
      menu.addItem((i) => i.setTitle("Insert column right").onClick(() => opts.callbacks.onInsertCol(col + 1)));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Delete column").onClick(() => opts.callbacks.onDeleteCol(col)));
      menu.showAtMouseEvent(e);
    };
  }
  const tbody = table.createEl("tbody");
  grid.rows.forEach((row, r) => {
    const tr = tbody.createEl("tr");
    const rh = tr.createEl("th", { text: String(startRow + r + 1) });
    rh.oncontextmenu = (e: MouseEvent) => {
      e.preventDefault();
      const row = startRow + r;
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Insert row above").onClick(() => opts.callbacks.onInsertRow(row)));
      menu.addItem((i) => i.setTitle("Insert row below").onClick(() => opts.callbacks.onInsertRow(row + 1)));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Delete row").onClick(() => opts.callbacks.onDeleteRow(row)));
      menu.showAtMouseEvent(e);
    };
    row.forEach((cell, c) => {
      const td = tr.createEl("td", { text: cell.s });
      if (cell.f) td.setAttr("title", cell.f);
      if (cell.err) {
        td.addClass("calcite-cell-error");
        td.setAttr("title", `${cell.f ?? cell.s} (error ${cell.err})`);
      }
      if (typeof cell.v === "number") td.addClass("calcite-num");
      td.addClass("calcite-cell");
      const ref = { col: startCol + c, row: startRow + r };
      td.setAttr("data-col", String(ref.col));
      td.setAttr("data-row", String(ref.row));
      if (opts.selected && opts.selected.col === ref.col && opts.selected.row === ref.row) {
        td.addClass("calcite-selected");
      }
      td.onClickEvent(() => selectCell(container, grid, opts, ref, cell));
      td.ondblclick = () => {
        if (opts.engineBusy) return;
        startEdit(td, cell.f ?? cell.s, (text) => opts.callbacks.onCellEdit(ref.col, ref.row, text));
      };
    });
  });

  // Keyboard navigation on the container: arrows move selection, Enter/F2 edit.
  container.onkeydown = (e: KeyboardEvent) => {
    // Never steal keys from an active editor (formula bar or inline input).
    if (e.target instanceof HTMLInputElement) return;
    if (!opts.selected || !grid.range) return;
    const { startCol, startRow } = grid.range;
    const maxCol = startCol + nCols - 1;
    const maxRow = startRow + nRows - 1;
    let next: CellRef | null = null;
    if (e.key === "ArrowLeft") next = { col: Math.max(startCol, opts.selected.col - 1), row: opts.selected.row };
    else if (e.key === "ArrowRight") next = { col: Math.min(maxCol, opts.selected.col + 1), row: opts.selected.row };
    else if (e.key === "ArrowUp") next = { col: opts.selected.col, row: Math.max(startRow, opts.selected.row - 1) };
    else if (e.key === "ArrowDown") next = { col: opts.selected.col, row: Math.min(maxRow, opts.selected.row + 1) };
    else if ((e.key === "Enter" || e.key === "F2") && !opts.engineBusy) {
      const cell = grid.rows[opts.selected.row - startRow][opts.selected.col - startCol];
      const td = container.querySelector(`td[data-col="${opts.selected.col}"][data-row="${opts.selected.row}"]`);
      if (td instanceof HTMLElement) startEdit(td, cell.f ?? cell.s, (text) => opts.callbacks.onCellEdit(opts.selected!.col, opts.selected!.row, text));
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    const cell = grid.rows[next.row - startRow][next.col - startCol];
    selectCell(container, grid, opts, next, cell);
  };
  container.tabIndex = 0;
}

function selectCell(container: HTMLElement, grid: GridData, opts: GridOptions, ref: CellRef, _cell: CellData): void {
  container.querySelectorAll("td.calcite-selected").forEach((el) => el.removeClass("calcite-selected"));
  const td = container.querySelector(`td[data-col="${ref.col}"][data-row="${ref.row}"]`);
  td?.addClass("calcite-selected");
  renderFormulaBar(container, grid, { ...opts, selected: ref });
}

function renderFormulaBar(container: HTMLElement, grid: GridData, opts: GridOptions): void {
  let bar = container.querySelector(".calcite-formula-bar");
  if (!bar) {
    bar = container.createDiv({ cls: "calcite-formula-bar" });
    // move it right after the top bar
    const topBar = container.querySelector(".calcite-bar");
    topBar?.after(bar);
  }
  bar.empty();
  const refLabel = bar.createEl("span", { cls: "calcite-ref", text: opts.selected ? cellName(opts.selected) : "" });
  const cell = opts.selected && grid.range
    ? grid.rows[opts.selected.row - grid.range.startRow]?.[opts.selected.col - grid.range.startCol]
    : undefined;
  const input = bar.createEl("input", {
    cls: "calcite-formula-input",
    value: cell ? cell.f ?? cell.s : "",
  });
  input.placeholder = "cell content / formula";
  input.onkeydown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter" && opts.selected) {
      e.preventDefault();
      if (!opts.engineBusy) opts.callbacks.onCellEdit(opts.selected.col, opts.selected.row, input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = cell ? cell.f ?? cell.s : "";
      input.blur();
    }
  };
  refLabel.onclick = () => input.focus();
}

function startEdit(td: HTMLElement, initial: string, commit: (text: string) => void): void {
  if (td.querySelector("input")) return;
  td.empty();
  const input = td.createEl("input", { cls: "calcite-editor", value: initial });
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) commit(input.value);
    else input.remove();
  };
  input.onkeydown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };
  input.onblur = () => finish(true);
}

export function renderStatus(container: HTMLElement, status: EmbedStatus, message: string): void {
  container.empty();
  container.addClass(`calcite-status-${status}`);
  container.createEl("div", { cls: "calcite-banner", text: message });
}
