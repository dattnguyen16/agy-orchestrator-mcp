# agy-orchestrator-mcp (Tiếng Việt)

**Để Claude Code chỉ huy một đội worker Antigravity (`agy`), tốn ít token hơn nhiều.**

> English (đầy đủ, tham chiếu chính): [README.md](README.md)

`agy-orchestrator` là một MCP server không phụ thuộc thư viện nào. Nó biến Claude Code thành tech lead của các sub-agent `agy` chạy headless.
- **Claude** lên kế hoạch và ra quyết định.
- **Worker** đọc và sửa code.
- **Server** lo phần trông chừng:
  - chạy test, gửi lỗi lại cho worker;
  - phát hiện worker bị treo hoặc lặp;
  - tách các việc song song ra git worktree riêng;
  - merge an toàn.

Có thể tích hợp với **Orca IDE** (Stably AI) để xem worker chạy trực tiếp và review diff.

## Vì sao cần

| Nếu Claude tự làm | Với agy-orchestrator v2 |
| :-- | :-- |
| Poll trạng thái, đọc từng event thô | `agy_wait` chờ ở phía server, trả 1 dòng digest cho mỗi worker |
| Đọc toàn bộ response để biết worker đã làm gì | Worker trả report có cấu trúc (`--json-schema`), chỉ gửi **một lần** |
| Tự chạy test, đọc lỗi, prompt lại | `verify_cmd` chạy ở server, lỗi tự gửi lại cho worker |
| Phát hiện worker treo rất muộn | Cờ `stalled` / `looping` / `denied` đánh thức Claude sớm |
| Worker song song ghi đè lên nhau | Mỗi worker một git worktree và branch riêng |
| Merge thủ công, dễ hỏng | `agy_merge` dự đoán conflict trước và không bao giờ đổi branch của bạn |

Đo trên cùng kịch bản 3 worker: `agy_wait` giảm từ **7.3 KB xuống 0.4 KB**, đã gồm cả report. Schema các tool giảm từ ~6.3 KB xuống ~4.0 KB.

## Yêu cầu

- Node.js ≥ 20, không cần `npm install`.
- `agy` CLI đã đăng nhập (`~/.local/bin/agy`, nằm trong `PATH`, hoặc đặt `AGY_BIN`).
- git ≥ 2.38 (cho worktree và `agy_merge`).
- Claude Code, hoặc MCP client bất kỳ hỗ trợ stdio.
- Orca IDE *(không bắt buộc)*.

## Cài đặt

```bash
git clone https://github.com/dattnguyen16/agy-orchestrator-mcp.git ~/.claude/mcp-servers/agy-orchestrator
cd ~/.claude/mcp-servers/agy-orchestrator && npm test

claude mcp add --scope user agy-orchestrator -- node ~/.claude/mcp-servers/agy-orchestrator/server.mjs

# skill playbook cho Claude
mkdir -p ~/.claude/skills
ln -s ~/.claude/mcp-servers/agy-orchestrator/skills/agy-monitor ~/.claude/skills/agy-monitor
```

Khởi động lại Claude Code, hoặc chạy `/mcp` rồi reconnect. Bạn sẽ thấy 8 tool.

## Dùng thử

Nói với Claude, ví dụ:

> Dùng agy worker sửa các test đang fail trong `src/parser/` và thêm test cho input rỗng. Chạy song song trong worktree, verify bằng `npm test`.

Claude sẽ gọi:

```jsonc
agy_spawn { "cwd": "/repo", "use_worktree": true, "verify_cmd": "npm test",
  "tasks": [ { "name": "parser-fix", "role": "coder", "prompt": "…" },
             { "name": "empty-input", "role": "tester", "prompt": "…" } ] }
agy_wait  { "wait_for": "all" }       // digest + report + verify: "pass"
agy_merge { "agent_id": "agy-parser-fix-…" }
agy_cleanup { "agent_id": "agy-parser-fix-…", "delete_branch": true }
```

## 8 tool

| Tool | Chức năng |
| :-- | :-- |
| `agy_spawn` | Chạy 1 worker (`prompt`) hoặc nhiều worker (`tasks[]`); field ở cấp ngoài là mặc định chung. Tham số: `role`, `use_worktree`, `base_ref`, `verify_cmd`, `max_fix_rounds`, `model`, `mode`, `effort`, `skip_permissions`, `sandbox`, `timeout_seconds`, `watch`, `json_schema`. |
| `agy_wait` | Chờ worker xong **hoặc cần chú ý**. Report, `changes`, `verify` chỉ gửi một lần. `timeout_seconds` 0–300, mặc định 120; giá trị 0 là snapshot. |
| `agy_result` | `view`: `report` (mặc định), `full`, `diff` (gồm cả file mới), `events`. `orca_open` mở diff trong Orca. |
| `agy_instruct` | Gửi chỉ đạo tiếp trong cùng conversation. `interrupt:true` dừng turn đang chạy. |
| `agy_stop` | Kill cả process group, hoặc bỏ worker khỏi hàng đợi. |
| `agy_list` | Mỗi worker 1 dòng. |
| `agy_merge` | Commit rồi merge (mặc định squash) vào branch đang checkout. |
| `agy_cleanup` | Xóa worktree, tùy chọn xóa nhánh, và quên worker. |

