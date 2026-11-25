// OpenAI Codex CLI backend: `codex exec --json ...`, follow-ups via `codex exec resume <thread_id>`.
// Real event schema (codex-cli 0.169, see test/fixtures/codex-*.ndjson):
//   {"type":"thread.started","thread_id":..}  {"type":"turn.started"}
//   {"type":"item.started|item.completed","item":{id,type:agent_message|command_execution|file_change|mcp_tool_call|web_search|reasoning|error,..}}
//   {"type":"turn.completed","usage":{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}
//   {"type":"turn.failed","error":{message}}   {"type":"error","message":..}
// Server-written markers share the file: {"event":"turn_start|verify|note","text":..}.
import fs from "node:fs";
import path from "node:path";
import { pushMilestone, recordTool, touch, trackLoop } from "../events.mjs";
import { oneLine, relTo } from "../util.mjs";

export const name = "codex";
// Codex emits reasoning only once it is complete, so long thinking looks silent.
export const defaultStallSeconds = 300;

// OpenAI structured outputs are strict: every property required, no extra keys. Optional fields are nullable.
export const STRICT_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "At most 5 short lines: what you did and the outcome." },
    files_changed: { type: "array", items: { type: "string" } },
    commands_run: { type: ["array", "null"], items: { type: "string" } },
    tests: { type: "string", description: "What you ran to check the work and the result, or 'not run'." },
    open_questions: { type: ["array", "null"], items: { type: "string" }, description: "Blockers or decisions you could not make." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["summary", "files_changed", "commands_run", "tests", "open_questions", "confidence"],
};

const EFFORT = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

export function bin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const local = path.join(process.env.HOME || "", ".local", "bin", "codex");
  return fs.existsSync(local) ? local : "codex";
}

/**
 * Map the orchestrator's generic config to a Codex sandbox policy.
 *
 * Inputs (already resolved from role presets + spawn args):
 *   c.mode            "plan" | "accept-edits" | "auto"
 *   c.skipPermissions true for role=tester, or when Claude passes skip_permissions
 *   c.sandbox         true for role=tester, or what Claude passes; null when nobody set it
 *   c.network         true only when Claude passes network: true
 *
 * Return { mode: "read-only" | "workspace-write" | "danger-full-access", network: boolean }.
 * Codex never asks for approval in `exec`, so this policy is the only guard on what a worker can touch.
 */
export function sandboxPolicy(c) {
  if (c.mode === "plan") return { mode: "read-only", network: false };
  // Full access needs skip_permissions AND an explicit sandbox: false. skip_permissions alone (an agy
  // habit) stays sandboxed; config.sandbox is null when the caller did not set it.
  if (c.skipPermissions && c.sandbox === false) return { mode: "danger-full-access", network: true };
  return { mode: "workspace-write", network: Boolean(c.network) };
}

function schemaFile(agent, c) {
  if (c.report === false && !c.jsonSchema) return null;
  const file = agent.logFile.replace(/\.ndjson$/, ".schema.json");
  fs.writeFileSync(file, c.jsonSchema || JSON.stringify(STRICT_REPORT_SCHEMA));
  return file;
}

/** `c` is the agent config merged with per-turn overrides. */
export function buildArgs(agent, c, prompt) {
  const resumed = Boolean(agent.conversationId);
  const policy = sandboxPolicy(c);
  const args = resumed ? ["exec", "resume"] : ["exec"];
  args.push("--json", "--skip-git-repo-check");
  // `exec resume` has no -s/-C/--add-dir: pass the sandbox as config and rely on the spawn cwd.
  if (policy.mode === "danger-full-access") args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (resumed) args.push("-c", `sandbox_mode="${policy.mode}"`);
  else args.push("-s", policy.mode, "-C", agent.cwd);
  if (policy.mode === "workspace-write") {
    if (policy.network) args.push("-c", "sandbox_workspace_write.network_access=true");
    const dirs = (c.addDirs || []).filter(Boolean);
    if (dirs.length) args.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(dirs)}`);
  }
  if (c.model) args.push("-m", c.model);
  if (c.effort && EFFORT[c.effort]) args.push("-c", `model_reasoning_effort="${EFFORT[c.effort]}"`);
  const schema = schemaFile(agent, c);
  if (schema) args.push("--output-schema", schema);
  if (resumed) args.push(agent.conversationId);
  // A bare "-" means "read the prompt from stdin"; a leading "-" would parse as a flag.
  args.push(prompt.startsWith("-") ? ` ${prompt}` : prompt);
  return args;
}

/** Codex runs shell commands inside its own sandbox, so workers may always run them. */
export const canRunShell = () => true;

export function promptRules(config) {
  const lines = [];
  const { mode, network } = sandboxPolicy(config);
  if (mode === "read-only") lines.push("Your sandbox is read-only: do not try to edit files.");
  else if (mode === "workspace-write") {
    lines.push(`Shell commands run in a sandbox: you can write only inside the workspace${network ? "" : ", and network access is off"}. Do not commit.`);
  } else lines.push("Do not commit.");
  if (config.verifyCmd) lines.push(`The orchestrator runs \`${config.verifyCmd}\` after you finish and will send you any failures.`);
  return lines;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** "/bin/zsh -lc 'npm test'" -> "npm test" */
