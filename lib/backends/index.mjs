// Worker CLI backends. Each one maps the generic agent config to CLI args and parses its JSONL stream.
//   name, defaultStallSeconds, bin(), buildArgs(agent, config, prompt), applyEvent(agent, obj),
//   canRunShell(config), promptRules(config)
import * as agy from "./agy.mjs";
import * as codex from "./codex.mjs";

export const BACKENDS = { agy, codex };
export const BACKEND_NAMES = Object.keys(BACKENDS);

export function backendNamed(name) {
  const b = BACKENDS[name || "agy"];
  if (!b) throw new Error(`Unknown backend '${name}'. Use one of: ${BACKEND_NAMES.join(", ")}.`);
  return b;
}

/** Agents persisted before backends existed have no config.backend: they are agy. */
export const backendOf = (agent) => backendNamed(agent.config?.backend);
