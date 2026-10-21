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

## Orchestration history

History is everything else in the file. On a real 961 MB database, most of it was command output, stored once in the turn item projection and again in the item's `turn-item.updated` events. Database storage's six-hourly compaction calls `ProjectionMaintenance.boundHistory` after `compactEventStore`. While allocated pages minus memory exceed `storageCleanup.historyBudgetBytes` (default `ORCHESTRATION_HISTORY_BUDGET_BYTES`, 2 GiB), it trims command output, tool output, and reasoning above 8 KiB to a head and tail in threads idle a week, oldest first. It rewrites events before projections so an interrupted pass leaves visible work for the next one.

Traps measured on real data:

- Payload bytes overstate the pages a trim frees, so the walk re-measures allocation (three pragmas) after each thread.
- Memory's size comes from its hourly sample, because a `dbstat` walk of the memory tables costs about 18 ms.
- Pages select keys with `octet_length`, which SQLite answers from the record header without reading overflow pages. Each payload is then read, trimmed, and written alone with a yield, because a single tool output can be a megabyte.

### Cold archive

Before trimming, the same pass moves threads idle past `storageCleanup.historyArchiveAfterDays` (default 30) to `userdata/thread-archive/<sha256(thread)>.jsonl.zst`, indexed by `orchestration_v2_thread_history_archives`. Only turn items and their `turn-item.updated` events move. Turn item positions stay so ordinals never collide, and nodes, messages and runs stay because other projections reference them. Threads with a pending, running or waiting item are skipped. Files are hashed rather than named by thread id because thread ids carry `:` and `%`.

The order is what makes a crash harmless: write zstd frames (about 1 MiB raw each) to a temporary file, fsync, rename, fsync the directory, re-read and verify the checksum and line count, then insert the index row, then delete rows in groups of 4 rows or 256 KiB. `rows_deleted` marks the end. A pass that stopped midway is finished from the archive itself on the next pass. Deletes match each item's archived `updated_at`, so an item changed after archiving keeps its newer row.

Restoring sets the row to `restoring`, inserts with `INSERT OR IGNORE` in transactions of 32 rows or 256 KiB, then drops the row and the file. Rerunning a cut-short restore is safe, and rows written after archiving win. Reads reach the archive through `ThreadArchiveGate`: the server provides one slot, the archive service fills it at startup, and the projection store wraps its thread-scoped reads (snapshot, history pages, turn items, turn start context, next ordinal) with it. Handoffs and MCP app context read turn items directly and call it themselves. Without the server's slot the gate is inert, which keeps tests and the doctor CLI unaware of archives. Search does not see archived tool output.
