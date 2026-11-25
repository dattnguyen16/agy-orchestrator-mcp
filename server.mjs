#!/usr/bin/env node
/**
 * agy-orchestrator MCP server v2 (zero-dependency Node.js ESM, stdio JSON-RPC 2.0).
 * Claude Code acts as monitor/orchestrator of Antigravity (`agy`) workers.
 * Logic lives in lib/: engine (process + queue + verify), events (stream-json parser),
 * git (worktree, diff, safe merge), orca (Orca IDE integration), state (persistence), tools.
 */
import readline from "node:readline";
import { init, shutdown } from "./lib/engine.mjs";
import { SERVER_INSTRUCTIONS, TOOLS, handleToolCall } from "./lib/tools.mjs";
import { compact } from "./lib/util.mjs";

const SERVER_NAME = "agy-orchestrator";
const SERVER_VERSION = "2.1.0";

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const sendResult = (id, result) => send({ jsonrpc: "2.0", id, result });
const sendError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

function toText(data) {
  if (typeof data === "string") return data;
  return JSON.stringify(compact(data) ?? {});
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case "initialize":
        sendResult(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: SERVER_INSTRUCTIONS,
        });
        return;
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        if (!isNotification) sendResult(id, {});
        return;
      case "tools/list":
        sendResult(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = params?.name;
        try {
          const data = await handleToolCall(name, params?.arguments ?? {});
          sendResult(id, { content: [{ type: "text", text: toText(data) }] });
        } catch (err) {
          sendResult(id, { content: [{ type: "text", text: `Error in ${name}: ${err.message}` }], isError: true });
        }
        return;
      }
      case "resources/list":
        if (!isNotification) sendResult(id, { resources: [] });
        return;
      case "prompts/list":
        if (!isNotification) sendResult(id, { prompts: [] });
        return;
      default:
        if (!isNotification) sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (!isNotification) sendError(id, -32603, err.message || "Internal error");
  }
}

init();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    sendError(null, -32700, `Parse error: ${err.message}`);
    return;
  }
  handleRequest(msg).catch((err) => process.stderr.write(`[${SERVER_NAME}] ${err.stack || err.message}\n`));
});

const exit = () => shutdown().finally(() => process.exit(0));
rl.on("close", exit);
process.on("SIGINT", exit);
process.on("SIGTERM", exit);
