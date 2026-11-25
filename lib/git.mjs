// Git helpers: execFile only (no shell interpolation).
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { buildChildEnv } from "./util.mjs";

const execFileAsync = promisify(execFile);

export async function git(args, cwd, { allowFail = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: buildChildEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout: stdout.replace(/\s+$/, ""), stderr: stderr.trim() };
  } catch (err) {
    if (!allowFail) {
      const msg = (err.stderr || err.message || "").toString().trim();
      throw new Error(`git ${args[0]} failed: ${msg}`);
    }
    return {
      ok: false,
      code: typeof err.code === "number" ? err.code : 1,
      stdout: (err.stdout || "").toString().replace(/\s+$/, ""),
      stderr: (err.stderr || err.message || "").toString().trim(),
    };
  }
}

export async function repoRootOf(cwd) {
  const r = await git(["rev-parse", "--show-toplevel"], cwd, { allowFail: true });
  return r.ok && r.stdout ? r.stdout : null;
}

export async function revParse(ref, cwd) {
  const r = await git(["rev-parse", "--verify", `${ref}^{commit}`], cwd, { allowFail: true });
  return r.ok ? r.stdout : null;
}

// Worktrees live OUTSIDE the repo: nested copies under the repo root get picked up by Jest/Vitest/tsc/ESLint
// runs in the main checkout (duplicate tests, haste collisions). By default they sit next to it,
// <parent>/<repo>.agy-worktrees/<id>, so they share the repo's ancestors: Node, tsconfig, .nvmrc etc. resolve
// parent-directory config exactly as in the main checkout (a dir under the server would inherit the server's
// package.json "type": "module").
const WORKTREE_DIR = process.env.AGY_WORKTREE_DIR || null;
// Untracked dependency dirs a fresh worktree lacks. Inside the repo, Node found them by walking up; now we link them.
const LINKS = (process.env.AGY_WORKTREE_LINKS ?? "node_modules,.venv").split(",").map((s) => s.trim()).filter(Boolean);

/** Add patterns to the repo's shared info/exclude (applies to every linked worktree). */
async function ensureExcluded(repoRoot, patterns) {
  try {
    const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot)).stdout;
    const excludePath = path.join(common, "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const content = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const have = new Set(content.split("\n").map((l) => l.trim()));
    const missing = patterns.filter((p) => !have.has(p));
    if (missing.length) fs.appendFileSync(excludePath, `${content && !content.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  } catch {
    // non-fatal
  }
}

/**
 * Symlink dependency dirs from the main checkout into the worktree (root and the worker's subdir).
 * Excluded by bare name: a `node_modules/` pattern matches directories only, so it would not hide a symlink
 * and agy_merge would commit it.
 */
async function linkDependencies(repoRoot, root, rel) {
  const linked = [];
  const subs = rel ? ["", rel] : [""];
  for (const sub of subs) {
    for (const name of LINKS) {
      const src = path.join(repoRoot, sub, name);
      const dst = path.join(root, sub, name);
      if (!fs.existsSync(src) || fs.existsSync(dst) || !fs.existsSync(path.dirname(dst))) continue;
      try {
        fs.symlinkSync(src, dst, "dir");
        linked.push(path.join(sub, name));
      } catch {
        // non-fatal: the worker or verify_cmd can still install
      }
    }
  }
  if (linked.length) await ensureExcluded(repoRoot, LINKS);
  return linked;
}

export async function createWorktree(cwd, agentId, baseRef = "HEAD") {
  const repoRoot = await repoRootOf(cwd);
  if (!repoRoot) throw new Error(`use_worktree=true but '${cwd}' is not inside a git repository.`);
  const baseSha = await revParse(baseRef, repoRoot);
  if (!baseSha) throw new Error(`base_ref '${baseRef}' does not resolve to a commit.`);
  const rel = path.relative(repoRoot, path.resolve(cwd));
  const tag = crypto.createHash("sha1").update(repoRoot).digest("hex").slice(0, 6);
  const dir = WORKTREE_DIR
    ? path.join(WORKTREE_DIR, `${path.basename(repoRoot)}-${tag}`)
    : path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}.agy-worktrees`);
  fs.mkdirSync(dir, { recursive: true });
  const root = path.join(dir, agentId);
  const branch = `agy/${agentId}`;
  await git(["worktree", "add", "-b", branch, root, baseSha], repoRoot);
  const inside = rel && !rel.startsWith("..") ? rel : "";
  const linked = await linkDependencies(repoRoot, root, inside);
  const sub = inside ? path.join(root, inside) : root;
  return { repoRoot, root, branch, baseSha, linked, cwd: fs.existsSync(sub) ? sub : root };
}

