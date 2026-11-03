# 022 — wp2 P revalidation

- Previous D (wp1): "…merge … then wp2 P on a fresh branch from the merged dev." Done: PR 2419 was merged as b6c764179a, and the branch perf/reader-admission-lanes was created from origin/dev b6c764179a.
- Stale check against merged dev:
  - readerAdmission.ts as built (187 lines): `acquire(restore?)` returns void, `release` is a bare Effect (no token), FailFastReaderAdmission is private. wp2 changes acquire to return a lane token and release to take it (020 R2-1).
  - nodeSqliteClient.ts is 1315/1318 lines (3 lines of headroom). So: no new client config field (background timeout is a readerAdmission.ts constant, 10 s); lane reading stays inside the gate; client edits are line-neutral except at most +3.
  - Call sites today: MemoryWorker.ts:974 (`Effect.andThen(sweepDue())`; file at 1006/1006 budget); ThreadSettlementService.ts:657 (`full:`); PullRequestSyncReactor.ts:602 (`return sweep(scope)`); PullRequestWatchReactor.ts:721 (periodic loop); UsageLimitRecoveryWorker.ts:154 (`scheduler.register`).
  - Pool: nodeSqliteReaderPool.ts:42 `permits = Semaphore.make(size)`, :57-65 `use`; transaction path nodeSqliteClient.ts:1246-1261 (`lock.take(1)` / `lock.release(1)`).
- Executable plan for wp2 = 021_wp2_packet.md.

