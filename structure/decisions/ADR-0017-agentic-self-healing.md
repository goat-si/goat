# ADR-0017 — decision recorded under "Fleet goals"

- Contract owner: [launch-and-remote-dispatch.md](../launch-and-remote-dispatch.md#fleet-goals)
- Commit: pending on branch docs/agentic-k8s-design (recorded before implementation, 2026-10-20)
- Design: [agentic-k8s.md](../../docs/internals/agentic-k8s.md)

## Decision record

- 목적과 의도: Detect lost hosts and stalled threads and continue goal work elsewhere from the pushed branch or a replica, with bounded retries and without two hosts finishing the same work.
- 기존 구현 및 제약 조건: Only channel tasks heal: `ChannelRemoteWorkers.ts` (`LAUNCH_GRACE_MS = 300000`, `MAX_LAUNCH_ATTEMPTS = 3`, `move` refuses while the old host answers) and `channelReplica.ts` (per-turn git bundles under `refs/goat/replicas/<task>/<gen>`). Launch watches count failed contacts and report an outage after three. Thread status already reports `lastActivityAt`. Hosts have no cordon state.
- 검토한 주요 대안:
  - A remote lease that the old host must renew before pushing. Older hosts cannot honour it.
  - A new heartbeat probe per host. Watches and host status already contact every host that has work.
  - Copy the channel move code into a second healer. Two healers would drift.
- 선택한 방식: `HostHealthMonitor` derives `Ready`, `Unreachable` (3 failed contacts), `Lost` (unreachable for 5 min), `Cordoned`, `Draining`, `VersionMismatch` (warning) and `QuotaExhausted` from existing signals; cordon and drain persist per host. `ThreadStallDetector` calls a running thread stalled after 20 min without activity; a pending question is never a stall. `Rescheduler` resumes from the attempt's pushed branch, then the newest replica, then the base, on a new branch per attempt. The attempt number is the fencing token: only the current attempt counts, and a returning stale attempt is interrupted once and ignored. Three attempts per worker and a goal-wide reschedule cap. The replica module moves out of channels with a re-export.
- 다른 대안 대신 이 방식을 선택한 이유: Branch-per-attempt fencing needs nothing from remote hosts, so mixed versions keep working, and reusing watch outages and host status adds no probe traffic.
- 장점, 단점 및 영향: Fencing bounds a disconnected attempt but does not stop it: it can still run tests, push its own branch and open a PR until its host returns; the controller reports it and never merges it, and a goal can choose `onHostLost: "wait"` instead. Work leaves a host that still answers only after a confirmed interrupt. Remote failure classes need new optional status fields; older hosts report `unknown`. Remotes without `lastActivityAt` get no stall detection. Drain moves goal attempts only between runs and never touches threads no goal owns.
