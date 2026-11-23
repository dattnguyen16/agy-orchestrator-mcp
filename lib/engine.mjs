// Agent registry + execution engine.
// Workers run detached and write stream-json straight to a per-agent log file; the server
// tails that file. Live and restarted-server workers therefore share one code path.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEvent, progressLine } from "./events.mjs";
import { changeSummary } from "./git.mjs";
import { openWatchTerminal } from "./orca.mjs";
import { createStore } from "./state.mjs";
import { buildChildEnv, elapsedSeconds, isPidAlive, killGroup, nowIso, oneLine, relTo, tailFile, truncate } from "./util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOG_DIR = process.env.AGY_LOG_DIR || path.join(ROOT, "logs");
const STATE_DIR = process.env.AGY_STATE_DIR || path.join(ROOT, "state");
const MAX_CONCURRENT = Math.max(1, Number(process.env.AGY_MAX_CONCURRENT) || 4);
const RETENTION_DAYS = Number(process.env.AGY_RETENTION_DAYS) || 7;
const TICK_MS = 1000;
const TAIL_SCRIPT = path.join(ROOT, "bin", "agy-tail.mjs");

export const ACTIVE = new Set(["queued", "running", "verifying"]);
export const TERMINAL = new Set(["completed", "needs_attention", "failed", "stopped", "interrupted"]);

export const DEFAULT_REPORT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "At most 5 short lines: what you did and the outcome." },
    files_changed: { type: "array", items: { type: "string" } },
    commands_run: { type: "array", items: { type: "string" } },
    tests: { type: "string", description: "What you ran to check the work and the result, or 'not run'." },
    open_questions: { type: "array", items: { type: "string" }, description: "Blockers or decisions you could not make." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["summary", "files_changed", "tests", "confidence"],
};

const agents = new Map();
const store = createStore(STATE_DIR);
store.bind(() => [...agents.values()]);

export function resolveAgyBin() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  const local = path.join(process.env.HOME || "", ".local", "bin", "agy");
  return fs.existsSync(local) ? local : "agy";
}

export function newAgentId(name) {
  const slug = String(name || "worker").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "worker";
  return `agy-${slug}-${crypto.randomBytes(3).toString("hex")}`;
}

export function getAgent(id) {
  const a = agents.get(id);
  if (!a) throw new Error(`Unknown agent_id '${id}'. Call agy_list to see agents.`);
  return a;
}
export const allAgents = () => [...agents.values()];
export const saveState = () => store.save();

function notify(agent) {
  agent.updatedAt = nowIso();
  for (const fn of agent.waiters) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
  store.save();
}

function activeCount() {
  let n = 0;
  for (const a of agents.values()) if (a.status === "running" || a.status === "verifying") n += 1;
  return n;
}

function appendMarker(agent, obj) {
  try {
    fs.appendFileSync(agent.logFile, `${JSON.stringify({ ...obj, ts: nowIso() })}\n`);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Agent creation
// ---------------------------------------------------------------------------

export function registerAgent({ id, name, role, cwd, originalCwd, worktree, baseSha, config }) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const agent = {
    id,
    name: name || id,
    role: role || null,
    status: "queued",
    cwd,
    originalCwd,
    worktree,
    baseSha,
    conversationId: null,
    model: null,
    config,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    turnStartedAt: null,
    turnFinishedAt: null,
    pid: null,
    logFile: path.join(LOG_DIR, `${id}.ndjson`),
    errFile: path.join(LOG_DIR, `${id}.stderr`),
    verifyFile: path.join(LOG_DIR, `${id}.verify.log`),
    logOffset: 0,
    turnCount: 0,
    turns: [],
    events: [],
    flags: {},
    loop: { sig: null, count: 0 },
    said: null,
    saidStep: null,
    lastEventAt: null,
    error: null,
    fixRound: 0,
    verify: null,
    changes: null,
    reported: false,
    pending: null,
    stopRequested: false,
    warnings: [],
    // transient
    child: null,
    verifyChild: null,
    waiters: new Set(),
    partial: "",
  };
  agents.set(id, agent);
  return agent;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function buildAgyArgs(agent, overrides) {
  const c = { ...agent.config, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v != null)) };
  const args = ["--output-format", "stream-json"];
  if (agent.conversationId) args.push("--conversation", agent.conversationId);
  if (c.mode) args.push("--mode", c.mode);
  // --disable-slash-commands makes --mode plan a no-op (agy warns), so only use it outside plan mode.
  if (c.mode !== "plan") args.push("--disable-slash-commands");
  if (c.model) args.push("--model", c.model);
  if (c.effort) args.push("--effort", c.effort);
  if (c.skipPermissions) args.push("--dangerously-skip-permissions");
  if (c.sandbox) args.push("--sandbox");
  for (const d of c.addDirs || []) if (d) args.push("--add-dir", d);
  const schema = c.jsonSchema || (c.report !== false ? JSON.stringify(DEFAULT_REPORT_SCHEMA) : null);
  if (schema) args.push("--json-schema", schema);
  if (c.timeoutSeconds > 0) args.push("--print-timeout", `${Math.ceil(c.timeoutSeconds)}s`);
  return { args, timeoutSeconds: c.timeoutSeconds || 0 };
}

