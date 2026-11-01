# ADR-0012 — decision recorded under "Shared runtime"

- Contract owner: [ssh.md](../ssh.md#shared-runtime)
- Issue: goat-si/goat#91

## Decision record

- 목적과 의도: Let every client of an SSH host share one GOAT server, so threads started from one client (a box orchestrator) are visible to another (a desktop app) and no client cancels another client's running threads.
- 기존 구현 및 제약 조건: Ownership records lived in `~/.goat/ssh-launch/<sha256(alias, hostname, user, port)>`, but the server they described is host-wide (`~/.goat`). Two clients that dialled one host by different names kept separate, conflicting records. Stale PID/port files in one client's directory made the live runtime "unverifiable", and that client then tried to recover by replacing it. Desktop disconnect stopped any server marked `managed` without checking for active turns. SemVer ordered `0.1.0-dev.*` below `0.1.0-nightly.*`, so a nightly client read a compatible dev runtime as older and refreshed it.
- 검토한 주요 대안: Keeping per-client directories and reconciling them by scanning every `ssh-launch/*` record; that keeps two sources of truth. A drain-based replace endpoint with per-start instance ids and protocol ranges (the Codex app-server model); it is the right shape for upgrades but larger than this fix, and is tracked in goat-si/goat#119.
- 선택한 방식: One host-wide state directory, `~/.goat/ssh-launch/runtime`. The live runtime record plus descriptor proves identity; remembered files whose PID has exited are treated as stale. No client stops the shared server on disconnect. Stop and replacement signal a server only when its activity endpoint reports `idle`. Startup refresh is skipped for prerelease trains that share one core version.
- 다른 대안 대신 이 방식을 선택한 이유: The server is already host-wide, as is the replacement lock. Making its ownership record host-wide too removes the conflict instead of arbitrating it.
- 장점, 단점 및 영향: A server started under an old per-client directory is attached as `external` until it exits, so no client stops or upgrades it automatically. An idle SSH-managed server keeps running after its last client leaves, as an agent-dispatch server already did.
