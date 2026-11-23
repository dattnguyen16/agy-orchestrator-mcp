#!/usr/bin/env node
// Human-readable live view of an agy-orchestrator worker log (stream-json NDJSON).
// Usage: node agy-tail.mjs <agent-log.ndjson>   — runs in an Orca terminal tab; Ctrl-C to close.
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: agy-tail <log.ndjson>");
  process.exit(2);
}
const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c(2, s);
let offset = 0;
let partial = "";
let speaking = false;

function arg(params) {
  if (!params) return "";
  const v = params.CommandLine || params.Path || params.AbsolutePath || params.TargetFile || params.Query || Object.values(params).find((x) => typeof x === "string");
  return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 120) : "";
}

function render(o) {
  const time = dim(new Date().toTimeString().slice(0, 8));
  const s = o.step_update;
  if (o.event === "turn_start") return `\n${c("1;36", `━━ ${o.text || "turn"} ━━`)}`;
  if (o.event === "verify") return `${time} ${c(o.text?.includes("pass") ? 32 : 31, `● ${o.text}`)}`;
  if (o.event === "init") return `${time} ${dim(`model ${o.init?.model || "?"}  conversation ${o.conversation_id || ""}`)}`;
  if (o.event === "result") {
    const r = o.result || {};
    const denied = r.denied_actions?.length ? c(33, ` denied: ${r.denied_actions.map((d) => d.display_name).join(",")}`) : "";
    return `${time} ${c(r.status === "SUCCESS" ? 32 : 31, `■ result ${r.status}`)} ${dim(`${r.usage?.total_tokens ?? "?"} tok`)}${denied}`;
  }
  if (!s) return null;
  if (s.step_type === "tool") {
    if (s.state === "ACTIVE") return `${time} ${c(34, "▸")} ${s.tool_name} ${dim(arg(s.tool_info?.parameters))}`;
    if (s.state === "ERROR") return `${time} ${c(31, "✗")} ${s.tool_name}: ${(s.tool_info?.error?.message || "").split("\n")[0]}`;
    return null;
  }
  if (s.step_type === "agent_response" && s.text_delta) {
    process.stdout.write(speaking ? s.text_delta : `${time} ${s.text_delta}`);
    speaking = s.state === "ACTIVE";
    if (!speaking && !s.text_delta.endsWith("\n")) process.stdout.write("\n");
    return null;
  }
  return null;
}

function drain() {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < offset) offset = 0;
  if (size === offset) return;
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = size;
  const lines = (partial + buf.toString("utf8")).split("\n");
  partial = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      console.log(dim(line.slice(0, 200)));
      continue;
    }
    if (speaking && !(o.step_update?.step_type === "agent_response")) {
      process.stdout.write("\n");
      speaking = false;
    }
    const out = render(o);
    if (out) console.log(out);
  }
}

console.log(dim(`agy-tail ${file}`));
drain();
setInterval(drain, 500);