/** Start (or queue) a turn. `kind`: task | instruct | fix. */
export function startTurn(agent, prompt, kind = "task", overrides = {}) {
  const holdsSlot = agent.status === "running" || agent.status === "verifying";
  if (!holdsSlot && activeCount() >= MAX_CONCURRENT) {
    agent.status = "queued";
    agent.pending = { prompt, kind, overrides };
    notify(agent);
    return;
  }
  agent.pending = null;

  const { args, timeoutSeconds } = buildAgyArgs(agent, overrides);
  const safePrompt = prompt.startsWith("-") ? ` ${prompt}` : prompt;
  args.push("-p", safePrompt);

  const turnNum = agent.turnCount + 1;
  agent.turnCount = turnNum;
  agent.status = "running";
  agent.turnStartedAt = nowIso();
  agent.turnFinishedAt = null;
  agent.lastEventAt = agent.turnStartedAt;
  agent.error = null;
  agent.stopRequested = false;
  agent.reported = false;
  agent.flags = {};
  agent.loop = { sig: null, count: 0 };
  agent.said = null;
  agent.timeoutSeconds = timeoutSeconds;
  const turn = {
    turn: turnNum,
    kind,
    prompt: truncate(prompt, 300),
    startedAt: agent.turnStartedAt,
    finishedAt: null,
    status: "running",
    exitCode: null,
    sawResult: false,
  };
  agent.turns.push(turn);
  appendMarker(agent, { event: "turn_start", turn: turnNum, text: `turn ${turnNum} (${kind})` });
  // Skip the marker we just wrote so the tailer doesn't double count it.
  try {
    agent.logOffset = fs.statSync(agent.logFile).size;
  } catch {
    agent.logOffset = 0;
  }
  agent.partial = "";
  agent.events.push({ ts: nowIso(), kind: "turn_start", text: `turn ${turnNum} (${kind})` });

  let outFd;
  let errFd;
  try {
    outFd = fs.openSync(agent.logFile, "a");
    errFd = fs.openSync(agent.errFile, "a");
    const child = spawn(resolveAgyBin(), args, {
      cwd: agent.cwd,
      env: buildChildEnv(),
      detached: true,
      stdio: ["ignore", outFd, errFd],
    });
    agent.child = child;
    agent.pid = child.pid ?? null;
    child.unref();
    child.on("error", (err) => {
      agent.error = `spawn error: ${err.message}`;
      finalizeTurn(agent, null, null).catch(() => {});
    });
    child.on("exit", (code, signal) => {
      drainLog(agent);
      finalizeTurn(agent, code, signal).catch(() => {});
    });
  } catch (err) {
    agent.error = `Failed to spawn agy: ${err.message}`;
    finalizeTurn(agent, null, null).catch(() => {});
  } finally {
    if (outFd !== undefined) fs.closeSync(outFd);
    if (errFd !== undefined) fs.closeSync(errFd);
  }
  notify(agent);
}

function drainLog(agent) {
  let size;
  try {
    size = fs.statSync(agent.logFile).size;
  } catch {
    return;
  }
  if (size <= agent.logOffset) return;
  const fd = fs.openSync(agent.logFile, "r");
  let chunk;
  try {
    const buf = Buffer.alloc(size - agent.logOffset);
    fs.readSync(fd, buf, 0, buf.length, agent.logOffset);
    chunk = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  agent.logOffset = size;
  const text = (agent.partial || "") + chunk;
  const lines = text.split("\n");
  agent.partial = lines.pop() || "";
  processLines(agent, lines);
}

function processLines(agent, lines) {
  let changed = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      agent.events.push({ ts: nowIso(), kind: "raw", text: oneLine(t, 120) });
      continue;
    }
    if (applyEvent(agent, obj).flagsChanged) changed = true;
  }
  if (changed) notify(agent);
}

