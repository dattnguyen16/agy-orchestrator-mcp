// Persist the agent registry so workers survive MCP restarts / reconnects.
import fs from "node:fs";
import path from "node:path";

const TRANSIENT = new Set(["child", "verifyChild", "waiters", "verifyTimer"]);

export function serializeAgent(agent) {
  const out = {};
  for (const [k, v] of Object.entries(agent)) {
    if (!TRANSIENT.has(k)) out[k] = v;
  }
  return out;
}

export function createStore(stateDir) {
  const file = path.join(stateDir, "agents.json");
  let timer = null;
  let getAgents = () => [];

  function writeNow() {
    timer = null;
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, agents: getAgents().map(serializeAgent) }));
      fs.renameSync(tmp, file);
    } catch (err) {
      process.stderr.write(`[agy-orchestrator] state save failed: ${err.message}\n`);
    }
  }

  return {
    file,
    bind(fn) {
      getAgents = fn;
    },
    load() {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(data?.agents) ? data.agents : [];
      } catch {
        return [];
      }
    },
    save() {
      if (!timer) timer = setTimeout(writeNow, 500);
    },
    flush() {
      if (timer) clearTimeout(timer);
      writeNow();
    },
  };
}
