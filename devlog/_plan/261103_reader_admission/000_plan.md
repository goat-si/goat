# 000 — Reader admission: bounded wait, then priority lanes

**Reader summary.** Today the 65th concurrent read on GOAT's SQLite reader pool fails at once with `ReaderAdmissionOverloadError` (`packages/shared/src/nodeSqliteClient.ts:1118-1131`), so a burst of UI reads or a background sweep turns into user-visible errors even though the pool would drain in milliseconds. This unit replaces the instant failure with a FIFO wait bounded by a deadline (wp1), then adds caller-declared interactive/background lanes so background sweeps yield first, interactive work keeps reserved capacity, and aging keeps background from starving (wp2). Server reads, provider ingestion and every client (web/desktop/mobile) that issues reads benefit; nothing on the wire changes.

## Loop spec

| Field | Value |
|---|---|
| Archetype | satisfy-spec, two dependent work phases, each one PR (no stack; wp2 branches from merged wp1 on dev) |
| Trigger | User request in this thread (reader admission 64 hard fail → deadline wait + priority) |
| Goal | wp1: overflow reads wait FIFO up to a deadline, leave the queue on cancel, fail with the existing overload error only at the deadline. wp2: background lane sheds/waits first, 16/64 admission + 1/4 pool slot reserved for interactive, aging after 5 s |
| Non-goals | pool size, writer path, WS heartbeat, client retry, release/nightly, app restart, live DB writes, repo-wide checks, queue-length caps beyond the deadline |
| Verifier | `vp test run packages/shared/src/nodeSqliteClient.workerRecovery.test.ts apps/server/src/orchestration-v2/ProviderEventIngestor.readerOverload.test.ts packages/shared/src/nodeSqliteReaderPool.test.ts` — RAN on dev 21c65d8620: exit 0, 3 files/35 tests; reads targets as direct args. Plus new `packages/shared/src/readerAdmission.test.ts` (wp1). `vp run check:changed` before push. Hosted `goat-ci-result` SUCCESS on exact PR head. |
| Stop | wp2 PR merged and origin.report sent |
| Memory artifact | this unit dir (gitignored via .git/info/exclude), goalplan `.codexclaw/goalplans/goat-db-reader-admittedreaders-64-readeradmissio/` |
| Terminal outcomes | DONE (both merged), NOOP, BLOCKED, UNSAFE, NEEDS_HUMAN (policy numbers rejected by reviewer with no defensible default), BUDGET_EXHAUSTED (no stated bound; host limits apply) |
| Escalation | reviewer FAIL twice on the same design point; CI failure that reproduces only on this branch and is outside scope; any need to touch writer/pool sizing |
| Resource bounds | none stated; host limits apply. Tools: local shell in this worktree, gh, goat_call. Write scope = files in 010/020 maps. |

## Constraints (from code and repo rules)

