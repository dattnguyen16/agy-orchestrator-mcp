#!/usr/bin/env node
// End-to-end tests for agy-orchestrator v2 using mock `agy` and `orca` executables.
// Run: node test-mcp.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcp-test-"));
const ARGV_LOG = path.join(tmp, "agy-argv.ndjson");
const ORCA_LOG = path.join(tmp, "orca-argv.ndjson");

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockAgy = path.join(tmp, "mock-agy");
fs.writeFileSync(mockAgy, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
const ci = args.indexOf("--conversation");
const cid = ci >= 0 ? args[ci + 1] : "conv-" + process.pid;
const prompt = args[args.indexOf("-p") + 1] || "";
const out = (o) => fs.writeSync(1, JSON.stringify(o) + "\\n");
const step = (s) => out({ event: "step_update", step_update: { conversation_id: cid, ...s } });
out({ event: "init", conversation_id: cid, init: { model: "mock" } });
step({ step_index: 0, state: "DONE", step_type: "user_input" });
for (let i = 0; i < 3; i++) step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "thinking " + i });
const result = (extra = {}) => out({ event: "result", result: { conversation_id: cid, status: "SUCCESS", response: "done: " + prompt.slice(-40),
  structured_output: { summary: "did the thing", files_changed: [path.join(process.cwd(), "a.txt")], tests: "not run", confidence: "high" },
  usage: { total_tokens: 1234 }, ...extra } });
const tool = (name, p, state = "ACTIVE") => step({ step_index: 2, state, step_type: "tool", tool_name: name, tool_info: { name, parameters: p } });
if (prompt.includes("SLEEP")) { tool("run_command", { CommandLine: "sleep" }); const gc = require("child_process").spawn("sleep", ["600"], { stdio: "ignore" }); fs.writeFileSync(${JSON.stringify(tmp)} + "/grandchild-" + process.pid, String(gc.pid)); setTimeout(() => {}, 600000); }
else if (prompt.includes("STALL")) { setTimeout(() => {}, 600000); }
else if (prompt.includes("SLOWRESULT")) { tool("read_file", { Path: "x" }); setTimeout(() => { result(); process.exit(0); }, 4000); }
else {
  for (const m of prompt.matchAll(/WRITE_FILE (\\S+) (.+)/g)) { fs.writeFileSync(path.join(process.cwd(), m[1]), m[2] + "\\n"); tool("edit_file", { Path: path.join(process.cwd(), m[1]) }); }
  if (prompt.includes("verification command") && prompt.includes("ok.txt")) fs.writeFileSync("ok.txt", "ok\\n");
  if (prompt.includes("LOOP")) for (let i = 0; i < 6; i++) tool("read_file", { Path: "same.txt" });
  for (let i = 0; i < 4; i++) tool("read_file", { Path: path.join(process.cwd(), "f" + i + ".txt") });
  if (prompt.includes("ABORTDENY")) result({ response: "", structured_output: null, denied_actions: [{ action: "command", display_name: "Bash" }] });
  else if (prompt.includes("DENY")) result({ denied_actions: [{ action: "command", display_name: "Bash" }] });
  else result();
}
`);
fs.chmodSync(mockAgy, 0o755);

const mockOrca = path.join(tmp, "mock-orca");
fs.writeFileSync(mockOrca, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ORCA_LOG)}, JSON.stringify(args) + "\\n");
if (process.env.ORCA_FAIL === "1" && args[0] !== "status") { console.log(JSON.stringify({ ok: false, error: { message: "boom" } })); process.exit(1); }
if (args[0] === "status") console.log(JSON.stringify({ ok: true, result: { runtime: { reachable: true } } }));
else console.log(JSON.stringify({ ok: true, result: {} }));
`);
fs.chmodSync(mockOrca, 0o755);

