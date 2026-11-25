// Antigravity CLI backend: `agy --output-format stream-json -p <prompt>`.
import fs from "node:fs";
import path from "node:path";
import { applyEvent } from "../events.mjs";

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

export const name = "agy";
export const defaultStallSeconds = 180;

export function bin() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  const local = path.join(process.env.HOME || "", ".local", "bin", "agy");
  return fs.existsSync(local) ? local : "agy";
}

/** `c` is the agent config merged with per-turn overrides. */
export function buildArgs(agent, c, prompt) {
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
  args.push("-p", prompt.startsWith("-") ? ` ${prompt}` : prompt);
  return args;
}

/** Headless agy denies shell commands (and aborts the turn) unless permissions are skipped. */
export const canRunShell = (config) => Boolean(config.skipPermissions);

export function promptRules(config) {
  if (!config.skipPermissions) {
    return [
      config.verifyCmd
        ? `Shell commands are disabled for you. Do not try to run any. The orchestrator runs \`${config.verifyCmd}\` after you finish and will send you any failures.`
        : "Shell commands are disabled for you. Do not try to run any; verify by reading code instead.",
    ];
  }
  return config.verifyCmd ? [`The orchestrator runs \`${config.verifyCmd}\` after you finish and will send you any failures.`] : [];
}

export { applyEvent };