/** Compact change summary vs base (working tree incl. worker commits + untracked). */
export async function changeSummary(cwd, baseSha, maxFiles = 10) {
  if (!baseSha) return null;
  const [numstat, untracked] = await Promise.all([
    git(["diff", "--numstat", baseSha], cwd, { allowFail: true }),
    git(["ls-files", "--others", "--exclude-standard"], cwd, { allowFail: true }),
  ]);
  if (!numstat.ok) return null;
  const files = [];
  let plus = 0;
  let minus = 0;
  for (const line of numstat.stdout.split("\n").filter(Boolean)) {
    const [a, d, ...rest] = line.split("\t");
    const name = rest.join("\t");
    const ai = Number(a) || 0;
    const di = Number(d) || 0;
    plus += ai;
    minus += di;
    files.push(a === "-" ? `${name}(bin)` : `${name} +${ai}-${di}`);
  }
  for (const f of untracked.ok ? untracked.stdout.split("\n").filter(Boolean) : []) {
    files.push(`${f}(new)`);
  }
  if (!files.length) return "no changes";
  const shown = files.slice(0, maxFiles).join(", ");
  const more = files.length > maxFiles ? ` +${files.length - maxFiles} more` : "";
  return `${files.length} files +${plus}-${minus}: ${shown}${more}`;
}

/** Budgeted unified diff vs base, including contents of untracked files. */
export async function diffText(cwd, baseSha, { paths = [], maxChars = 8000, maxUntrackedChars = 2000 } = {}) {
  if (!baseSha) throw new Error("No git base recorded for this agent (cwd is not a git repo).");
  const pathArgs = paths.length ? ["--", ...paths] : [];
  const d = await git(["diff", "--no-color", "--no-ext-diff", baseSha, ...pathArgs], cwd);
  let out = d.stdout;
  const un = await git(["ls-files", "--others", "--exclude-standard", ...pathArgs], cwd, { allowFail: true });
  for (const f of un.ok ? un.stdout.split("\n").filter(Boolean) : []) {
    let body = "";
    try {
      body = fs.readFileSync(path.join(cwd, f), "utf8");
    } catch {
      body = "(unreadable)";
    }
    if (body.includes("\u0000")) body = "(binary)";
    else if (body.length > maxUntrackedChars) body = `${body.slice(0, maxUntrackedChars)}\n…[+${body.length - maxUntrackedChars} chars]`;
    out += `\n+++ new file: ${f}\n${body}`;
  }
  const total = out.length;
  if (total > maxChars) out = `${out.slice(0, maxChars)}\n…[truncated ${total - maxChars} of ${total} chars; pass paths or raise max_chars]`;
  return out || "(no changes)";
}

/** Paths from `git status --porcelain -z`: "XY path\0", renames/copies add "\0orig". */
function porcelainPaths(z) {
  const parts = String(z || "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    out.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i += 1; // skip the original path
  }
  return out;
}

const SENSITIVE = [/(^|\/)\.env(\..*)?$/, /\.pem$/, /\.key$/, /(^|\/)id_[a-z0-9]+$/i, /\.p12$/, /credentials\.json$/];

/**
 * Safely merge an agent's worktree branch into the branch checked out at repoRoot.
 * Never switches branches; refuses on a dirty target, sensitive files, or predicted conflicts.
 */
