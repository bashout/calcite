import { spawnSync } from "child_process";
import { existsSync } from "fs";

/** Locate a soffice binary and a python interpreter that can `import uno`. */

export function locateSoffice(): string | null {
  const candidates = [
    process.env.CALCITE_SOFFICE,
    "soffice", // resolved via PATH (works on Windows too: CreateProcess appends .exe)
    // Linux
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/usr/bin/libreoffice",
    "/snap/bin/libreoffice",
    // macOS (dmg install + Homebrew, Intel and Apple Silicon)
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/local/bin/soffice", // homebrew on Intel macs
    "/opt/homebrew/bin/soffice", // homebrew on Apple Silicon
    "/opt/homebrew/opt/libreoffice/program/soffice",
    // Windows
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  ].filter((c): c is string => !!c);

  for (const bin of candidates) {
    // Path-like candidates must exist; bare names are resolved via PATH by spawn.
    if ((bin.includes("/") || bin.includes("\\")) && !existsSync(bin)) continue;
    const r = spawnSync(bin, ["--version"], { timeout: 15000 });
    if (r.status === 0 && !r.error) return bin;
  }
  return null;
}

export function locatePythonUno(): string | null {
  const candidates = [
    process.env.CALCITE_PYTHON,
    "python3", // POSIX PATH name
    "python", // Windows PATH name
    // Linux
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/usr/lib/libreoffice/program/python",
    // macOS (dmg bundle + Homebrew)
    "/Applications/LibreOffice.app/Contents/MacOS/python",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    // Windows (bundled interpreter of the LibreOffice install)
    "C:\\Program Files\\LibreOffice\\program\\python.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\python.exe",
  ].filter((c): c is string => !!c);

  for (const py of candidates) {
    // Only apply the existence pre-check to path-like candidates; bare names
    // ("python3", "python") are resolved via PATH by spawn itself.
    if ((py.includes("/") || py.includes("\\")) && !existsSync(py)) continue;
    const r = spawnSync(py, ["-c", "import uno"], { timeout: 15000 });
    if (r.status === 0 && !r.error) return py;
  }
  return null;
}
