# ADR-0010 — decision recorded under "Remote dispatch"

- Contract owner: [launch-and-remote-dispatch.md](../launch-and-remote-dispatch.md#remote-dispatch)
- Commit: `7da51c25845b941f8b9893bdc967f717c2d3e4d6` (2026-10-12)

## Decision record

- 목적과 의도: Give a thread launched over SSH a path back to the machine that launched it, let `delegate_task` run on an SSH host, and let `goat_ssh_thread_launch` carry attachments.
- 기존 구현 및 제약 조건: The message says a remotely launched thread had no path back, `delegate_task` only ran locally, and SSH launch could not carry attachments.
- 검토한 주요 대안: The message does not record a rejected report transport. It specifies delivery modes `wake`, `next_turn`, and `notify_only`, and says `wake` leaves run endings to the launch watch.
- 선택한 방식: The remote stores an origin binding. The remote agent reports with `goat_origin_report`. The origin long-polls `goat_origin_reports_wait` over the existing SSH tunnel with a per-dispatch read key. `delegate_task` with `target.host` and `remote.cwd` launches on that host and keeps the subagent record without a local child thread. `goat_ssh_thread_launch` accepts up to 8 pending attachments. Migrations `065_RemoteReports` and `066_RemoteDispatches` store the rows. A missing binding answers `thread_not_found`. A wrong read key answers `capability_denied`.
- 다른 대안 대신 이 방식을 선택한 이유: The message treats the SSH tunnel the launcher already has as the report path, and treats launch-watch wakes as the signal for run endings under `wake`.
- 장점, 단점 및 영향: `RemoteDispatchCoordinator` in `apps/server/src/remoteReports/RemoteDispatchCoordinator.ts` still inserts `remote_dispatches` before `SshRemoteDispatch.launchThread`. Reports are quoted data, not a second orchestration log on the origin.