export async function mergeWorktree({ worktree, targetBranch, strategy = "squash", message }) {
  const { repoRoot, root, branch } = worktree;

  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const current = head.stdout;
  if (current === "HEAD") return { merged: false, reason: "repo root is on a detached HEAD; check out the target branch first." };
  if (targetBranch && targetBranch !== current) {
    return { merged: false, reason: `target '${targetBranch}' is not the branch checked out at ${repoRoot} ('${current}'). Check it out yourself, then retry; this tool never switches branches.` };
  }
  const dirty = await git(["status", "--porcelain", "--untracked-files=no"], repoRoot);
  if (dirty.stdout) return { merged: false, reason: `repo root has uncommitted changes:\n${dirty.stdout}` };

  // 1. Refuse secrets: uncommitted files (every file inside new directories, unquoted names via -z)
  //    plus anything the worker already committed on its branch.
  const wtStatus = await git(["status", "--porcelain", "-z", "--untracked-files=all"], root);
  const committed = await git(["diff", "--name-only", "-z", `${current}...${branch}`], repoRoot, { allowFail: true });
  const paths = [...porcelainPaths(wtStatus.stdout), ...(committed.ok ? committed.stdout.split("\0").filter(Boolean) : [])];
  const risky = [...new Set(paths.filter((p) => SENSITIVE.some((re) => re.test(p))))];
  if (risky.length) {
    return { merged: false, reason: `worktree contains possibly sensitive files; remove or gitignore them first: ${risky.join(", ")}` };
  }

  // 2. Commit whatever the worker left uncommitted in its worktree.
  if (wtStatus.stdout) {
    await git(["add", "-A"], root);
    const hasIdentity = (await git(["config", "user.email"], root, { allowFail: true })).stdout;
    const idArgs = hasIdentity ? [] : ["-c", "user.name=agy-orchestrator", "-c", "user.email=agy-orchestrator@localhost"];
    await git([...idArgs, "commit", "-q", "-m", message || `agy: work from ${branch}`], root);
  }

  // 3. Anything to merge?
  const ahead = await git(["rev-list", "--count", `${current}..${branch}`], repoRoot);
  if (Number(ahead.stdout) === 0) return { merged: false, reason: "nothing to merge: branch has no commits beyond target." };

  // 4. Predict conflicts without touching any working tree.
  const mt = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", current, branch], repoRoot, { allowFail: true });
  if (!mt.ok) {
    const conflicts = mt.stdout.split("\n").slice(1).filter(Boolean);
    if (conflicts.length) return { merged: false, conflicts, reason: "merge would conflict; nothing was changed." };
    return { merged: false, reason: `merge-tree failed: ${mt.stderr}` };
  }

  // 5. Real merge.
  const files = (await git(["diff", "--name-only", `${current}...${branch}`], repoRoot)).stdout.split("\n").filter(Boolean);
  const hasIdentity = (await git(["config", "user.email"], repoRoot, { allowFail: true })).stdout;
  const idArgs = hasIdentity ? [] : ["-c", "user.name=agy-orchestrator", "-c", "user.email=agy-orchestrator@localhost"];
  const msg = message || `Merge ${branch}`;
  if (strategy === "merge") {
    const r = await git([...idArgs, "merge", "--no-ff", "-q", "-m", msg, branch], repoRoot, { allowFail: true });
    if (!r.ok) {
      await git(["merge", "--abort"], repoRoot, { allowFail: true });
      return { merged: false, reason: `merge failed and was aborted: ${r.stderr}` };
    }
  } else {
    const r = await git(["merge", "--squash", "-q", branch], repoRoot, { allowFail: true });
    const c = r.ok ? await git([...idArgs, "commit", "-q", "-m", msg], repoRoot, { allowFail: true }) : r;
    if (!c.ok) {
      await git(["reset", "--merge"], repoRoot, { allowFail: true });
      return { merged: false, reason: `squash merge failed and was rolled back: ${c.stderr}` };
    }
  }
  const sha = (await git(["rev-parse", "--short", "HEAD"], repoRoot)).stdout;
  return { merged: true, into: current, strategy, sha, files };
}