function isSuccessStatus(s) {
  return !s || !["ERROR", "FAILED", "CANCELED", "CANCELLED", "TIMEOUT"].includes(String(s).toUpperCase());
}

async function finalizeTurn(agent, code, signal) {
  const turn = agent.turns[agent.turns.length - 1];
  if (!turn || turn.finishedAt) return;
  turn.finishedAt = nowIso();
  turn.exitCode = code;
  agent.child = null;
  agent.pid = null;
  agent.turnFinishedAt = turn.finishedAt;
  drainLog(agent);
  if (agent.partial) {
    // Final line without a trailing newline.
    const last = agent.partial;
    agent.partial = "";
    processLines(agent, [last]);
  }

  let outcome;
  if (agent.stopRequested) outcome = "stopped";
  else if (turn.sawResult && isSuccessStatus(turn.resultStatus) && (code === 0 || code === null)) outcome = "ok";
  else if (!turn.sawResult && code === null && !signal && !agent.error) outcome = "interrupted";
  else outcome = "failed";

  if (outcome === "failed" && !agent.error) {
    const errTail = tailFile(agent.errFile, 3).join(" | ");
    agent.error = oneLine(
      `exit=${code}${signal ? ` signal=${signal}` : ""}${turn.resultStatus ? ` status=${turn.resultStatus}` : ""}${errTail ? ` :: ${errTail}` : ""}`,
      300
    );
  }
  // With verify_cmd the server checks the work itself, so a denied shell command is not worth waking Claude for.
  if (turn.denied && !agent.config.verifyCmd) {
    agent.flags.denied = `${turn.denied} denied in headless mode; re-run with skip_permissions (+sandbox/worktree)`;
  }

  if (agent.baseSha) {
    agent.changes = await changeSummary(agent.cwd, agent.baseSha).catch(() => null);
  }

  if (outcome === "ok" && agent.config.verifyCmd && !agent.stopRequested) {
    turn.status = "completed";
    runVerify(agent);
    return;
  }
  turn.status = outcome === "ok" ? "completed" : outcome;
  setTerminal(agent, outcome === "ok" ? (agent.flags.denied ? "needs_attention" : "completed") : outcome);
}

function setTerminal(agent, status) {
  agent.status = status;
  agent.turnFinishedAt = agent.turnFinishedAt || nowIso();
  agent.reported = false;
  if (status === "completed") delete agent.flags.stalled;
  notify(agent);
  schedule();
}

function schedule() {
  const queued = [...agents.values()].filter((a) => a.status === "queued" && a.pending).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const a of queued) {
    if (activeCount() >= MAX_CONCURRENT) break;
    const { prompt, kind, overrides } = a.pending;
    startTurn(a, prompt, kind, overrides);
    if (a.status === "running" && a.config.watch && a.turnCount === 1) openWatch(a);
  }
}

// ---------------------------------------------------------------------------
// Verify + auto-fix
// ---------------------------------------------------------------------------

