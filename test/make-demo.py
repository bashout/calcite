#!/usr/bin/env python3
"""Generate a demo spreadsheet (multi-sheet, cross-sheet formulas) for manual
testing of the Calcite plugin. Usage: python3 test/make-demo.py <out.ods>"""

import subprocess
import sys
import tempfile
import time

import uno
from com.sun.star.beans import PropertyValue


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def main(out_path):
    port = 24683
    profile = tempfile.mkdtemp(prefix="calcite-demo-")
    proc = subprocess.Popen(
        ["soffice", "--headless", "--norestore", "--nodefault",
         f"-env:UserInstallation=file://{profile}",
         f"--accept=socket,host=127.0.0.1,port={port};urp;"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext(
            "com.sun.star.bridge.UnoUrlResolver", local)
        ctx = None
        for _ in range(50):
            try:
                ctx = resolver.resolve(
                    f"uno:socket,host=127.0.0.1,port={port};urp;StarOffice.ComponentContext")
                break
            except Exception:
                time.sleep(0.2)
        assert ctx, "could not connect"
        desktop = ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.Desktop", ctx)
        doc = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, ())
        sheets = doc.Sheets

        # --- Sales sheet ---
        sales = sheets.getByName("Sheet1")
        sales.Name = "Sales"
        data = [
            ["region", "product", "qty", "unit_price", "revenue"],
            ["north", "widget", 12, 9.5, "=C2*D2"],
            ["south", "widget", 7, 9.5, "=C3*D3"],
            ["north", "gadget", 4, 24.0, "=C4*D4"],
            ["south", "gadget", 9, 24.0, "=C5*D5"],
            ["total", "", "=SUM(C2:C5)", "", "=SUM(E2:E5)"],
        ]
        for r, row in enumerate(data):
            for c, val in enumerate(row):
                cell = sales.getCellByPosition(c, r)
                if isinstance(val, str) and val.startswith("="):
                    cell.setFormula(val)
                elif val != "":
                    try:
                        cell.setValue(float(val))
                    except ValueError:
                        cell.setString(val)

        # --- Inventory sheet ---
        inv = sheets.getByIndex(1) if sheets.Count > 1 else None
        doc.Sheets.insertNewByName("Inventory", 1)
        inv = sheets.getByName("Inventory")
        inv_data = [
            ["sku", "stock", "reorder_at", "status"],
            ["widget", 40, 10, '=IF(B2<C2;"REORDER";"ok")'],
            ["gadget", 5, 10, '=IF(B3<C3;"REORDER";"ok")'],
        ]
        for r, row in enumerate(inv_data):
            for c, val in enumerate(row):
                cell = inv.getCellByPosition(c, r)
                if isinstance(val, str) and val.startswith("="):
                    cell.setFormula(val)
                else:
                    try:
                        cell.setValue(float(val))
                    except ValueError:
                        cell.setString(val)

        # --- Summary sheet (cross-sheet formulas) ---
        doc.Sheets.insertNewByName("Summary", 0)
        summary = sheets.getByName("Summary")
        summary_data = [
            ["metric", "value"],
            ["total revenue", "=Sales.E6"],
            ["total units", "=Sales.C6"],
            ["avg order", "=Sales.E6/Sales.C6"],
            ["reorders needed", '=COUNTIF(Inventory.D2:D3;"REORDER")'],
            ["status", '=IF(B5>0;"ATTENTION";"all good")'],
        ]
        for r, row in enumerate(summary_data):
            for c, val in enumerate(row):
                cell = summary.getCellByPosition(c, r)
                if isinstance(val, str) and val.startswith("="):
                    cell.setFormula(val)
                else:
                    cell.setString(val)

        doc.calculateAll()
        doc.storeToURL(uno.systemPathToFileUrl(out_path), (prop("FilterName", "calc8"),))
        doc.close(False)
        print(f"wrote {out_path}")
    finally:
        proc.terminate()


if __name__ == "__main__":
    main(sys.argv[1])
