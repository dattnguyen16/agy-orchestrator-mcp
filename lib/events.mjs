// Parse `agy --output-format stream-json` lines into compact milestones.
// Real schema (agy, Nov 2026), see test/fixtures/*.ndjson:
//   {"event":"init","conversation_id":..,"init":{"model","cwd","tools","permission_mode"}}
//   {"event":"step_update","step_update":{step_index,state:ACTIVE|DONE|ERROR,
//       step_type:user_input|agent_response|tool|finish, tool_name, tool_info:{name,parameters,output,error},
//       text_delta, usage}}
//   {"event":"result","result":{conversation_id,status,response,structured_output,usage,denied_actions,num_turns}}
// Server-written markers share the file: turn_start, verify, note.
import { nowIso, oneLine, relTo, truncate } from "./util.mjs";

export const MAX_EVENTS = 100;
const LOOP_THRESHOLD = 5;

function pushMilestone(agent, text, kind = "step") {
  const last = agent.events[agent.events.length - 1];
  agent.events.push({ ts: nowIso(), kind, text });
  if (agent.events.length > MAX_EVENTS) agent.events.splice(0, agent.events.length - MAX_EVENTS);
  return last;
}

function toolArg(params, cwd) {
  if (!params || typeof params !== "object") return "";
  const preferred = ["CommandLine", "Path", "AbsolutePath", "TargetFile", "Query", "Url", "Pattern", "SearchPath"];
  for (const key of preferred) {
    if (typeof params[key] === "string") return oneLine(relTo(cwd, params[key]), 80);
  }
  const firstStr = Object.values(params).find((v) => typeof v === "string");
  return firstStr ? oneLine(relTo(cwd, firstStr), 80) : "";
}

/** Coalesce consecutive calls to the same tool: "read_file ×3 (last: a.py)". */
function recordTool(agent, name, arg) {
  const last = agent.events[agent.events.length - 1];
  if (last && last.kind === "tool" && last.tool === name) {
    last.count = (last.count || 1) + 1;
    last.ts = nowIso();
    last.text = `${name} ×${last.count}${arg ? ` (last: ${arg})` : ""}`;
    return;
  }
  agent.events.push({ ts: nowIso(), kind: "tool", tool: name, count: 1, text: arg ? `${name} ${arg}` : name });
  if (agent.events.length > MAX_EVENTS) agent.events.splice(0, agent.events.length - MAX_EVENTS);
}

function addUsage(target, usage) {
  if (!usage || typeof usage !== "object") return;
  for (const k of ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens"]) {
    if (typeof usage[k] === "number") target[k] = (target[k] || 0) + usage[k];
  }
}

/**
 * Apply one parsed stream-json object to agent state.
 * Returns { flagsChanged: boolean } so the engine can wake waiters.
 */
export function applyEvent(agent, obj) {
  const turn = agent.turns[agent.turns.length - 1];
  const out = { flagsChanged: false };
  const kind = obj?.event || obj?.type;
  agent.lastEventAt = nowIso();
  if (agent.flags.stalled) {
    delete agent.flags.stalled;
    out.flagsChanged = true;
  }

  const cid = obj?.conversation_id || obj?.init?.conversation_id || obj?.step_update?.conversation_id || obj?.result?.conversation_id;
  if (cid) agent.conversationId = cid;

  switch (kind) {
    case "init":
      if (obj.init?.model) agent.model = obj.init.model;
      return out;

    case "turn_start":
    case "verify":
    case "note":
      if (obj.text) pushMilestone(agent, obj.text, kind);
      return out;

    case "step_update": {
      const s = obj.step_update || {};
      if (s.step_type === "tool") {
        const name = s.tool_name || s.tool_info?.name || "tool";
        const params = s.tool_info?.parameters;
        if (s.state === "ACTIVE") {
          const arg = toolArg(params, agent.cwd);
          recordTool(agent, name, arg);
          // loop detection: same tool + same params repeatedly
          const sig = `${name}:${JSON.stringify(params ?? {})}`;
          if (agent.loop.sig === sig) agent.loop.count += 1;
          else agent.loop = { sig, count: 1 };
          if (agent.loop.count >= LOOP_THRESHOLD && !agent.flags.looping) {
            agent.flags.looping = `${name} ×${agent.loop.count} same args`;
            out.flagsChanged = true;
          }
        } else if (s.state === "ERROR") {
          const msg = s.tool_info?.error?.message || s.error?.message || "error";
          pushMilestone(agent, `✗ ${name}: ${oneLine(msg, 140)}`, "error");
        }
      } else if (s.step_type === "agent_response") {
        if (typeof s.text_delta === "string") {
          const prev = agent.saidStep === s.step_index ? agent.said || "" : "";
          agent.said = (prev + s.text_delta).slice(-400);
          agent.saidStep = s.step_index;
        }
        if (turn) addUsage((turn.usage ||= {}), s.usage);
      }
      return out;
    }

    case "result": {
      const r = typeof obj.result === "object" && obj.result ? obj.result : {};
      const response = typeof obj.result === "string" ? obj.result : r.response ?? obj.response ?? "";
      if (turn) {
        turn.sawResult = true;
        turn.resultStatus = r.status || obj.status || "DONE";
        turn.response = response;
        turn.structured = r.structured_output ?? obj.structured_output ?? null;
        if (r.usage) turn.usage = r.usage; // authoritative total for the turn
        turn.denied = Array.isArray(r.denied_actions) && r.denied_actions.length
          ? r.denied_actions.map((d) => d.display_name || d.action).join(",")
          : null;
      }
      pushMilestone(agent, `result ${r.status || obj.status || "DONE"}`, "result");
      return out;
    }

    default: {
      // Unknown shape: keep a short trace so nothing is silently lost.
      pushMilestone(agent, oneLine(JSON.stringify(obj), 120), "raw");
      return out;
    }
  }
}

/** Progress line for digests: latest milestone, else latest thing the agent said. */
export function progressLine(agent) {
  const last = agent.events[agent.events.length - 1];
  if (last && last.kind !== "turn_start") return last.text;
  return agent.said ? oneLine(agent.said, 120) : last?.text || "";
}
