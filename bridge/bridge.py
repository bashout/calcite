#!/usr/bin/env python3
"""Calcite bridge: JSON-lines JSON-RPC over stdio, backed by a headless
LibreOffice instance via UNO.

Protocol (one JSON object per line):
  request:  {"id": <int>, "cmd": <str>, "params": {...}}
  response: {"id": <int>, "ok": true, "result": {...}} | {"id": <int>, "ok": false, "error": <str>}
  event:    {"event": "ready"} once the UNO connection is established

Connection string is passed via CALCITE_UNO_CONNECT, e.g.
  socket,host=127.0.0.1,port=2083;urp;StarOffice.ComponentContext

Commands:
  ping                                  -> {"version": str}
  load    {"path": str}                 -> {"docId": int, "sheets": [str]}
  dump    {"docId": int, "sheet": str,  -> {"sheet": str, "range": {...}, "rows": [[cell,...]]}
           "maxRows"?: int, "maxCols"?: int}
  setCell {"docId": int, "sheet": str,  -> {}
           "col": int, "row": int, "text": str}
  insertRows  {"docId", "sheet", "row", "count"}    -> {"sheets": [str]}
  insertCols  {"docId", "sheet", "col", "count"}    -> {"sheets": [str]}
  deleteRows  {"docId", "sheet", "row", "count"}    -> {"sheets": [str]}
  deleteCols  {"docId", "sheet", "col", "count"}    -> {"sheets": [str]}
  addSheet    {"docId", "name"}                     -> {"sheets": [str]}
  renameSheet {"docId", "old", "new"}               -> {"sheets": [str]}
  deleteSheet {"docId", "name"}                     -> {"sheets": [str]}
  save    {"docId": int}                -> {}
  close   {"docId": int}                -> {}
  shutdown                              -> exits
"""

import hmac
import json
import os
import socket
import sys
import threading
import time
import traceback

# Stdio mode must be UTF-8 on every platform: on Windows the default console
# encoding (cp1252/cp437) would corrupt non-ASCII cell text.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

import uno  # noqa: E402
from com.sun.star.beans import PropertyValue  # noqa: E402
from com.sun.star.sheet.CellInsertMode import DOWN, RIGHT  # noqa: E402


def _prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


