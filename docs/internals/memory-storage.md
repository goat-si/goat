# Memory storage budget

Memory exists to be injected into agent context: the memory block, recall, and the save nudge. The store should hold what can be injected or recalled and keep everything else derived, bounded, or evicted. Steady state stays under `MEMORY_STORE_BUDGET_BYTES` (100 MiB) and normally under `MEMORY_STORE_TARGET_BYTES` (50 MiB).

## Where the bytes are

Memory lives in the `memory_*` tables of the shared `statev2.sqlite`. On a real 961 MB database, memory was 12 MB. The rest was orchestration history: events, turn items and nodes. A multi-GB state file is a history problem, and database compaction owns it. Memory stays in the shared file because summary work reads its sources from `orchestration_events` in the same transaction that checks them.

The per-dimension admission limits in `packages/contracts/src/memory.ts` (live payload, history, log tail, FTS, receipts, and others) each guard one concern. Their worst cases add up to far more than 100 MiB, so none of them bounds the store. The budget is enforced on the measured sum instead.

## Enforcement

- **Measurement** reads `dbstat` restricted to `memory_*` btree names. Without that name constraint, `dbstat` walks every page of the shared file, which took seconds on multi-GB databases and stalled the event loop. A sample is taken at most hourly, every 5 minutes while over budget, and also when FTS rows changed. It feeds the storage samples, the `goat_memory_store_bytes` gauge, and a warning above the target.
- **Admission.** At or above the budget, a local write that adds content is refused as `capacity_exceeded` on `live_payload_bytes`. That existing dimension is reused so older clients and hub peers decode the refusal. Forgetting is never refused, because it is the way back under budget.
- **Retention.** Summary completion keeps one completed work row per thread and kind. The worker's maintenance pass deletes rows that can never be read again: rows of threads that are deleted or gone from the projection, and cancelled or failed rows behind a newer run of the same thread. The pass walks `memory_outbox` in fixed rowid pages and yields between pages. On a store from before retention, the first pass is the one-time compaction. Hub compaction separately removes terminal sync work and old log events after `MEMORY_LOG_RETENTION_MS`.
- **Reclamation.** Deleted memory pages join the shared freelist and are reused by later writes. Returning them to the filesystem is a whole-database operation that belongs to database storage maintenance.

## Idle work

An idle server does almost no memory work. The worker still wakes every 5 seconds for due retries, but its expensive steps are gated:

- The recovery scan finds threads with unsummarized messages or a due consolidation. It runs on start, on a memory model or hub change, after summary work finished, after a full page, and otherwise every 15 minutes. It starts from the thread projection and probes each thread's tail by index, so its cost follows the thread count rather than the event history.
- A run counts as settled once any unfinished, failed or cancelled work row exists for it. Work ids are deterministic, so re-deriving a settled run only repeats the same ignored insert. A run that later events invalidated gets a cancelled row for the same reason.
- Storage measurement and retention follow the sample interval above.

A due 24-hour consolidation can start up to one scan interval late.