function runVerify(agent) {
  agent.status = "verifying";
  notify(agent);
  const cmd = agent.config.verifyCmd;
  const timeoutSec = agent.config.verifyTimeoutSeconds || 600;
  let fd;
  try {
    fd = fs.openSync(agent.verifyFile, "w");
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: agent.cwd,
      env: buildChildEnv(),
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    agent.verifyChild = child;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      setTimeout(() => killGroup(child.pid, "SIGKILL"), 3000).unref();
    }, timeoutSec * 1000);
    child.on("error", () => {});
    child.on("exit", (code) => {
      clearTimeout(timer);
      agent.verifyChild = null;
      onVerifyDone(agent, { code, timedOut });
    });
  } catch (err) {
    agent.verifyChild = null;
    onVerifyDone(agent, { code: null, timedOut: false, error: err.message });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function onVerifyDone(agent, { code, timedOut, error }) {
  if (agent.stopRequested) {
    setTerminal(agent, "stopped");
    return;
  }
  const ok = code === 0 && !timedOut && !error;
  const tail = ok ? [] : tailFile(agent.verifyFile, 80);
  agent.verify = { ok, code, round: agent.fixRound, timedOut: timedOut || undefined, error, tail };
  appendMarker(agent, { event: "verify", text: `verify ${ok ? "pass" : "FAIL"} (exit ${code}${timedOut ? ", timed out" : ""})` });
  agent.events.push({ ts: nowIso(), kind: "verify", text: `verify ${ok ? "pass" : "FAIL"} (exit ${code})` });
  agent.logOffset = (() => {
    try {
      return fs.statSync(agent.logFile).size;
    } catch {
      return agent.logOffset;
    }
  })();

  if (ok) {
    setTerminal(agent, agent.flags.denied ? "needs_attention" : "completed");
    return;
  }
  const max = agent.config.maxFixRounds ?? 2;
  if (agent.fixRound < max) {
    agent.fixRound += 1;
    const fixPrompt =
      `The verification command \`${agent.config.verifyCmd}\` failed (exit ${code}${timedOut ? ", timed out" : ""}). ` +
      `Fix the root cause with minimal changes; do not weaken or skip the checks. Last output:\n\`\`\`\n${tail.join("\n")}\n\`\`\``;
    startTurn(agent, fixPrompt, "fix");
    return;
  }
  setTerminal(agent, "needs_attention");
}

// ---------------------------------------------------------------------------
// Stop / wait helpers
// ---------------------------------------------------------------------------

export function waitForChange(agentList, predicate, timeoutMs) {
  if (predicate()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const cleanups = [];
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const c of cleanups) c();
      resolve(timedOut);
    };
    const onUpdate = () => {
      if (predicate()) finish(false);
    };
    for (const a of agentList) {
      a.waiters.add(onUpdate);
      cleanups.push(() => a.waiters.delete(onUpdate));
    }
    const timer = setTimeout(() => finish(true), timeoutMs);
  });
}

export async function stopAgent(agent) {
  if (agent.status === "queued") {
    agent.pending = null;
    agent.stopRequested = true;
    setTerminal(agent, "stopped");
    return;
  }
  if (agent.status === "verifying" && agent.verifyChild) {
    agent.stopRequested = true;
    killGroup(agent.verifyChild.pid, "SIGTERM");
    await waitForChange([agent], () => TERMINAL.has(agent.status), 4000);
    if (agent.verifyChild) killGroup(agent.verifyChild.pid, "SIGKILL");
    return;
  }
  if (agent.status !== "running" || !agent.pid) return;
  agent.stopRequested = true;
  const pid = agent.pid;
  killGroup(pid, "SIGTERM");
  const turn = agent.turns[agent.turns.length - 1];
  const timedOut = await waitForChange([agent], () => Boolean(turn?.finishedAt), 3000);
  if (timedOut) {
    killGroup(pid, "SIGKILL");
    if (!agent.child) {
      // recovered agent: no exit event will arrive; finalize ourselves
      await finalizeTurn(agent, null, "SIGKILL");
    } else {
      await waitForChange([agent], () => Boolean(turn?.finishedAt), 2000);
    }
  }
}

// ---------------------------------------------------------------------------
// Orca live view
// ---------------------------------------------------------------------------

export async function openWatch(agent) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const r = await openWatchTerminal({
    cwd: agent.cwd,
    title: `agy:${agent.name}`,
    command: `${q(process.execPath)} ${q(TAIL_SCRIPT)} ${q(agent.logFile)}`,
  });
  if (r.warning) agent.warnings.push(r.warning);
  return r;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function reportOf(agent) {
  const turn = [...agent.turns].reverse().find((t) => t.sawResult);
  if (!turn) return null;
  if (turn.structured && typeof turn.structured === "object") {
    const r = { ...turn.structured };
    if (Array.isArray(r.files_changed)) r.files_changed = r.files_changed.map((f) => relTo(agent.cwd, f));
    return r;
  }
  if (turn.structured) return turn.structured;
  const text = String(turn.response || "").trim();
  return text ? { text: text.length > 800 ? `…${text.slice(-800)}` : text } : null;
}

export function totalUsage(agent) {
  let total = 0;
  for (const t of agent.turns) total += t.usage?.total_tokens || 0;
  return total || undefined;
}

function flagList(agent) {
  return Object.entries(agent.flags).map(([k, v]) => `${k}: ${v}`);
}