- `nodeSqliteClient.ts` is 1308 lines against a code budget of 1318 (`oxlint-plugin-goat/code-budgets.json:815`). Policy goes in a new GOAT-owned module; the client keeps a hook that is line-neutral or shorter.
- Acquisition runs masked: `Effect.acquireUseRelease(admit(...))` in the borrower (`nodeSqliteClient.ts:1166-1169`) and `Effect.acquireRelease(admit(...))` in the transaction acquirer (`:1227-1230`). `readOnly` carries the caller's interruptible `restore` in the `ReadOnly` reference (`sqliteReadRouting.ts:4-13`). A wait must run under that restore so cancellation works, and must keep an uninterruptible caller uninterruptible.
- Provider ingestion retries once on the writer when the reader overloads (`apps/server/src/orchestration-v2/readerOverloadFallback.ts:11-30`, #2410). It must keep falling back immediately and must not wait 30 s first.
- Tests: `it.effect` + `TestClock`, `Deferred` milestones, no sleeps/polling/timeouts (AGENTS.md).

## Research evidence

- Codex (`codex-rs/state/src/sqlite/connection.rs:31`): sqlx pool `max_connections(5)`; a full pool makes acquire wait until `pool_timeout`; `busy_retry.rs` retries twice (100/200 ms) and never retries a cancellation. Rollout JSONL is the source of truth, SQLite the index.
- T3 upstream: `busy_timeout 5000`, `BEGIN IMMEDIATE`, reader worker pool.
- `/Users/jun/.aside/u/0/artifacts/goat-ws-crash/report-session-resilience.md` §3.3 (lanes 0/1/2, shed background first, reserve reader capacity for lane 1, aging) and §3.4 (bound queues by time, deadline per entry, drop work whose caller gave up, typed retryable overload).
- Reader owners in `~/.goat/desktop-nightly/userdata/logs/event-loop-stalls.ndjson` (64 stalls, read-only `jq`): readShellSnapshotRows 303, OrchestratorV2.getThreadShell 137, MemoryWorker.catchUp 112, getRuntimeRecoveryProjection 50, readCanonicalProjection 47, ThreadSettlementServiceV2.sweep 22, MemoryStore.pendingForgetIntents 19, getRecoveryThreadIds 10, getThreadsWithPullRequests 6, getLimitRecoveryCandidates 6.

## Dependency-ordered work-phase map

| WP | Doc | Delivers | Depends on | Verifiable by |
|---|---|---|---|---|
| wp0 | this dir | roadmap only, no production patch | — | terra audit |
| wp1 | 010_wp1_deadline_wait.md | `readerAdmission.ts` gate (FIFO, deadline, cancel-safe handoff), client hook, fail-fast for writer-fallback reads | wp0 | new + updated deterministic tests, check:changed, CI |
| wp2 | 020_wp2_priority_lanes.md | lanes in the same gate, lane-aware pool permits, background call-site marks | wp1 merged | lane tests, check:changed, CI |

Foundation first: wp1 builds the gate with the accounting invariant; wp2 extends that gate with a second queue and reuses it for pool permits.

## Architect consultation

- Handle: terra subagent `01a19e46-8241-75b2-9c6d-e48b3b4d6385` (gpt-6.1-terra, high). Same agent is reused for reflection, A audit and reviews per the user's instruction (disclosed: architect and auditor are the same agent; the final pre-merge approval uses a fresh reviewer).
- Proposal D1–D9 (returned 2026-11-03). Dispositions:

| ID | Proposal | Main disposition |
|---|---|---|
| D1 | new `readerAdmission.ts`, thin hooks; wp1/wp2 separate | ACCEPT |
| D2 | FIFO waiters, no barging, token handoff, invariant held+granted ≤ 64; queue cap 256 | ACCEPT FIFO/handoff/invariant. REJECT the cap: the user asked for overload only when the deadline expires, and §3.4 says to bound by time. Waiter memory is bounded by arrival rate × deadline, and each waiter is a fiber that exists anyway. Residual risk recorded. |
| D3 | deadline from request time, `readerAdmissionTimeout` default 30 s, admission-wait only | ACCEPT (30 s in wp1; wp2 sets interactive 30 s / background 10 s) |
| D4 | admit takes caller restore from ReadOnly / TransactionAcquire; uninterruptible callers stay so | ACCEPT |
| D5 | single synchronous state machine queued→granted→claimed / expired / cancelled; skip expired at handoff; return grant on late cancel | ACCEPT |
| D6 | writer-fallback callers fail fast via explicit policy | ACCEPT (`failFastReaderAdmission` reference set by readOnReader when fallback applies) |
| D7 | `backgroundReads(effect)` wrapper at call sites, default interactive | ACCEPT |
| D8 | reserve 16/64, aging 5 s, background 10 s / interactive 30 s | ACCEPT numbers as policy defaults (not measured); queue-cap part rejected as in D2 |
| D9 | priority also at the 4-slot pool permits (max 3 background leases; size 1 → no reservation) | ACCEPT in wp2 by reusing the same gate for pool permits |

- Reflection: see 001_reflection.md once returned.

