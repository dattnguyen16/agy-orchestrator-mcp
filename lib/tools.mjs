// MCP tool schemas (kept deliberately terse: they cost Claude context) and handlers.
import fs from "node:fs";
import path from "node:path";
import {
  ACTIVE, TERMINAL, allAgents, digest, getAgent, newAgentId, openWatch, registerAgent, removeAgent,
  reportOf, saveState, startTurn, stopAgent, totalUsage, waitForChange,
} from "./engine.mjs";
import { BACKEND_NAMES, backendNamed } from "./backends/index.mjs";
import { createWorktree, diffText, git, mergeWorktree, repoRootOf, revParse } from "./git.mjs";
import { openChanged, openDiff, showExternalWorktrees } from "./orca.mjs";
import { elapsedSeconds, oneLine } from "./util.mjs";

const FOOTER =
  "You run unattended: nobody can answer questions mid-task. If blocked, stop and list the blockers in open_questions.";

const ROLES = {
  coder: { mode: "accept-edits", preamble: "You are a coding worker. Make only the changes the task needs, follow the surrounding code style, do not commit." },
  tester: { mode: "accept-edits", skipPermissions: true, sandbox: true, preamble: "You are a test worker. Write or update tests for the task, run them, and report exact commands and results. Do not change production code unless told to." },
  reviewer: { mode: "plan", preamble: "You are a code reviewer. Do not edit files. Report concrete defects with file:line, severity and a suggested fix." },
  researcher: { mode: "plan", preamble: "You are a research worker. Do not edit files. Answer with evidence (file:line, command output)." },
};

const str = (description) => ({ type: "string", description });
const bool = (description) => ({ type: "boolean", description });
const num = (description) => ({ type: "number", description });
const ID = { agent_id: str("Agent id.") };

export const TOOLS = [
  {
    name: "agy_spawn",
    description: "Start worker(s) async. Top-level fields are defaults for each `tasks` item.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: str("Task brief."),
        tasks: { type: "array", description: "Fan-out.", items: { type: "object", properties: { prompt: { type: "string" }, name: { type: "string" }, role: { type: "string" }, backend: { type: "string" } }, required: ["prompt"] } },
        backend: { type: "string", enum: BACKEND_NAMES },
        name: str("Label."),
        role: { type: "string", enum: Object.keys(ROLES), description: "tester runs commands (sandboxed); reviewer/researcher read-only." },
        cwd: str("Absolute dir."),
        use_worktree: bool("Own git worktree/branch; use for parallel edits."),
        base_ref: str("Default HEAD."),
        verify_cmd: str("Check run after each turn; failures go back to the worker."),
        max_fix_rounds: num("Default 2."),
        model: { type: "string" },
        mode: { type: "string", enum: ["accept-edits", "auto", "plan"] },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
        skip_permissions: bool("Allow shell commands (denied headless otherwise)."),
        sandbox: { type: "boolean" },
        network: { type: "boolean" },
        timeout_seconds: { type: "number" },
        watch: bool("Live log terminal in Orca."),
        json_schema: str("Replaces the default report schema."),
      },
    },
  },
  {
    name: "agy_wait",
    description: "Block until workers finish or need attention; returns each report once. timeout_seconds=0 = snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        agent_ids: { type: "array", items: { type: "string" }, description: "Default: active + unreported." },
        wait_for: { type: "string", enum: ["any", "all"] },
        timeout_seconds: num("0-300, default 120."),
      },
    },
  },
  {
    name: "agy_result",
    description: "Worker output. orca_open shows changes to the user in Orca.",
    inputSchema: {
      type: "object",
      properties: {
        ...ID,
        view: { type: "string", enum: ["report", "full", "diff", "events"] },
        paths: { type: "array", items: { type: "string" }, },
        max_chars: num("Default 8000."),
        orca_open: str("'changed' or a file path."),
      },
      required: ["agent_id"],
    },
  },
  {
    name: "agy_instruct",
    description: "Follow-up in the same conversation.",
    inputSchema: {
      type: "object",
      properties: {
        ...ID,
        prompt: { type: "string" },
        interrupt: bool("Stop the running turn first."),
        mode: { type: "string", enum: ["accept-edits", "auto", "plan"] },
        model: { type: "string" },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
        timeout_seconds: { type: "number" },
      },
      required: ["agent_id", "prompt"],
    },
  },
  {
    name: "agy_stop",
    description: "Stop or dequeue a worker.",
    inputSchema: { type: "object", properties: ID, required: ["agent_id"] },
  },
  {
    name: "agy_list",
    description: "One line per worker.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["all", "active", "done"] } } },
  },
  {
    name: "agy_merge",
    description: "Commit a worktree worker's changes and merge into the checked-out branch. Refuses on dirty target, secrets or conflicts.",
    inputSchema: {
      type: "object",
      properties: {
        ...ID,
        strategy: { type: "string", enum: ["squash", "merge"], },
        message: { type: "string" },
        target_branch: str("Must be the checked-out branch."),
      },
      required: ["agent_id"],
    },
  },
  {
    name: "agy_cleanup",
    description: "Forget a finished worker and remove its worktree.",
    inputSchema: {
      type: "object",
      properties: {
        ...ID,
        remove_worktree: { type: "boolean" },
        delete_branch: { type: "boolean" },
        force: { type: "boolean" },
      },
      required: ["agent_id"],
    },
  },
];

