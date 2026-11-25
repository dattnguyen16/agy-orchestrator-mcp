---
name: agy-monitor
description: Orchestrate and monitor Antigravity (`agy`) or OpenAI Codex sub-agents via the `agy-orchestrator` MCP server. Use when the user asks Claude Code to act as a monitor, tech lead, or orchestrator directing Antigravity or Codex workers.
---

# Worker playbook (agy-orchestrator v2.1: agy + Codex)

You are the tech lead. Workers do the reading and the editing; you spend tokens on planning and decisions, not on reading their output.

## 1. Plan and partition
- Split the goal into independent packages, each with explicit file ownership and a checkable done criterion.
- Write a short brief per package: goal, files in scope, constraints, done criterion. The server adds the reporting contract and the role preamble, so don't repeat them.

## 2. Spawn (one call)
- `agy_spawn` with `tasks: [{prompt, name, role}]` to fan out. Top-level fields are shared defaults.
- `use_worktree: true` whenever 2+ workers edit the same repo.
- `role`:
  - `coder` edits code.
  - `tester` runs commands, sandboxed.
  - `reviewer` and `researcher` are read-only.
- **Always pass `verify_cmd`** when there is a test, lint or build command (e.g. `npm test -- path`, `pytest tests/x`, `tsc --noEmit`). The server runs it after each turn and sends failures back to the worker for up to `max_fix_rounds` (default 2) before it ever wakes you.
- `backend`: `agy` (default) or `codex`. Use `codex` when the user asks for Codex workers, or when a worker must run commands itself (tests, builds) without disabling its sandbox. Backends can be mixed per task.
- agy: headless agy denies shell commands. Prefer `verify_cmd` over `skip_permissions`. If a worker really must run commands, pair `skip_permissions` with `sandbox` or a worktree.
- codex: workers run commands inside a sandbox: `plan`/reviewer = read-only, everything else = write inside the workspace, no network. Don't pass `skip_permissions`; only `skip_permissions` + an explicit `sandbox: false` removes the sandbox, and only the user can ask for that. Pass `network: true` only when the worker must install packages.
- `watch: true` when the user wants to watch a worker live in Orca.

## 3. Wait, don't poll
- Call `agy_wait` (default 120s, no ids means all active workers). It returns early on completion **or attention**:
  - `stalled`: no output for a while;
  - `looping`: same tool call repeated;
  - `denied`: a shell command was refused (agy only);
  - `needs_attention`: verify still failing after the fix rounds.
- Each finished worker's `report`, `changes` and `verify` arrive **once**, inside the wait result. Don't call `agy_result` for them again.
- Timed out with nothing new? Wait again. Never loop on `timeout_seconds: 0`.

## 4. Review cheaply
- When `verify: "pass"`, the report is plausible and `changes` match the scope, accept the work without reading the diff.
- Read `agy_result view:"diff"` (pass `paths` to narrow it) only when the report, the changes or the verify result look off. Use `view:"events"` to see what a stalled or looping worker was doing.
- Fix with `agy_instruct` in the same conversation, with targeted feedback. Use `interrupt: true` to redirect a worker going the wrong way. Use `agy_stop` for hopeless ones.
- To hand review to the user, call `agy_result orca_open:"changed"`. It opens the diffs in Orca.

## 5. Integrate
- `agy_merge` squashes a worktree worker into the **currently checked-out** branch.
  - It refuses on a dirty repo, secrets, or predicted conflicts, and leaves everything untouched.
  - On conflicts, either `agy_instruct` the worker to rebase its approach, or resolve them yourself.
- Run the project's full checks after merging, then `agy_cleanup` (add `delete_branch: true` after a merge).

## Notes
- Workers survive MCP restarts. After a reconnect, `agy_list` shows them, and running ones are re-attached automatically.
- Interrupted workers can be resumed with `agy_instruct`.
