# ADR-0009 — decision recorded under "Launch watches"

- Contract owner: [launch-and-remote-dispatch.md](../launch-and-remote-dispatch.md#launch-watches)
- Commit: `840e587977cf5b5da62844ed144f2747e92704c9` (2026-10-12)

## Decision record

- 목적과 의도: Wake the launching thread when a thread it started finishes, instead of leaving the launcher to poll.
- 기존 구현 및 제약 조건: The message says threads started with `goat_thread_launch` or `goat_ssh_thread_launch` ended silently.
- 검토한 주요 대안: The message rejects polling. It does not record a second delivery design. It chooses a JSON file and says there is no migration.
- 선택한 방식: `LaunchWatchService` stores one watch per launched thread in `<stateDir>/thread-launch-watches.json`. The follower uses this environment's projections, or the SSH MCP session of the target host, authorized as the launcher. A finished run, a question the thread waits on, and a host that stays unreachable each queue one message on the launcher. `notifyOnCompletion: false` opts out. `goat_thread_send` re-arms the watch.
- 다른 대안 대신 이 방식을 선택한 이유: The message says orchestrators were polling or hearing about finished work from the user.
- 장점, 단점 및 영향: `apps/server/src/mcp/LaunchWatchService.ts` and `apps/server/src/mcp/launchWatch.ts` still implement this. Watches survive restarts because they are a file under the state directory, not rows in SQLite. Origin reports (ADR-0010) are a separate channel back from a remote thread.