function unwrapShell(cmd) {
  const m = /^\S*sh -lc (['"])([\s\S]*)\1$/.exec(String(cmd || ""));
  return m ? m[2] : String(cmd || "");
}

function onItem(agent, turn, phase, item, out) {
  switch (item.type) {
    case "command_execution": {
      const cmd = unwrapShell(item.command);
      if (phase === "item.started") {
        recordTool(agent, "shell", oneLine(cmd, 80));
        if (trackLoop(agent, "shell", { cmd })) out.flagsChanged = true;
      } else if (item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0)) {
        pushMilestone(agent, `✗ shell exit ${item.exit_code ?? "?"}: ${oneLine(cmd, 120)}`, "error");
      }
      return;
    }
    case "file_change":
      if (phase === "item.completed") {
        const files = (item.changes || []).map((ch) => relTo(agent.cwd, ch.path)).filter(Boolean);
        recordTool(agent, "edit", oneLine(files.join(", "), 80));
      }
      return;
    case "mcp_tool_call":
      if (phase === "item.started") recordTool(agent, `${item.server || "mcp"}.${item.tool || "tool"}`, "");
      return;
    case "web_search":
      if (phase === "item.started") recordTool(agent, "web_search", oneLine(item.query || "", 80));
      return;
    case "agent_message":
      if (phase === "item.completed" && typeof item.text === "string") {
        agent.said = item.text.slice(-400);
        if (turn) turn.lastMessage = item.text;
      }
      return;
    case "error":
      pushMilestone(agent, `✗ ${oneLine(item.message || "error", 140)}`, "error");
      return;
    default:
      // reasoning, todo_list, ...: liveness only.
      return;
  }
}

function finishTurn(agent, turn, status, usage) {
  if (!turn) return;
  turn.sawResult = true;
  turn.resultStatus = status;
  turn.response = turn.lastMessage || "";
  turn.structured = null;
  if (agent.config.report !== false || agent.config.jsonSchema) {
    try {
      const parsed = JSON.parse(turn.response);
      if (parsed && typeof parsed === "object") turn.structured = parsed;
    } catch {
      // free text; reportOf falls back to it
    }
  }
  if (usage) turn.usage = { ...usage, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) };
}

export function applyEvent(agent, obj) {
  const turn = agent.turns[agent.turns.length - 1];
  const out = { flagsChanged: touch(agent) };
  const kind = obj?.type || obj?.event;
  switch (kind) {
    case "thread.started":
      if (obj.thread_id) agent.conversationId = obj.thread_id;
      return out;
    case "turn.started":
      return out;
    case "item.started":
    case "item.updated":
    case "item.completed":
      if (obj.item) onItem(agent, turn, kind, obj.item, out);
      return out;
    case "turn.completed":
      finishTurn(agent, turn, "DONE", obj.usage);
      pushMilestone(agent, "result DONE", "result");
      return out;
    case "turn.failed": {
      const msg = obj.error?.message || "turn failed";
      finishTurn(agent, turn, "FAILED", obj.usage);
      agent.error = oneLine(msg, 300);
      pushMilestone(agent, `result FAILED: ${oneLine(msg, 120)}`, "result");
      return out;
    }
    case "error":
      // Often transient (e.g. reconnecting); turn.failed decides the outcome.
      pushMilestone(agent, `✗ ${oneLine(obj.message || "error", 140)}`, "error");
      return out;
    case "turn_start":
    case "verify":
    case "note":
      if (obj.text) pushMilestone(agent, obj.text, kind);
      return out;
    default:
      pushMilestone(agent, oneLine(JSON.stringify(obj), 120), "raw");
      return out;
  }
}