// ---------------------------------------------------------------------------
// Git fixture
// ---------------------------------------------------------------------------
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
g("init", "-q", "-b", "main");
g("config", "user.email", "t@example.com");
g("config", "user.name", "Test");
fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
g("add", ".");
g("commit", "-qm", "init");

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------
class Client {
  constructor(env = {}) {
    this.stateDir = env.AGY_STATE_DIR;
    this.proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, AGY_BIN: mockAgy, ORCA_BIN: mockOrca, AGY_LOG_DIR: path.join(tmp, "logs"), ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.nextId = 1;
    this.pending = new Map();
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const msg = JSON.parse(line);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p(msg);
      }
    });
  }
  rpc(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  async call(name, args = {}) {
    const msg = await this.rpc("tools/call", { name, arguments: args });
    const text = msg.result.content[0].text;
    this.lastBytes = text.length;
    if (msg.result.isError) {
      const e = new Error(text);
      e.toolError = true;
      throw e;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  close() {
    return new Promise((resolve) => {
      this.proc.on("exit", resolve);
      this.proc.stdin.end();
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argvLines = () => fs.readFileSync(ARGV_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const orcaLines = () => (fs.existsSync(ORCA_LOG) ? fs.readFileSync(ORCA_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}

async function spawnOne(c, args) {
  const r = await c.call("agy_spawn", args);
  assert.ok(r.spawned[0].id, JSON.stringify(r));
  return r.spawned[0];
}
async function waitDone(c, id, timeout = 30) {
  const r = await c.call("agy_wait", { agent_ids: [id], timeout_seconds: timeout });
  return r.agents[0];
}

// ---------------------------------------------------------------------------
console.log("agy-orchestrator v2 tests");
const stateDir = path.join(tmp, "state");
let c = new Client({ AGY_STATE_DIR: stateDir, AGY_MAX_CONCURRENT: "2" });

await test("initialize + compact tools/list", async () => {
  const init = await c.rpc("initialize", {});
  assert.equal(init.result.serverInfo.version, "2.0.0");
  const list = await c.rpc("tools/list");
  const bytes = JSON.stringify(list.result.tools).length;
  assert.equal(list.result.tools.length, 8);
  assert.ok(bytes <= 4100, `tools/list is ${bytes} bytes`);
  console.log(`    tools/list ${bytes} bytes (v1: ~6340)`);
});

let first;
await test("default worker: report via --json-schema, compact digest, changes", async () => {
  fs.writeFileSync(path.join(repo, "dirty.txt"), "x\n");
  first = await spawnOne(c, { prompt: "hello", cwd: repo, name: "basic" });
  const d = await waitDone(c, first.id);
  assert.equal(d.status, "completed");
  assert.equal(d.report.summary, "did the thing");
  assert.deepEqual(d.report.files_changed, ["a.txt"], "files relative to cwd");
  assert.match(d.changes, /dirty\.txt\(new\)/);
  const argv = argvLines().at(-1).args;
  assert.ok(argv.includes("--json-schema"));
  assert.ok(argv.includes("--disable-slash-commands"));
  assert.equal(argv[argv.indexOf("--mode") + 1], "accept-edits");
  const again = await c.call("agy_wait", { agent_ids: [first.id], timeout_seconds: 0 });
  assert.equal(again.agents[0].report, undefined, "report is only delivered once");
  fs.rmSync(path.join(repo, "dirty.txt"));
});

await test("events are filtered and coalesced", async () => {
  const ev = await c.call("agy_result", { agent_id: first.id, view: "events" });
  assert.match(ev, /read_file ×4/);
  assert.doesNotMatch(ev, /thinking/);
});

await test("reviewer role: plan mode without --disable-slash-commands", async () => {
  const a = await spawnOne(c, { prompt: "review it", cwd: repo, role: "reviewer" });
  await waitDone(c, a.id);
  const argv = argvLines().at(-1).args;
  assert.equal(argv[argv.indexOf("--mode") + 1], "plan");
  assert.ok(!argv.includes("--disable-slash-commands"));
  assert.match(argv.at(-1), /code reviewer/);
  await c.call("agy_cleanup", { agent_id: a.id });
});

let wtAgent;
await test("worktree: orca visibility, diff incl. new + modified files", async () => {
  wtAgent = await spawnOne(c, { prompt: "WRITE_FILE new.txt hello-new\nWRITE_FILE shared.txt changed-by-a", cwd: repo, use_worktree: true, name: "wt" });
  assert.match(wtAgent.branch, /^agy\/agy-wt-/);
  const d = await waitDone(c, wtAgent.id);
  assert.equal(d.status, "completed");
  assert.match(d.changes, /shared\.txt \+1-1/);
  assert.match(d.changes, /new\.txt\(new\)/);
  const diff = await c.call("agy_result", { agent_id: wtAgent.id, view: "diff" });
  assert.match(diff, /\+changed-by-a/);
  assert.match(diff, /new file: new\.txt\nhello-new/);
  assert.ok(orcaLines().some((l) => l[0] === "repo" && l[1] === "set" && l.includes("show")));
});

await test("merge safety: wrong target refused, .env refused, squash merge ok", async () => {
  const wrong = await c.call("agy_merge", { agent_id: wtAgent.id, target_branch: "develop" });
  assert.equal(wrong.merged, undefined);
  assert.match(wrong.reason, /never switches branches/);
  const wtRoot = argvLines().find((l) => l.cwd.includes(wtAgent.id)).cwd;
  fs.writeFileSync(path.join(wtRoot, ".env"), "SECRET=1\n");
  const env = await c.call("agy_merge", { agent_id: wtAgent.id });
  assert.match(env.reason, /sensitive.*\.env/);
  fs.rmSync(path.join(wtRoot, ".env"));
  const headBefore = g("rev-parse", "HEAD");
  const ok = await c.call("agy_merge", { agent_id: wtAgent.id });
  assert.equal(ok.merged, true, JSON.stringify(ok));
  assert.equal(ok.into, "main");
  assert.notEqual(g("rev-parse", "HEAD"), headBefore);
  assert.equal(fs.readFileSync(path.join(repo, "shared.txt"), "utf8"), "changed-by-a\n");
  assert.equal(g("rev-parse", "--abbrev-ref", "HEAD"), "main");
});

await test("merge conflict predicted, nothing changed", async () => {
  // base this worker on the commit before the merge so shared.txt conflicts
  const b = await spawnOne(c, { prompt: "WRITE_FILE shared.txt changed-by-b", cwd: repo, use_worktree: true, base_ref: "HEAD~1", name: "conf" });
  await waitDone(c, b.id);
  const head = g("rev-parse", "HEAD");
  const r = await c.call("agy_merge", { agent_id: b.id });
  assert.deepEqual(r.conflicts, ["shared.txt"]);
  assert.equal(g("rev-parse", "HEAD"), head);
  assert.equal(g("status", "--porcelain", "--untracked-files=no"), "");
  await c.call("agy_cleanup", { agent_id: b.id, force: true, delete_branch: true });
});

await test("cleanup removes worktree", async () => {
  const r = await c.call("agy_cleanup", { agent_id: wtAgent.id, delete_branch: true });
  assert.ok(r.actions.includes("worktree removed"));
  assert.ok(!fs.existsSync(path.join(repo, ".agy-worktrees", wtAgent.id)));
});

await test("verify fail then auto-fix pass", async () => {
  const a = await spawnOne(c, { prompt: "FIXME", cwd: repo, use_worktree: true, verify_cmd: "test -f ok.txt", name: "fix" });
  const d = await waitDone(c, a.id);
  assert.equal(d.status, "completed", JSON.stringify(d));
  assert.equal(d.verify, "pass");
  assert.equal(d.fix, "1/2");
  assert.equal(d.turn, 2);
  assert.match(argvLines().at(-1).args.at(-1), /verification command `test -f ok.txt` failed/);
  assert.ok(argvLines().at(-1).args.includes("--conversation"), "fix turn resumes conversation");
  await c.call("agy_cleanup", { agent_id: a.id, force: true, delete_branch: true });
});

await test("verify keeps failing -> needs_attention with tail", async () => {
  const a = await spawnOne(c, { prompt: "nope", cwd: repo, verify_cmd: "echo broken-test; exit 3", max_fix_rounds: 1 });
  const d = await waitDone(c, a.id);
  assert.equal(d.status, "needs_attention");
  assert.equal(d.verify.code, 3);
  assert.match(d.verify.tail, /broken-test/);
  assert.equal(d.turn, 2);
  await c.call("agy_cleanup", { agent_id: a.id });
});

await test("verify timeout kills the check and needs_attention", async () => {
  const a = await spawnOne(c, { prompt: "hi", cwd: repo, verify_cmd: "sleep 30", verify_timeout_seconds: 1, max_fix_rounds: 0 });
  const t0 = Date.now();
  const d = await waitDone(c, a.id);
  assert.ok(Date.now() - t0 < 10000, "did not wait for sleep 30");
  assert.equal(d.status, "needs_attention");
  await c.call("agy_cleanup", { agent_id: a.id });
});

await test("denied shell command -> needs_attention + flag", async () => {
  const a = await spawnOne(c, { prompt: "DENY", cwd: repo });
  const d = await waitDone(c, a.id);
  assert.equal(d.status, "needs_attention");
  assert.ok(d.flags.some((f) => f.startsWith("denied: Bash")));
  await c.call("agy_cleanup", { agent_id: a.id });
});

await test("denied abort without report -> explicit 'missing' note; prompt warns about shell", async () => {
  const a = await spawnOne(c, { prompt: "ABORTDENY", cwd: repo, verify_cmd: "true" });
  const d = await waitDone(c, a.id);
  assert.equal(d.status, "completed");
  assert.match(d.report.missing, /denied Bash/);
  const p = argvLines().filter((l) => l.args.at(-1).includes("ABORTDENY")).at(-1).args.at(-1);
  assert.match(p, /Shell commands are disabled.*runs `true` after you finish/s);
  await c.call("agy_cleanup", { agent_id: a.id });
});

await test("loop flag", async () => {
  const a = await spawnOne(c, { prompt: "LOOP", cwd: repo });
  const d = await waitDone(c, a.id);
  assert.ok(d.flags.some((f) => f.startsWith("looping")), JSON.stringify(d));
  await waitDone(c, a.id); // the flag wakes the wait early; let it finish
  await c.call("agy_cleanup", { agent_id: a.id });
});

await test("stall flag wakes agy_wait early", async () => {
  const a = await spawnOne(c, { prompt: "STALL", cwd: repo, stall_seconds: 2 });
  const t0 = Date.now();
  const r = await c.call("agy_wait", { agent_ids: [a.id], timeout_seconds: 30 });
  assert.ok(Date.now() - t0 < 10000);
  assert.ok(!r.timed_out);
  assert.ok(r.agents[0].flags.some((f) => f.startsWith("stalled")));
  await c.call("agy_stop", { agent_id: a.id });
  await c.call("agy_cleanup", { agent_id: a.id });
});

await test("concurrency queue + stop kills process group", async () => {
  const r = await c.call("agy_spawn", { cwd: repo, tasks: [{ prompt: "SLEEP 1", name: "s1" }, { prompt: "SLEEP 2", name: "s2" }, { prompt: "hi", name: "s3" }] });
  const [s1, s2, s3] = r.spawned;
  assert.equal(s1.status, "running");
  assert.equal(s2.status, "running");
  assert.equal(s3.status, "queued");
  const all = await c.call("agy_wait", { agent_ids: [s1.id, s3.id], wait_for: "all", timeout_seconds: 2 });
  assert.equal(all.timed_out, true, "queued worker keeps wait_for=all open");
  const st = JSON.parse(fs.readFileSync(path.join(stateDir, "agents.json"), "utf8"));
  const s1pid = st.agents.find((x) => x.id === s1.id).pid;
  await sleep(300);
  const gcPid = Number(fs.readFileSync(path.join(tmp, `grandchild-${s1pid}`), "utf8"));
  assert.ok(alive(gcPid), "grandchild started");
  const stopped = await c.call("agy_stop", { agent_id: s1.id });
  assert.equal(stopped.status, "stopped");
  await sleep(300);
  assert.ok(!alive(gcPid), "agy_stop killed the whole process group (grandchild too)");
  const d3 = await waitDone(c, s3.id);
  assert.equal(d3.status, "completed", "queued worker ran after a slot freed");
  const lst = await c.call("agy_list", { status: "active" });
  assert.match(lst, new RegExp(`${s2.id} running`));
  await c.call("agy_stop", { agent_id: s2.id });
  for (const s of [s1, s2, s3]) await c.call("agy_cleanup", { agent_id: s.id });
});

await test("instruct interrupt resumes conversation", async () => {
  const a = await spawnOne(c, { prompt: "SLEEP", cwd: repo });
  await sleep(500);
  await assert.rejects(c.call("agy_instruct", { agent_id: a.id, prompt: "x" }), /interrupt=true/);
  const r = await c.call("agy_instruct", { agent_id: a.id, prompt: "do something else", interrupt: true });
  assert.equal(r.resumed, true);
  const d = await waitDone(c, a.id);
  assert.equal(d.status, "completed");
  assert.ok(argvLines().at(-1).args.includes("--conversation"));
  await c.call("agy_cleanup", { agent_id: a.id });
});

await test("digest for 3 finished workers is small", async () => {
  const r = await c.call("agy_spawn", { cwd: repo, tasks: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }] });
  const ids = r.spawned.map((s) => s.id);
  await c.call("agy_wait", { agent_ids: ids, wait_for: "all", timeout_seconds: 30 });
  console.log(`    agy_wait with 3 reports: ${c.lastBytes} bytes`);
  // second call: reports already delivered -> tiny
  await c.call("agy_wait", { agent_ids: ids, timeout_seconds: 0 });
  assert.ok(c.lastBytes < 600, `post-report digest ${c.lastBytes} bytes`);
  for (const id of ids) await c.call("agy_cleanup", { agent_id: id });
});

await test("watch opens an Orca terminal running agy-tail", async () => {
  const a = await spawnOne(c, { prompt: "hi", cwd: repo, watch: true });
  await waitDone(c, a.id);
  const t = orcaLines().find((l) => l[0] === "terminal" && l[1] === "create");
  assert.ok(t, "terminal create called");
  assert.ok(t.join(" ").includes("agy-tail.mjs"));
  const o = await c.call("agy_result", { agent_id: a.id, orca_open: "changed" });
  assert.equal(o.orca, "opened");
  await c.call("agy_cleanup", { agent_id: a.id });
});

await test("restart: live worker survives and is re-attached; dead one is interrupted", async () => {
  const slow = await spawnOne(c, { prompt: "SLOWRESULT", cwd: repo, name: "slow" });
  const doomed = await spawnOne(c, { prompt: "SLEEP", cwd: repo, name: "doomed" });
  await sleep(500);
  const st = JSON.parse(fs.readFileSync(path.join(stateDir, "agents.json"), "utf8"));
  const doomedPid = st.agents.find((x) => x.id === doomed.id).pid;
  await c.close();
  process.kill(-doomedPid, "SIGKILL");
  await sleep(300);
  c = new Client({ AGY_STATE_DIR: stateDir, AGY_MAX_CONCURRENT: "2" });
  await c.rpc("initialize", {});
  const d = await waitDone(c, slow.id, 20);
  assert.equal(d.status, "completed", JSON.stringify(d));
  assert.equal(d.report.summary, "did the thing");
  const dd = await waitDone(c, doomed.id, 5);
  assert.equal(dd.status, "interrupted");
  const lst = await c.call("agy_list", {});
  assert.match(lst, new RegExp(slow.id));
  for (const id of [slow.id, doomed.id, first.id]) await c.call("agy_cleanup", { agent_id: id });
});

await c.close();

await test("orca failures are warnings, never errors", async () => {
  fs.rmSync(ORCA_LOG, { force: true });
  const c2 = new Client({ AGY_STATE_DIR: path.join(tmp, "state2"), ORCA_FAIL: "1" });
  await c2.rpc("initialize", {});
  const a = await spawnOne(c2, { prompt: "hi", cwd: repo, use_worktree: true, watch: true });
  assert.ok(a.warnings.some((w) => /boom/.test(w)), JSON.stringify(a));
  const d = await waitDone(c2, a.id);
  assert.equal(d.status, "completed");
  await c2.call("agy_cleanup", { agent_id: a.id, force: true, delete_branch: true });
  await c2.close();
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
if (!process.exitCode) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`artifacts kept in ${tmp}`);
