// Git helpers: execFile only (no shell interpolation).
import { execFile } from "node:child_process";
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

function ensureExcluded(repoRoot) {
  try {
    const excludePath = path.join(repoRoot, ".git", "info", "exclude");
    if (!fs.existsSync(excludePath)) return;
    const content = fs.readFileSync(excludePath, "utf8");
    if (!content.split("\n").some((l) => l.trim() === ".agy-worktrees/")) {
      fs.appendFileSync(excludePath, `${content && !content.endsWith("\n") ? "\n" : ""}.agy-worktrees/\n`);
    }
  } catch {
    // non-fatal (.git may be a file in linked worktrees/submodules)
  }
}

export async function createWorktree(cwd, agentId, baseRef = "HEAD") {
  const repoRoot = await repoRootOf(cwd);
  if (!repoRoot) throw new Error(`use_worktree=true but '${cwd}' is not inside a git repository.`);
  const baseSha = await revParse(baseRef, repoRoot);
  if (!baseSha) throw new Error(`base_ref '${baseRef}' does not resolve to a commit.`);
  const rel = path.relative(repoRoot, path.resolve(cwd));
  const dir = path.join(repoRoot, ".agy-worktrees");
  fs.mkdirSync(dir, { recursive: true });
  ensureExcluded(repoRoot);
  const root = path.join(dir, agentId);
  const branch = `agy/${agentId}`;
  await git(["worktree", "add", "-b", branch, root, baseSha], repoRoot);
  const sub = rel && !rel.startsWith("..") ? path.join(root, rel) : root;
  return { repoRoot, root, branch, baseSha, cwd: fs.existsSync(sub) ? sub : root };
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

  // 1. Commit whatever the worker left uncommitted in its worktree.
  const wtStatus = await git(["status", "--porcelain"], root);
  if (wtStatus.stdout) {
    const paths = wtStatus.stdout.split("\n").map((l) => l.slice(3).split(" -> ").pop());
    const risky = paths.filter((p) => SENSITIVE.some((re) => re.test(p)));
    if (risky.length) {
      return { merged: false, reason: `worktree contains possibly sensitive files; remove or gitignore them first: ${risky.join(", ")}` };
    }
    await git(["add", "-A"], root);
    const hasIdentity = (await git(["config", "user.email"], root, { allowFail: true })).stdout;
    const idArgs = hasIdentity ? [] : ["-c", "user.name=agy-orchestrator", "-c", "user.email=agy-orchestrator@localhost"];
    await git([...idArgs, "commit", "-q", "-m", message || `agy: work from ${branch}`], root);
  }

  // 2. Anything to merge?
  const ahead = await git(["rev-list", "--count", `${current}..${branch}`], repoRoot);
  if (Number(ahead.stdout) === 0) return { merged: false, reason: "nothing to merge: branch has no commits beyond target." };

  // 3. Predict conflicts without touching any working tree.
  const mt = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", current, branch], repoRoot, { allowFail: true });
  if (!mt.ok) {
    const conflicts = mt.stdout.split("\n").slice(1).filter(Boolean);
    if (conflicts.length) return { merged: false, conflicts, reason: "merge would conflict; nothing was changed." };
    return { merged: false, reason: `merge-tree failed: ${mt.stderr}` };
  }

  // 4. Real merge.
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
