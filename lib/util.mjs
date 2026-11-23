// Small shared helpers. Zero dependencies.
import fs from "node:fs";
import path from "node:path";

export const nowIso = () => new Date().toISOString();

export function truncate(str, maxLen = 200) {
  if (typeof str !== "string") return "";
  return str.length <= maxLen ? str : `${str.slice(0, maxLen)}…`;
}

export function oneLine(str, maxLen = 160) {
  return truncate(String(str ?? "").replace(/\s+/g, " ").trim(), maxLen);
}

export function elapsedSeconds(startIso, endIso = null) {
  if (!startIso) return 0;
  const end = endIso ? Date.parse(endIso) : Date.now();
  return Math.max(0, Math.round((end - Date.parse(startIso)) / 1000));
}

/** Drop null/undefined/""/false/empty arrays/empty objects, recursively. */
export function compact(value) {
  if (Array.isArray(value)) {
    const arr = value.map(compact).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (value === null || value === undefined || value === "" || value === false) return undefined;
  return value;
}

/** Last `n` lines of a file, reading at most `maxBytes` from its end. */
export function tailFile(file, n = 20, maxBytes = 64 * 1024) {
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      if (start > 0) lines.shift(); // first line may be partial
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return lines.slice(-n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

const realCache = new Map();
function realBase(base) {
  if (!realCache.has(base)) {
    let real = base;
    try {
      real = fs.realpathSync(base);
    } catch {
      // keep as-is
    }
    realCache.set(base, real);
  }
  return realCache.get(base);
}

/** Path relative to base when inside it (symlink-aware, e.g. macOS /var -> /private/var). */
export function relTo(base, p) {
  if (!p || typeof p !== "string") return p;
  if (!base || !path.isAbsolute(p)) return p;
  for (const b of [base, realBase(base)]) {
    const r = path.relative(b, p);
    if (r && !r.startsWith("..") && !path.isAbsolute(r)) return r;
  }
  return p;
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Send a signal to a whole process group (detached children lead their own group). */
export function killGroup(pid, signal = "SIGTERM") {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export function buildChildEnv() {
  const home = process.env.HOME || "";
  const extra = [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return { ...process.env, PATH: [...extra, process.env.PATH || ""].filter(Boolean).join(":") };
}
