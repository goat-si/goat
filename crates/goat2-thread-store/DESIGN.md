# goat2-thread-store — design and public API (lane A)

Status: plan under audit (cxc-loop wp1). This file is the contract lane E (host) builds on; the code
lands in this crate on branch `goat2_thread_store`. Layout and events follow `structure/20_data.md`
and goat2-design `prd-src/part1/storage.md`, `model.md`. Types come from `goat2-contracts`.

## On disk

```
<dataDir>/
  store.lock                   exclusive process lock (std File::try_lock); a second open fails with Locked
  cards.sqlite                 card index (cache). WAL, synchronous=NORMAL, user_version = schema
  threads/<threadId>/
    goat.jsonl                 header {"v":1,"epoch":uuid}, then one LogLine per line {v, seq, at, type, ...}
    card.json                  {"v":1,"card":ThreadCard,"fold":Fold}, temp + sync + rename + dir sync
    blobs/<itemId>-<8hex>.txt  one externalized field per item (see Blobs)
```

## Public API (Rust, synchronous; the host calls it from spawn_blocking)

```rust
Store::open(data_dir, StoreOptions) -> Result<(Store, StartupReport)>
store.create_thread(id: Option<ThreadId>, created: ThreadCreated) -> Result<ThreadCard>
store.append(&ThreadId, Vec<LogEvent>) -> Result<Appended>      // assigns seq/at, folds, returns lines + card
store.card(&ThreadId) -> Result<Option<ThreadCard>>
store.find(&CardFilter) -> Vec<ThreadCard>                     // cwd, parent, status, kind, botId, projectId, archived
store.cards_after(Option<&CardCursor>) -> CardsRead            // changed cards + tombstones, or reset
store.read(&ThreadId, Option<&ThreadCursor>) -> Result<ThreadRead>
store.read_page(&ThreadId, before: u64, limit: u32) -> Result<Page>
store.read_raw(&ThreadId, after: u64, limit: u32) -> Result<Vec<String>>   // history even when unsupported
store.subscribe_thread(&ThreadId, Option<&ThreadCursor>) -> Result<(ThreadRead, Receiver<ThreadUpdate>)>
store.subscribe_cards(Option<&CardCursor>) -> (CardsRead, Receiver<CardUpdate>)
store.put_blob(&ThreadId, name_hint, bytes) -> Result<BlobRef>
store.read_blob(&ThreadId, &BlobRef) -> Result<Vec<u8>>
store.delete_thread(&ThreadId) -> Result<()>
store.flush() -> Result<()>          // batched in-run card.json/index writes; the host calls it on a timer
store.close() -> Result<()>
```

There is no call that reads every thread body. `find` and `cards_after` serve from the in-memory card
set loaded from the index.

## Write protocol (crash safety)

1. Before any append that can change the card, the index row is committed with `dirty=1`
   (synchronous=FULL for that commit) unless it already is.
2. The lines are written with one `write_all`. `input.accepted`, `input.delivered`, `run.started`,
   `run.accepted` and `request.resolved` batches are `sync_data`ed before `append` returns
   (`run.started` is the send boundary: the host sends to the engine only after `append` returns).
3. Not in a run: card.json and the index row are written now (write-through). In a run: they are
   batched until `flush` or the run ends. Before a row is stored with `dirty=0` the log is synced up to
   the card's `appliedSeq`. Any failure keeps `dirty=1`.
4. `run.finished` is followed by an automatic `checkpoint {card, fold}` line in the same write (from
   the merge of the full contract `Fold`; see Fold).
5. Create: row {dirty=1, creating=1} (FULL) -> mkdir -> goat.jsonl header + thread.created (sync) ->
   dir sync -> card.json -> row {dirty=0, creating=0}. Delete: row dirty=1 -> rename folder to
   `threads/.trash-<id>-<hex>` -> dir sync -> row removed -> remove_dir_all.

## Startup

1. Lock, open the index (missing / SQLITE_CORRUPT / NOTADB / user_version mismatch -> rebuild: read
   `card.json` of every folder and verify each log's last line, skipping and removing `.trash-*`
   folders; other errors fail `open`).