**Role preset:**

| Role | Mode | Đặc điểm |
| :-- | :-- | :-- |
| `coder` | accept-edits | Sửa tối thiểu. |
| `tester` | accept-edits | Tự bật `skip_permissions` + `sandbox` để chạy test. |
| `reviewer` | plan | Chỉ đọc. |
| `researcher` | plan | Chỉ đọc. |

**Report mặc định:** `summary`, `files_changed`, `commands_run`, `tests`, `open_questions`, `confidence`.

## Vòng đời worker

- **Đang hoạt động:** `queued` → `running` → `verifying` (khi có `verify_cmd`).
- **Kết thúc:** `completed`, `needs_attention`, `failed`, `stopped`, `interrupted`.
- `agy_instruct` cho worker đã kết thúc chạy tiếp.
- Tối đa `AGY_MAX_CONCURRENT` (mặc định 4) worker được ở trạng thái `running`/`verifying`. Worker vượt số này sẽ `queued`.

## Verify và tự sửa

- Sau mỗi turn thành công, server chạy `/bin/sh -c "<verify_cmd>"` trong thư mục của worker.
- Nếu fail, server gửi 80 dòng lỗi cuối cho worker trong cùng conversation, tối đa `max_fix_rounds` vòng (mặc định 2).
- Hết số vòng mà vẫn fail thì chuyển `needs_attention`.
- Nên dùng lệnh nhanh và hẹp, ví dụ `pytest tests/x -q` hoặc `tsc --noEmit`.

## Cờ cần chú ý

| Cờ | Khi nào |
| :-- | :-- |
| `stalled` | Không có event mới sau 180 giây. |
| `looping` | Cùng tool, cùng tham số, lặp ≥5 lần liên tiếp. |
| `denied` | agy tự từ chối lệnh shell ở chế độ headless. Chỉ gắn khi không có `verify_cmd`. |

## Merge an toàn

- Không bao giờ đổi branch.
- Từ chối nếu repo gốc có thay đổi chưa commit.
- Từ chối nếu có file nhạy cảm (`.env*`, `*.pem`, `*.key`, `id_*`, …).
- Dự đoán conflict bằng `git merge-tree`; nếu có conflict thì không thay đổi gì.
- Rollback nếu merge lỗi.

## Bền vững qua restart

- Worker chạy detached và ghi log thẳng ra `logs/<id>.ndjson`. State nằm ở `state/agents.json`.
- MCP restart hoặc `/mcp` reconnect:
  - worker còn sống thì được nhận lại;
  - worker đã chết mà chưa có kết quả thì chuyển `interrupted`, dùng `agy_instruct` để chạy tiếp.
- Mặc định không kill worker khi server thoát. Đặt `AGY_KILL_ON_EXIT=1` nếu muốn kill.

## Orca IDE

Mọi lệnh Orca đều best-effort: lỗi chỉ thành `warnings`, không bao giờ `orca open` hay `--focus`.
- **Hiện worktree trong sidebar:** repo phải được thêm vào Orca trước (`orca repo add --path <repo>`).
- **`watch:true`:** mở terminal Orca chạy `bin/agy-tail.mjs` để xem log trực tiếp, có màu.
- **`agy_result {orca_open:"changed"}`:** mở diff để bạn review.
- **Tắt hẳn tích hợp:** `AGY_ORCA=0`.

## Biến môi trường

| Biến | Mặc định |
| :-- | :-- |
| `AGY_BIN` | `~/.local/bin/agy` |
| `AGY_LOG_DIR` | `./logs` |
| `AGY_STATE_DIR` | `./state` |
| `AGY_MAX_CONCURRENT` | `4` |
| `AGY_RETENTION_DAYS` | `7` |
| `AGY_KILL_ON_EXIT` | không đặt |
| `ORCA_BIN` / `ORCA_CLI_COMMAND` | CLI của Orca.app |
| `AGY_ORCA` | `0` = tắt |

## Lưu ý về `agy` headless

- Ở `-p`, lệnh shell bị **tự từ chối** nếu không có `--dangerously-skip-permissions`, nhưng agy vẫn trả `SUCCESS`. Server gắn cờ `denied`.
- `--json-schema` cho kết quả ở `result.structured_output`, và worker tốn thêm một bước ngắn. Tắt bằng `report:false`.
- `--disable-slash-commands` làm `--mode plan` mất tác dụng, nên server chỉ bật cờ này ngoài plan mode.

## Kiểm thử, giới hạn, bảo mật

- `npm test` chạy 20 test end-to-end với mock `agy` và mock `orca`.
- **Giới hạn:**
  - Schema stream-json của agy chưa có tài liệu chính thức; parser dựa trên output quan sát được (tháng 11/2026).
  - Mới test trên macOS.
- **Bảo mật:**
  - `verify_cmd` và `skip_permissions` chạy lệnh tùy ý, nên chỉ dùng với repo tin cậy.
  - `logs/` và `state/` đã được gitignore.

Chi tiết từng tham số, sơ đồ kiến trúc, troubleshooting và cách đóng góp: xem [README.md](README.md).

## License

[MIT](LICENSE)