// ---------------------------------------------------------------------------

function buildPrompt(role, prompt, config) {
  const lines = [];
  if (role && ROLES[role]) lines.push(ROLES[role].preamble);
  lines.push(FOOTER);
  // Sandbox / shell rules differ per CLI (headless agy aborts the turn on a denied command).
  lines.push(...backendNamed(config.backend).promptRules(config));
  return `${lines.join("\n")}\n\nTask:\n${prompt}`;
}

function buildConfig(spec) {
  const preset = (spec.role && ROLES[spec.role]) || {};
  const skip = spec.skip_permissions ?? spec.dangerously_skip_permissions;
  const backend = backendNamed(spec.backend);
  return {
    backend: backend.name,
    network: Boolean(spec.network),
    model: spec.model || null,
    mode: spec.mode || preset.mode || "accept-edits",
    effort: spec.effort || null,
    skipPermissions: skip ?? preset.skipPermissions ?? false,
    // null = not specified. codex drops its sandbox only on an explicit `sandbox: false`.
    sandbox: spec.sandbox ?? preset.sandbox ?? null,
    addDirs: Array.isArray(spec.add_dirs) ? spec.add_dirs : [],
    jsonSchema: spec.json_schema || null,
    report: spec.report !== false,
    timeoutSeconds: Number(spec.timeout_seconds) || 0,
    verifyCmd: spec.verify_cmd || null,
    maxFixRounds: spec.max_fix_rounds ?? 2,
    verifyTimeoutSeconds: Number(spec.verify_timeout_seconds) || 600,
    stallSeconds: spec.stall_seconds ?? backend.defaultStallSeconds,
    watch: Boolean(spec.watch),
  };
}

async function spawnOne(spec) {
  if (!spec.prompt || typeof spec.prompt !== "string") throw new Error("Each task needs a string 'prompt'.");
  const requestedCwd = path.resolve(spec.cwd || process.cwd());
  if (!fs.existsSync(requestedCwd)) throw new Error(`cwd does not exist: ${requestedCwd}`);
  const id = newAgentId(spec.name || spec.role || "worker");
  const warnings = [];
  let worktree = null;
  let cwd = requestedCwd;
  let baseSha = null;
  if (spec.use_worktree) {
    const wt = await createWorktree(requestedCwd, id, spec.base_ref || "HEAD");
    worktree = { repoRoot: wt.repoRoot, root: wt.root, branch: wt.branch };
    cwd = wt.cwd;
    baseSha = wt.baseSha;
    const r = await showExternalWorktrees(wt.repoRoot);
    if (r.warning) warnings.push(r.warning);
  } else if (await repoRootOf(requestedCwd)) {
    baseSha = await revParse("HEAD", requestedCwd);
  }
  const agent = registerAgent({
    id, name: spec.name, role: spec.role, cwd, originalCwd: requestedCwd, worktree, baseSha, config: buildConfig(spec),
  });
  startTurn(agent, buildPrompt(spec.role, spec.prompt, agent.config), "task");
  if (agent.config.watch && agent.status === "running") {
    const r = await openWatch(agent);
    if (r.warning) warnings.push(r.warning);
  }
  return { id, status: agent.status, branch: worktree?.branch, warnings };
}