class Bridge:
    def __init__(self):
        self.ctx = None
        self.desktop = None
        self.docs = {}
        self.paths = {}  # absolute path -> docId (shared docs across windows)
        self.refs = {}   # docId -> open count (one per attached window)
        self.roots = set()  # vault roots registered by attached windows
        self.next_doc_id = 1
        self.shared = False  # True when listening on a socket for multiple windows

    def connect(self, connect_str, attempts=50, delay=0.2):
        import time

        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext(
            "com.sun.star.bridge.UnoUrlResolver", local
        )
        url = "uno:" + connect_str
        last_err = None
        for _ in range(attempts):
            try:
                self.ctx = resolver.resolve(url)
                break
            except Exception as e:  # NoConnectException while soffice starts
                last_err = e
                time.sleep(delay)
        if self.ctx is None:
            raise RuntimeError(f"could not connect to soffice: {last_err}")
        smgr = self.ctx.ServiceManager
        self.desktop = smgr.createInstanceWithContext(
            "com.sun.star.frame.Desktop", self.ctx
        )

    def cmd_ping(self, _params):
        return {"version": self.desktop.getImplementationName()}

    def cmd_sheets(self, params):
        doc = self.docs[params["docId"]]
        return {"sheets": self._sheet_names(doc)}

    def _check_path(self, path, root):
        """Defense in depth: the client validates against its vault; the engine
        additionally only ever touches files under a registered vault root."""
        if root:
            r = os.path.abspath(root)
            # Windows paths are case-insensitive; normcase makes the prefix
            # check reliable there (no-op elsewhere).
            self.roots.add(os.path.normcase(r) if os.name == "nt" else r)
        real = os.path.realpath(path)
        if os.name == "nt":
            real = os.path.normcase(real)
        if not any(real == r or real.startswith(r + os.sep) for r in self.roots):
            raise RuntimeError(f"path outside registered vault roots: {path}")

    def cmd_load(self, params):
        path = os.path.abspath(params["path"])
        self._check_path(path, params.get("root"))
        if not os.path.isfile(path):
            raise RuntimeError(f"file not found: {path}")
        if path in self.paths:
            docId = self.paths[path]
            self.refs[docId] = self.refs.get(docId, 0) + 1
            doc = self.docs[docId]
            return {"docId": docId, "sheets": list(doc.Sheets.getElementNames()),
                    "readOnly": bool(doc.isReadonly()), "shared": True}
        url = uno.systemPathToFileUrl(path)
        doc = self.desktop.loadComponentFromURL(
            url, "_blank", 0, (_prop("Hidden", True),)
        )
        if doc is None:
            # Often a stale/foreign .~lock file: retry read-only so the embed
            # still renders instead of failing outright.
            doc = self.desktop.loadComponentFromURL(
                url, "_blank", 0, (_prop("Hidden", True), _prop("ReadOnly", True))
            )
        if doc is None:
            raise RuntimeError(f"soffice refused to load: {path} (locked or corrupt?)")
        docId = self.next_doc_id
        self.next_doc_id += 1
        self.docs[docId] = doc
        self.paths[path] = docId
        self.refs[docId] = 1
        sheets = list(doc.Sheets.getElementNames())
        return {"docId": docId, "sheets": sheets, "readOnly": bool(doc.isReadonly())}

    def cmd_dump(self, params):
        doc = self.docs[params["docId"]]
        doc.calculateAll()
        sheet = doc.Sheets.getByName(params["sheet"])
        cursor = sheet.createCursor()
        cursor.gotoStartOfUsedArea(False)
        cursor.gotoEndOfUsedArea(True)
        addr = cursor.RangeAddress
        max_rows = int(params.get("maxRows", 500))
        max_cols = int(params.get("maxCols", 100))
        # The view always starts at A1 (like a spreadsheet), not at the used
        # range's start — otherwise content shifted right by inserts renders
        # as if the leading empty columns don't exist.
        start_col = 0
        start_row = 0
        end_col = min(addr.EndColumn, max_cols - 1)
        end_row = min(addr.EndRow, max_rows - 1)
        # Optional explicit render window (used after structural edits so the
        # inserted row/col stays visible even outside the used range).
        win = params.get("window")
        if win:
            start_col = max(0, min(start_col, int(win["startCol"])))
            start_row = max(0, min(start_row, int(win["startRow"])))
            end_col = min(max(end_col, int(win["endCol"])), max_cols - 1)
            end_row = min(max(end_row, int(win["endRow"])), max_rows - 1)
        if start_col > end_col or start_row > end_row:
            return {"sheet": params["sheet"], "range": None, "rows": []}
        rng = sheet.getCellRangeByPosition(
            start_col, start_row, end_col, end_row
        )
        values = rng.getDataArray()      # computed values
        formulas = rng.getFormulaArray()  # formulas ("=..." where present)
        rows = []
        for r, (vrow, frow) in enumerate(zip(values, formulas)):
            row = []
            for c, (v, f) in enumerate(zip(vrow, frow)):
                is_formula = isinstance(f, str) and f.startswith("=")
                # getDataArray returns None for string-valued formula results;
                # fetch those individually via getString().
                if is_formula and v is None:
                    cobj = rng.getCellByPosition(c, r)
                    s = cobj.getString()
                    cell_out = {"v": None, "s": s, "f": f}
                    err = cobj.getError()
                    if err:
                        cell_out["err"] = err
                    row.append(cell_out)
                else:
                    cell = {"v": v, "s": str(v) if v is not None else ""}
                    if is_formula:
                        cell["f"] = f
                    row.append(cell)
            rows.append(row)
        return {
            "sheet": params["sheet"],
            "range": {
                "startCol": start_col,
                "startRow": start_row,
                "endCol": end_col,
                "endRow": end_row,
            },
            "rows": rows,
        }

    def cmd_set_cell(self, params):
        doc = self.docs[params["docId"]]
        sheet = doc.Sheets.getByName(params["sheet"])
        cell = sheet.getCellByPosition(int(params["col"]), int(params["row"]))
        text = params["text"]
        if text.startswith("="):
            cell.setFormula(text)
        elif text == "":
            cell.setString("")
        else:
            try:
                cell.setValue(float(text))
            except ValueError:
                cell.setString(text)
        doc.calculateAll()
        return {}

    def _sheet(self, doc, name):
        return doc.Sheets.getByName(name)

    def _sheet_names(self, doc):
        return list(doc.Sheets.getElementNames())

    def _full_row_range(self, sheet, row, count):
        # Whole rows: span every column the sheet actually has (the max column
        # index differs across LibreOffice versions, so ask the sheet).
        return sheet.getCellRangeByPosition(0, row, sheet.Columns.Count - 1, row + count - 1)

    def _full_col_range(self, sheet, col, count):
        return sheet.getCellRangeByPosition(col, 0, col + count - 1, sheet.Rows.Count - 1)

    def cmd_insert_rows(self, params):
        doc = self.docs[params["docId"]]
        sheet = self._sheet(doc, params["sheet"])
        row = int(params["row"])
        count = int(params["count"])
        if count < 1:
            raise RuntimeError("count must be >= 1")
        rng = self._full_row_range(sheet, row, count)
        sheet.insertCells(rng.RangeAddress, DOWN)
        doc.calculateAll()
        return {"sheets": self._sheet_names(doc)}

    def cmd_insert_cols(self, params):
        doc = self.docs[params["docId"]]
        sheet = self._sheet(doc, params["sheet"])
        col = int(params["col"])
        count = int(params["count"])
        if count < 1:
            raise RuntimeError("count must be >= 1")
        rng = self._full_col_range(sheet, col, count)
        sheet.insertCells(rng.RangeAddress, RIGHT)
        doc.calculateAll()
        return {"sheets": self._sheet_names(doc)}

    def _delete(self, doc, sheet, rng, uno_cmd):
        # ScSheetObj in this build exposes insertCells but not removeCells, so
        # deletions go through the controller dispatcher (.uno:DeleteRows etc.).
        ctrl = doc.getCurrentController()
        if ctrl is None:
            raise RuntimeError("no controller for delete operation")
        ctrl.setActiveSheet(sheet)
        ctrl.select(rng)
        helper = self.ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.DispatchHelper", self.ctx
        )
        helper.executeDispatch(ctrl.getFrame(), uno_cmd, "", 0, ())
        doc.calculateAll()

    def cmd_delete_rows(self, params):
        doc = self.docs[params["docId"]]
        sheet = self._sheet(doc, params["sheet"])
        row = int(params["row"])
        count = int(params["count"])
        if count < 1:
            raise RuntimeError("count must be >= 1")
        self._delete(doc, sheet, self._full_row_range(sheet, row, count), ".uno:DeleteRows")
        return {"sheets": self._sheet_names(doc)}

    def cmd_delete_cols(self, params):
        doc = self.docs[params["docId"]]
        sheet = self._sheet(doc, params["sheet"])
        col = int(params["col"])
        count = int(params["count"])
        if count < 1:
            raise RuntimeError("count must be >= 1")
        self._delete(doc, sheet, self._full_col_range(sheet, col, count), ".uno:DeleteColumns")
        return {"sheets": self._sheet_names(doc)}

    def cmd_add_sheet(self, params):
        doc = self.docs[params["docId"]]
        name = params.get("name") or ""
        if not name.strip():
            raise RuntimeError("sheet name must not be empty")
        if name in self._sheet_names(doc):
            raise RuntimeError(f"sheet already exists: {name}")
        doc.Sheets.insertNewByName(name, doc.Sheets.Count)
        doc.calculateAll()
        return {"sheets": self._sheet_names(doc)}

    def cmd_rename_sheet(self, params):
        doc = self.docs[params["docId"]]
        old = params.get("old") or ""
        new = params.get("new") or ""
        if not new.strip():
            raise RuntimeError("sheet name must not be empty")
        names = self._sheet_names(doc)
        if old not in names:
            raise RuntimeError(f"no such sheet: {old}")
        if new in names:
            raise RuntimeError(f"sheet already exists: {new}")
        doc.Sheets.getByName(old).Name = new
        doc.calculateAll()
        return {"sheets": self._sheet_names(doc)}

    def cmd_delete_sheet(self, params):
        doc = self.docs[params["docId"]]
        name = params.get("name") or ""
        if doc.Sheets.Count <= 1:
            raise RuntimeError("cannot delete the last sheet")
        if name not in self._sheet_names(doc):
            raise RuntimeError(f"no such sheet: {name}")
        doc.Sheets.removeByName(name)
        doc.calculateAll()
        return {"sheets": self._sheet_names(doc)}

    def cmd_save(self, params):
        doc = self.docs[params["docId"]]
        if not doc.isModified():
            return {"skipped": True}
        # Write to a temp file in the same directory, then atomically replace,
        # so a crash mid-store cannot corrupt the vault file.
        url = doc.getURL()
        path = uno.fileUrlToSystemPath(url)
        tmp = f"{path}.calcite-tmp-{os.getpid()}"
        last_err = None
        for _ in range(3):
            try:
                doc.storeToURL(uno.systemPathToFileUrl(tmp), (_prop("Overwrite", True),))
                os.replace(tmp, path)
                doc.setModified(False)
                return {"saved": True}
            except Exception as e:
                # storeSelf Io Abort (0x11b) happens when a store races a close
                # or another store; back off and retry.
                last_err = e
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                time.sleep(0.3)
        raise RuntimeError(f"store failed: {last_err}")

    def cmd_close(self, params):
        docId = params["docId"]
        self.refs[docId] = self.refs.get(docId, 1) - 1
        if self.refs[docId] > 0:
            return {"deferred": True}
        doc = self.docs.pop(docId, None)
        self.refs.pop(docId, None)
        if doc is not None:
            for p, d in list(self.paths.items()):
                if d == docId:
                    del self.paths[p]
            doc.close(False)
        return {}

    def cmd_shutdown(self, _params):
        if self.shared:
            # Shared bridge: just end this client's session; the process stays
            # up for other windows. The client closes the socket itself.
            return {"bye": True}
        for doc in list(self.docs.values()):
            try:
                doc.close(False)
            except Exception:
                pass
        sys.exit(0)


