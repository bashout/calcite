import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import * as path from "path";

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

/**
 * Contents dir of the macOS LibreOffice app bundle.
 * CALCITE_MACOS_BUNDLE overrides it (used by tests to point at a fake bundle).
 */
export function macOsBundleContents(): string {
  return process.env.CALCITE_MACOS_BUNDLE ?? "/Applications/LibreOffice.app/Contents";
}

/**
 * LibreOffice 25.x macOS builds no longer ship Contents/MacOS/python; the
 * bundled interpreter lives at
 * Contents/Frameworks/LibreOfficePython.framework/Versions/<ver>/bin/python3.x
 * Returns candidate interpreter paths, "Current" symlink first, then numeric
 * versions newest-first. Empty when the framework is absent (e.g. Homebrew,
 * which has no app bundle — those systems use a PATH python instead).
 */
export function macOsFrameworkPythonCandidates(contentsDir = macOsBundleContents()): string[] {
  const versionsDir = path.join(contentsDir, "Frameworks", "LibreOfficePython.framework", "Versions");
  let versions: string[];
  try {
    versions = readdirSync(versionsDir);
  } catch {
    return [];
  }
  const numeric = versions.filter((v) => /^\d+(\.\d+)*$/.test(v)).sort().reverse();
  const ordered = [
    ...versions.filter((v) => v === "Current"),
    ...numeric,
    ...versions.filter((v) => v !== "Current" && !/^\d+(\.\d+)*$/.test(v)),
  ];
  const out: string[] = [];
  for (const v of ordered) {
    const binDir = path.join(versionsDir, v, "bin");
    let bins: string[];
    try {
      bins = readdirSync(binDir);
    } catch {
      continue; // "Current" may dangle or the dir may be unreadable
    }
    for (const b of bins.sort().reverse()) {
      if (/^python3(\.\d+)?$/.test(b)) out.push(path.join(binDir, b));
    }
  }
  return out;
}

/**
 * In LO 25.x macOS bundles, uno.py and the pyuno modules live in
 * Contents/Resources (not next to soffice), so the bundled interpreter needs
 * this dir on PYTHONPATH to `import uno`.
 */
export function macOsUnoResourcesDir(contentsDir = macOsBundleContents()): string {
  return path.join(contentsDir, "Resources");
}

export interface PythonUnoCandidate {
  bin: string;
  /** Extra environment for the probe (e.g. PYTHONPATH for the bundled macOS python). */
  env?: NodeJS.ProcessEnv;
}

export function pythonUnoCandidates(): PythonUnoCandidate[] {
  const contents = macOsBundleContents();
  const resources = macOsUnoResourcesDir(contents);
  const macFrameworkEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: resources };
  return [
    ...(process.env.CALCITE_PYTHON ? [{ bin: process.env.CALCITE_PYTHON }] : []),
    { bin: "python3" }, // POSIX PATH name
    { bin: "python" }, // Windows PATH name
    // Linux
    { bin: "/usr/bin/python3" },
    { bin: "/usr/local/bin/python3" },
    { bin: "/usr/lib/libreoffice/program/python" },
    // macOS (dmg bundle; LO <= 24.x shipped Contents/MacOS/python)
    { bin: path.join(contents, "MacOS", "python") },
    // macOS LO 25.x+: framework interpreter, probed with Resources on PYTHONPATH
    ...macOsFrameworkPythonCandidates(contents).map((bin) => ({ bin, env: macFrameworkEnv })),
    // macOS Homebrew
    { bin: "/opt/homebrew/bin/python3" },
    { bin: "/usr/local/bin/python3" },
    // Windows (bundled interpreter of the LibreOffice install)
    { bin: "C:\\Program Files\\LibreOffice\\program\\python.exe" },
    { bin: "C:\\Program Files (x86)\\LibreOffice\\program\\python.exe" },
  ];
}

/**
 * Probe candidates until one runs `import uno` successfully; returns its
 * path or null. A candidate killed by the kernel (macOS 26+ launch
 * constraints SIGKILL direct spawns of the bundled interpreter) simply fails
 * the status check and is skipped.
 */
export function locatePythonUnoIn(candidates: PythonUnoCandidate[]): string | null {
  for (const c of candidates) {
    const py = c.bin;
    if (!py) continue;
    // Only apply the existence pre-check to path-like candidates; bare names
    // ("python3", "python") are resolved via PATH by spawn itself.
    if ((py.includes("/") || py.includes("\\")) && !existsSync(py)) continue;
    const r = spawnSync(py, ["-c", "import uno"], {
      timeout: 15000,
      env: c.env ?? process.env,
    });
    if (r.status === 0 && !r.error) return py;
  }
  return null;
}

export function locatePythonUno(): string | null {
  return locatePythonUnoIn(pythonUnoCandidates());
}