/** One compact line-ish object per agent; includes the report once when finished. */
export function digest(agent, { includeReport = true } = {}) {
  const done = TERMINAL.has(agent.status);
  const d = {
    id: agent.id,
    status: agent.status,
    turn: agent.turnCount || undefined,
    secs: agent.turnStartedAt ? elapsedSeconds(agent.turnStartedAt, agent.turnFinishedAt) : undefined,
    fix: agent.fixRound ? `${agent.fixRound}/${agent.config.maxFixRounds ?? 2}` : undefined,
    last: done ? undefined : progressLine(agent),
    flags: flagList(agent),
    error: agent.error,
  };
  if (done && includeReport && !agent.reported) {
    d.report = reportOf(agent);
    d.changes = agent.changes;
    if (agent.verify) d.verify = agent.verify.ok ? "pass" : { code: agent.verify.code, tail: agent.verify.tail.slice(-30).join("\n") };
    if (agent.status === "failed") d.stderr = tailFile(agent.errFile, 5).join("\n");
    agent.reported = true;
    store.save();
  } else if (done && agent.verify) {
    d.verify = agent.verify.ok ? "pass" : "fail";
  }
  return d;
}

// ---------------------------------------------------------------------------
// Lifecycle: restore, tick, shutdown
// ---------------------------------------------------------------------------

export function removeAgent(agent) {
  agents.delete(agent.id);
  store.save();
}

function restore() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  for (const saved of store.load()) {
    const agent = { ...saved, child: null, verifyChild: null, waiters: new Set(), partial: saved.partial || "" };
    const finishedLongAgo = TERMINAL.has(agent.status) && Date.parse(agent.turnFinishedAt || agent.updatedAt) < cutoff;
    if (finishedLongAgo && !agent.worktree) {
      for (const f of [agent.logFile, agent.errFile, agent.verifyFile]) fs.rmSync(f, { force: true });
      continue;
    }
    if (agent.status === "verifying") {
      agent.status = "needs_attention";
      agent.error = "verification was interrupted by a server restart; re-run it or agy_instruct";
    } else if (agent.status === "running" && !isPidAlive(agent.pid)) {
      // Drain whatever the worker wrote while we were gone, then decide.
      agents.set(agent.id, agent);
      drainLog(agent);
      const turn = agent.turns[agent.turns.length - 1];
      if (turn && !turn.finishedAt) {
        turn.finishedAt = nowIso();
        agent.turnFinishedAt = turn.finishedAt;
        agent.pid = null;
        if (turn.sawResult && isSuccessStatus(turn.resultStatus)) {
          turn.status = "completed";
          agent.status = agent.config.verifyCmd ? "needs_attention" : "completed";
          if (agent.config.verifyCmd) agent.error = "finished while server was down; verify_cmd was not run";
        } else {
          turn.status = "interrupted";
          agent.status = "interrupted";
        }
      }
    }
    agents.set(agent.id, agent);
  }
  store.save();
}

function tick() {
  for (const agent of agents.values()) {
    if (agent.status !== "running") continue;
    drainLog(agent);
    // Recovered worker (no child handle): detect exit by pid.
    if (!agent.child && agent.pid && !isPidAlive(agent.pid)) {
      drainLog(agent);
      finalizeTurn(agent, null, null).catch(() => {});
      continue;
    }
    const startedMs = Date.parse(agent.turnStartedAt);
    if (agent.timeoutSeconds > 0 && Date.now() - startedMs > (agent.timeoutSeconds + 5) * 1000 && !agent.stopRequested) {
      agent.error = `timed out after ${agent.timeoutSeconds}s`;
      killGroup(agent.pid, "SIGTERM");
      setTimeout(() => agent.pid && killGroup(agent.pid, "SIGKILL"), 3000).unref();
      continue;
    }
    const stallSec = agent.config.stallSeconds ?? 180;
    const quietMs = Date.now() - Date.parse(agent.lastEventAt || agent.turnStartedAt);
    if (stallSec > 0 && quietMs > stallSec * 1000 && !agent.flags.stalled) {
      agent.flags.stalled = `no output for ${Math.round(quietMs / 1000)}s`;
      notify(agent);
    }
  }
}

export function init() {
  restore();
  schedule();
  setInterval(tick, TICK_MS).unref();
}

export async function shutdown() {
  if (process.env.AGY_KILL_ON_EXIT === "1") {
    await Promise.all([...agents.values()].filter((a) => a.status === "running" || a.status === "verifying").map((a) => stopAgent(a)));
  }
  store.flush();
}
