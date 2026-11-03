# 011 — wp1 evidence receipts

- server-child.log (read-only): line 258 `{"timestamp":"2026-10-30T14:45:18.685Z", ..., "phase":"END","details":"pid=32846 killed by SIGKILL"}`;
  session START 14:45:17.295Z; last server stdout line `[23:45:16.120] INFO ssh.ensure.request.cost`.
- Later failures in the same file are code=1 exits (11-02, WebSocket "closed before the connection was established" crash), unrelated.
- desktop.trace.ndjson*: oldest rotation 2026-11-02 21:02; no backendInstance.stop / stopAllPoolInstances spans retained.
- `log show --start "2026-10-30 23:44:30" --end "2026-10-30 23:45:30" --predicate '…32846 OR jetsam OR killing OR SIGKILL'`: header only, no entries.
- Codex sessions 2026/10/30 (scan /tmp/stopreason/scan.py) 14:42–14:46Z: no kill/pkill/killall/SIGKILL tool calls; Claude projects (scan2.py): no tool calls in window.
- Idle dev server SIGTERM (PID 79139, cwd .../fix-backend-stop-reason-grace/apps/server, port 15318):
  `SIGTERM at 07:00:51 0.047` → `[07:00:51.064] V2 orchestration shutdown reconciliation completed` → `exited after 0.116s`.
- Effect spawner: NodeChildProcessSpawner.js:30 processGroupGraceMillis=1_000; :356-369 terminateProcessGroup; :407-418 release branches.
- Audit: terra reviewer 01a19e4b-c6de-7c80-9198-0b2418494095, rounds r1–r6 FAIL (folded), r7 NEAR-PASS (P2 residuals → wp2 gates).