2. Load every row (one row per thread). New index epoch for every start.
3. Only rows with `dirty=1` or an active run: verify the log tail, refold lines after `appliedSeq`,
   abandon incomplete creates (only rows with `creating=1`; the same damage on an existing thread
   marks it corrupt and keeps it), settle active runs:
   `run.finished` `interrupted` when the run reached the engine (`run.accepted`, an item, a request,
   or an accepted turn delivery for it), else `unknown` (+ resend request, never re-sent).
4. `StartupReport`: thread count, index outcome (loaded / rebuilt + reason), logs opened, settled runs,
   repaired tails, per-phase timings.

Tail repair touches only a demonstrably incomplete tail: bytes after the last newline that do not form a
complete valid line, or a trailing region made only of NUL bytes (zero-filled growth). They are copied
to `goat.jsonl.torn-<n>` and truncated; a valid unterminated last line with the next seq gets its
newline. A newline-terminated malformed line, a bad `v`/`seq` or a seq gap is `CorruptLog` and the
file is left as is. A line with `v > 1` or an unknown `type` marks the thread
unsupported: append / read / read_page / settle return `UnsupportedEvent`; `read_raw` still works.

## Cursor contract

| Call | Condition | Result |
|---|---|---|
| read(None) | latest eligible checkpoint C (its fold has every Fold field) with suffix after it <= 128 lines and <= 1 MiB | snapshot C + suffix |
| read(None) | no checkpoint and whole log within limits | all lines |
| read(None) | otherwise | snapshot of the current {card, fold} at head, no lines (history via read_page) |
| read(c) | folder missing | reset ThreadMissing |
| read(c) | epoch differs / seq > head | reset EpochChanged / InvalidCursor + read(None) |
| read(c) | seq == head | nothing |
| read(c) | (seq, head] <= 128 lines and <= 1 MiB | those lines |
| read(c) | otherwise | reset TooFarBehind + read(None) |
| read_page(before, limit) | limit 1..=512, before <= head + 1 | newest `limit` lines with seq < before, oldest first; hasMore |

Every read returns cursor (epoch, head). Subscriptions register their channel under the same lock as
appends, so nothing falls between replay and live; a full channel (1024) drops the subscriber and the
client resubscribes with its cursor.

## Blobs

One field per item variant moves to `blobs/` when the line would exceed 64 KB: user/assistant text,
reasoning text, plan markdown, file_change diffStr, subagent result, system_notice message, compaction
summary. The item keeps the first 2 KB of that field and `ItemCompleted.blob` points at the full text.
Contract omissions are enforced (command / dynamic tool output and file_change patch are dropped with
`*Omitted: true`). Anything else over 64 KB is refused with `PayloadTooLarge`, including
`input.accepted` text (the host stores large input as an attachment through `put_blob`).
`read_blob` accepts exactly `blobs/<name>` and opens it relative to the blobs directory without
following symlinks.

## Fold

`Fold` has the shape in `structure/20_data.md`: activeRunId, activeRunInputIds,
activeRunReachedEngine, queuedInputIds, heldInputs, openRequests, runningChildIds, lastRunOutcome,
counters. Until lane C merges the added fields, `src/contract.rs` defines that exact shape as
`StoreFold` (used in card.json) and re-exports everything else from `goat2-contracts`. Until then the
store writes no checkpoint lines (a lossy line would stay in the log forever); reads that need a
snapshot get the current {card, fold} from memory instead. The store never restores its own state
from a checkpoint. `input.changed` (15th SSOT event) is treated as unknown until the contract has it.
Rules: input.accepted -> queue; input.delivered
accepted -> leaves the queue; declined -> stays queued and leaves activeRunInputIds; unknown -> held
under `resend:<runId>`. run.finished: run inputs still queued are delivered if the run reached the
engine, held if the outcome is unknown, else stay queued. An unknown outcome opens request
`resend:<runId>` (kind resend); resolving it with `resend` puts the held inputs back at the front of
the queue, `dropped` discards them. One `child.started` per child thread (refused while running, or
when the child's card is missing or has another parent).