function flagSig(a) {
  return Object.keys(a.flags).sort().join(",");
}

function listLine(a) {
  const bits = [a.id, a.status];
  if (a.config?.backend && a.config.backend !== "agy") bits.push(a.config.backend);
  if (a.turnCount) bits.push(`t${a.turnCount}`);
  if (a.turnStartedAt) bits.push(`${elapsedSeconds(a.turnStartedAt, a.turnFinishedAt)}s`);
  if (a.worktree) bits.push(a.worktree.branch);
  const flags = Object.keys(a.flags);
  if (flags.length) bits.push(`[${flags.join(",")}]`);
  const tail = TERMINAL.has(a.status) ? a.changes || a.error || "" : a.events[a.events.length - 1]?.text || "";
  return `${bits.join(" ")}${tail ? ` — ${oneLine(tail, 100)}` : ""}`;
}

export async function handleToolCall(name, args = {}) {
  switch (name) {
    case "agy_spawn": {
      const { tasks, ...defaults } = args;
      const specs = Array.isArray(tasks) && tasks.length ? tasks.map((t) => ({ ...defaults, ...t })) : [defaults];
      const spawned = [];
      for (const spec of specs) {
        try {
          spawned.push(await spawnOne(spec));
        } catch (err) {
          spawned.push({ name: spec.name, error: err.message });
        }
      }
      return { spawned };
    }

    case "agy_wait":
    case "agy_status": {
      const explicit = Array.isArray(args.agent_ids) && args.agent_ids.length
        ? args.agent_ids
        : args.agent_id ? [args.agent_id] : null;
      const targets = explicit
        ? explicit.map(getAgent)
        : allAgents().filter((a) => ACTIVE.has(a.status) || (TERMINAL.has(a.status) && !a.reported));
      if (!targets.length) return { agents: [], note: "no active or unreported workers" };
      const waitFor = args.wait_for === "all" ? "all" : "any";
      const timeoutSec = name === "agy_status" ? 0 : Math.min(300, Math.max(0, Number(args.timeout_seconds ?? 120)));
      const before = new Map(targets.map((a) => [a.id, flagSig(a)]));
      const newAttention = () => targets.some((a) => flagSig(a) !== before.get(a.id) && Object.keys(a.flags).length);
      const done = (a) => TERMINAL.has(a.status);
      // "any" wakes on a worker with an undelivered report; ones already reported carry no news,
      // so passing their ids must not make every wait return at once (and invite polling).
      const fresh = (a) => done(a) && !a.reported;
      const predicate = () =>
        newAttention() || targets.every(done) || (waitFor === "any" && targets.some(fresh));
      const timedOut = timeoutSec > 0 ? await waitForChange(targets, predicate, timeoutSec * 1000) : !predicate();
      return { timed_out: timedOut, agents: targets.map((a) => digest(a)) };
    }

    case "agy_result": {
      const agent = getAgent(args.agent_id);
      const view = args.view || "report";
      const maxChars = Number(args.max_chars) || 8000;
      const out = {};
      if (args.orca_open) {
        const r = args.orca_open === "changed" ? await openChanged(agent.cwd) : await openDiff(agent.cwd, args.orca_open);
        out.orca = r.warning || "opened";
      }
      if (view === "diff") {
        const text = await diffText(agent.cwd, agent.baseSha, { paths: args.paths || [], maxChars });
        return out.orca ? `[orca: ${out.orca}]\n${text}` : text;
      }
      if (view === "events") {
        return agent.events.slice(-30).map((e) => `${e.ts.slice(11, 19)} ${e.text}`).join("\n") || "(no events)";
      }
      if (view === "full") {
        const turn = [...agent.turns].reverse().find((t) => t.sawResult);
        const text = String(turn?.response ?? "");
        return {
          ...out, id: agent.id, status: agent.status,
          response: text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars; log: ${agent.logFile}]` : text,
        };
      }
      agent.reported = TERMINAL.has(agent.status) ? true : agent.reported;
      saveState();
      return {
        ...out,
        id: agent.id,
        name: agent.name,
        status: agent.status,
        branch: agent.worktree?.branch,
        cwd: agent.cwd,
        turns: agent.turnCount,
        agy_tokens: totalUsage(agent),
        report: reportOf(agent),
        changes: agent.changes,
        verify: agent.verify ? (agent.verify.ok ? "pass" : { code: agent.verify.code, round: agent.verify.round, tail: agent.verify.tail.join("\n") }) : undefined,
        flags: Object.entries(agent.flags).map(([k, v]) => `${k}: ${v}`),
        error: agent.error,
        warnings: agent.warnings,
      };
    }

    case "agy_instruct": {
      const agent = getAgent(args.agent_id);
      if (!args.prompt || typeof args.prompt !== "string") throw new Error("Missing 'prompt'.");
      if (agent.status === "queued") throw new Error(`'${agent.id}' is still queued; stop it or wait.`);
      if (agent.status === "running" || agent.status === "verifying") {
        if (!args.interrupt) throw new Error(`'${agent.id}' is ${agent.status}. Use agy_wait, or interrupt=true to redirect now.`);
        await stopAgent(agent);
      }
      agent.fixRound = 0;
      agent.verify = null;
      const resumed = Boolean(agent.conversationId);
      startTurn(agent, args.prompt, "instruct", {
        mode: args.mode, model: args.model, effort: args.effort,
        timeoutSeconds: args.timeout_seconds != null ? Number(args.timeout_seconds) : undefined,
      });
      return { id: agent.id, status: agent.status, turn: agent.turnCount, resumed };
    }

    case "agy_stop": {
      const agent = getAgent(args.agent_id);
      await stopAgent(agent);
      return { id: agent.id, status: agent.status };
    }

    case "agy_list": {
      const f = args.status || args.status_filter || "all";
      const rows = allAgents().filter((a) => f === "all" || (f === "active" ? ACTIVE.has(a.status) : f === "done" ? TERMINAL.has(a.status) : a.status === f));
      return rows.length ? rows.map(listLine).join("\n") : "(no workers)";
    }

    case "agy_merge": {
      const agent = getAgent(args.agent_id);
      if (!agent.worktree) throw new Error("agy_merge needs a worker started with use_worktree=true.");
      if (!TERMINAL.has(agent.status)) throw new Error(`'${agent.id}' is ${agent.status}; wait for it to finish.`);
      const rep = reportOf(agent);
      const summary = rep?.summary ? oneLine(String(rep.summary).split("\n")[0], 72) : oneLine(agent.turns[0]?.prompt.split("Task:\n").pop() || "", 60);
      const label = agent.name !== agent.id ? agent.name : agent.role || "worker";
      const message = args.message || `agy(${label}): ${summary}`;
      const result = await mergeWorktree({ worktree: agent.worktree, targetBranch: args.target_branch, strategy: args.strategy || "squash", message });
      if (result.merged) {
        // Squash merges never make the branch an ancestor; remember it so cleanup can delete it.
        agent.merged = { sha: result.sha, into: result.into, at: new Date().toISOString() };
        saveState();
      }
      return result;
    }

    case "agy_cleanup": {
      const agent = getAgent(args.agent_id);
      if (ACTIVE.has(agent.status)) throw new Error(`'${agent.id}' is ${agent.status}; agy_stop it first.`);
      const actions = [];
      const force = Boolean(args.force);
      if (agent.worktree && args.remove_worktree !== false && fs.existsSync(agent.worktree.root)) {
        await git(["worktree", "remove", ...(force ? ["--force"] : []), agent.worktree.root], agent.worktree.repoRoot);
        actions.push("worktree removed");
      }
      if (agent.worktree && args.delete_branch) {
        await git(["branch", force || agent.merged ? "-D" : "-d", agent.worktree.branch], agent.worktree.repoRoot);
        actions.push(`branch ${agent.worktree.branch} deleted`);
      }
      removeAgent(agent);
      actions.push("forgotten");
      return { id: agent.id, actions };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export const SERVER_INSTRUCTIONS = [
  "Delegate to Antigravity or Codex workers: agy_spawn (role + short brief; backend=codex for Codex; tasks[] to fan out; use_worktree for parallel edits; verify_cmd so the server tests and auto-fixes).",
  "Then agy_wait: it blocks, and returns each finished worker's report + change summary once. Don't poll.",
  "Read agy_result view=diff only when the report or verify result is doubtful. Fix via agy_instruct (same conversation).",
  "Finish with agy_merge then agy_cleanup. watch / orca_open show work to the user in Orca IDE.",
].join(" ");