HANDLERS = {
    "ping": "cmd_ping",
    "sheets": "cmd_sheets",
    "load": "cmd_load",
    "dump": "cmd_dump",
    "setCell": "cmd_set_cell",
    "insertRows": "cmd_insert_rows",
    "insertCols": "cmd_insert_cols",
    "deleteRows": "cmd_delete_rows",
    "deleteCols": "cmd_delete_cols",
    "addSheet": "cmd_add_sheet",
    "renameSheet": "cmd_rename_sheet",
    "deleteSheet": "cmd_delete_sheet",
    "save": "cmd_save",
    "close": "cmd_close",
    "shutdown": "cmd_shutdown",
}


def serve_conn(bridge, conn, lock):
    """JSON-lines RPC on one connection. Socket connections must send the auth
    token as the first line; the private stdio pipe is trusted."""
    try:
        if hasattr(conn, "makefile"):
            f = conn.makefile("rw", encoding="utf-8", newline="\n")
            token_line = f.readline().strip()
            expected = os.environ.get("CALCITE_BRIDGE_TOKEN", "")
            if not token_line or not hmac.compare_digest(token_line, expected):
                f.write(json.dumps({"event": "fatal", "error": "bad token"}) + "\n")
                f.flush()
                return
            f.write(json.dumps({"event": "ok"}) + "\n")
            f.flush()
        else:
            f = conn  # stdio (private pipe, trusted)
        for line in f:
            line = line.strip()
            if not line:
                continue
            with lock:
                try:
                    req = json.loads(line)
                    handler = getattr(bridge, HANDLERS[req["cmd"]])
                    result = handler(req.get("params") or {})
                    resp = {"id": req["id"], "ok": True, "result": result}
                except Exception as e:
                    resp = {"id": req.get("id"), "ok": False, "error": f"{e}\n{traceback.format_exc()}"}
            f.write(json.dumps(resp) + "\n")
            f.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def main():
    bridge = Bridge()
    lock = threading.Lock()
    connect_str = os.environ.get("CALCITE_UNO_CONNECT")
    if not connect_str:
        print(json.dumps({"event": "fatal", "error": "CALCITE_UNO_CONNECT not set"}))
        sys.exit(1)
    try:
        bridge.connect(connect_str)
    except Exception as e:
        print(json.dumps({"event": "fatal", "error": str(e)}))
        sys.exit(1)
    print(json.dumps({"event": "ready"}), flush=True)

    listen = os.environ.get("CALCITE_BRIDGE_LISTEN")  # "port" — shared mode
    if listen:
        bridge.shared = True
        port = int(listen)
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", port))
        srv.listen(8)
        print(json.dumps({"event": "listening", "port": port}), flush=True)
        while True:
            conn, _ = srv.accept()
            threading.Thread(target=serve_conn, args=(bridge, conn, lock), daemon=True).start()
    else:
        serve_conn(bridge, sys.stdin, lock)  # stdio mode (single client)


if __name__ == "__main__":
    main()
