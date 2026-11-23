// Best-effort Orca IDE integration. Every call is optional: failures become warnings,
// never errors. Never runs `orca open` and never passes --focus unless asked.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { buildChildEnv } from "./util.mjs";

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
let cache = { at: 0, ok: false };
const visibleRepos = new Set();

export function orcaBin() {
  if (process.env.ORCA_BIN) return process.env.ORCA_BIN;
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  const app = "/Applications/Orca.app/Contents/Resources/bin/orca";
  return fs.existsSync(app) ? app : "orca";
}

export async function orca(args, timeoutMs = 10_000) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(orcaBin(), [...args, "--json"], {
      env: buildChildEnv(),
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (err) {
    // Non-zero exit: prefer Orca's own JSON error over Node's long "Command failed: ..." text.
    stdout = String(err.stdout || "");
    if (!stdout.trim()) throw new Error(err.killed ? "timed out" : `exit ${err.code}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("non-JSON output");
  }
  if (parsed && parsed.ok === false) {
    throw new Error(parsed.error?.message || parsed.error?.code || "failed");
  }
  return parsed?.result ?? parsed;
}

export async function orcaAvailable() {
  if (process.env.AGY_ORCA === "0") return false;
  if (Date.now() - cache.at < CACHE_MS) return cache.ok;
  let ok = false;
  try {
    const r = await orca(["status"], 5_000);
    ok = Boolean(r?.runtime?.reachable);
  } catch {
    ok = false;
  }
  cache = { at: Date.now(), ok };
  return ok;
}

async function attempt(label, fn) {
  try {
    if (!(await orcaAvailable())) return { warning: `${label}: Orca not reachable` };
    return { result: await fn() };
  } catch (err) {
    return { warning: `${label}: ${String(err.message || err).split("\n")[0]}` };
  }
}

/** Make .agy-worktrees visible in Orca's sidebar (once per repo per process). */
export async function showExternalWorktrees(repoRoot) {
  if (!repoRoot || visibleRepos.has(repoRoot)) return {};
  const r = await attempt("orca repo set", () =>
    orca(["repo", "set", "--repo", `path:${repoRoot}`, "--external-worktree-visibility", "show"])
  );
  if (!r.warning) visibleRepos.add(repoRoot);
  return r;
}

/** Open a terminal tab in Orca that renders the agent's live log. */
export function openWatchTerminal({ cwd, title, command }) {
  return attempt("orca terminal create", () =>
    orca(["terminal", "create", "--worktree", `path:${cwd}`, "--title", title, "--command", command])
  );
}

export function openChanged(cwd, focus = false) {
  const args = ["file", "open-changed", "--mode", "diff", "--worktree", `path:${cwd}`];
  if (focus) args.push("--focus");
  return attempt("orca file open-changed", () => orca(args));
}

export function openDiff(cwd, file, focus = false) {
  const args = ["file", "diff", file, "--worktree", `path:${cwd}`];
  if (focus) args.push("--focus");
  return attempt("orca file diff", () => orca(args));
}
