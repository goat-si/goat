# goat2-thread-store — design and public API (lane A)

The per-thread folder store for GOAT 2 Part 1. Layout and events follow `structure/20_data.md` and
goat2-design `prd-src/part1/storage.md`, `model.md`; all types come from `goat2-contracts`.
v1 rules this crate carries over are listed in `docs/PROVENANCE.md` (section goat2-thread-store).

## On disk

```
<dataDir>/
  store.lock                   exclusive lock (std File::try_lock); a second open fails with Locked
  cards.sqlite                 card index (cache). WAL, synchronous=NORMAL, user_version = 1
  threads/<threadId>/
    goat.jsonl                 header {"v":1,"epoch":uuid}, then one LogLine per line {v, seq, at, type, ...}
    card.json                  CardFile {"v":1,"card","fold"}, temp file + rename
    blobs/<itemId>-<8hex>.txt  one externalized item field, or a host attachment (put_blob)
    goat.jsonl.torn-<n>        bytes cut by tail repair, kept for inspection
```

Thread ids are folder names: 1-128 of `A-Z a-z 0-9 . _ -`, not starting with a dot.

## Public API (Rust, synchronous; the host calls it from spawn_blocking)

```rust
Store::open(data_dir, StoreOptions) -> Result<(Store, StartupReport)>
store.create_thread(Option<ThreadId>, ThreadCreated) -> Result<ThreadCard>
store.append(&ThreadId, Vec<LogEvent>) -> Result<Appended>      // lines, card and fold after the append
store.card(&ThreadId) -> Result<Option<ThreadCard>>
store.fold(&ThreadId) -> Result<Option<Fold>>        // queued / held inputs, active run, open requests
store.find(&CardFilter) -> Vec<ThreadCard>                     // cwd, parent, status, kind, botId, projectId, archived
store.cards_after(Option<&CardCursor>) -> CardsRead            // changed cards, or every card + reset
store.subscribe_cards(Option<&CardCursor>) -> (CardsRead, Receiver<CardUpdate>)
store.read(&ThreadId, Option<&ThreadCursor>) -> Result<ThreadRead>
store.subscribe_thread(&ThreadId, Option<&ThreadCursor>) -> Result<(ThreadRead, Receiver<ThreadUpdate>)>
store.read_page(&ThreadId, before: u64, limit: u32) -> Result<Page>
store.read_raw(&ThreadId, after: u64, limit: u32) -> Result<Vec<String>>   // raw lines, also for unreadable threads
store.put_blob(&ThreadId, name_hint, bytes) -> Result<BlobRef>
store.read_blob(&ThreadId, &BlobRef) -> Result<Vec<u8>>
store.delete_thread(&ThreadId) -> Result<()>
store.flush() -> Result<()>          // batched in-run card writes; the host calls it on a timer
store.close() -> Result<()>
store.cache_error(&ThreadId) -> Option<String>
store.index_complete() -> bool       // false: the last rebuild could not index every folder
```

There is no call that reads every thread body. `find` and `cards_after` serve from the card set loaded
from the index. `append` refuses `thread.created` and `checkpoint` (the store writes those).

Validation on append: one active run at a time; `run.accepted` / `run.finished` only for the active
run; `input.changed` only for a queued input; `child.started` only for an existing child whose card
names this thread as parent and that is not already running. Text bounds: titles 200 chars, request
summaries 200 chars, `child.reported` summary 8 KB; `input.accepted` text, `thread.created` and any
non-item event over 64 KB are refused (`PayloadTooLarge`; the host stores large input as an attachment first).

## Write protocol

1. Before any append, the thread's index row is committed with `dirty=1` (synchronous=FULL) unless it
   already is durably.
2. The batch is written with one `write_all`. Batches with `input.accepted`, `input.changed`,
   `input.delivered`, `run.started`, `run.accepted`, `request.resolved` or `run.finished` are
   `sync_data`ed before `append` returns. `run.started` is the send boundary: the host sends to the
   engine only after `append` returns.
3. Not in a run, or when the status changes, or when a run ends, the batch is written through: the log
   is synced first, and only then is the card published, subscribers notified and card.json / the
   index row written. A failed log sync (here or at a boundary event) returns the error and poisons the
   thread: nothing is published, and the outcome stays uncertain until a reopen checks the actual tail. Otherwise they are batched until `flush`. Before a row is stored clean the log is synced
   through the card's `appliedSeq`; the row stays `dirty=1` while a run is active. card.json is
   replaced atomically but not synced: startup trusts the index row and refolds a bad card.json on
   rebuild. A failed cache write keeps the row dirty, does not fail the append, and shows in
   `cache_error`.
4. `run.finished` is followed by `checkpoint {card, fold}` in the same write; the checkpoint card has
   `appliedSeq` equal to its own seq.
5. Create: row {dirty=1, creating=1} (FULL) -> mkdir -> goat.jsonl header + `thread.created` (sync) ->
   directory syncs -> card.json + row (creating cleared); the card is announced, with its cardSeq, only
   after that and with the thread lock held. Delete: row dirty=1 -> rename the folder to
   `threads/.trash-<id>-<hex>`; from the rename on the delete always completes in memory (card removed,
   subscribers told, callers waiting on the thread get ThreadMissing) and a failed directory sync or row
   delete is returned afterwards. The row is removed only after the rename is synced; otherwise the dirty
   row stays so the next start decides from what is on disk (folder gone: finish the delete; folder back
   after a power loss: keep the thread). The trash contents are removed only after the rename is synced;
   startup syncs the threads directory before it finishes a delete or clears leftover trash. Marking a create clears any cached card left on the row, and a
   `creating` row is never loaded from a cached card.

Lock order: a thread's lock, then the thread map, then the shared lock (card set, index); the thread
map is never held while a thread lock is taken.

## Startup

1. Lock; open the index. A missing file, SQLITE_CORRUPT / NOTADB, a schema mismatch or a missing
   completion marker rebuilds it from the folders. Per folder: verify and repair the log tail, then use
   card.json if it belongs to this log (same id and epoch, appliedSeq not past the tail) and fold the lines
   after it, else replay the log; sync the log; `.trash-*` folders are removed. The rows and the
   completion marker are committed in one transaction, and the marker only when every folder was indexed.
   Folders that cannot be indexed are kept, listed in `StartupReport.unindexed`, and `index_complete()`
   is false for the session; the next start rebuilds again. I/O errors fail `open`.
2. Load every row (one per thread). The index epoch is new for every start.
3. Only rows marked dirty, creating or with an active run: verify the log tail, fold lines after
   `appliedSeq` (a card.json newer than the row is used first), sync the log, write the row. A
   `creating` row is abandoned (folder to trash) only when the create provably never committed: no
   folder, no goat.jsonl, or no newline-terminated first event line. Anything else (an invalid but
   complete header or first line, a newer version) is kept and reported corrupt. I/O errors while probing
   fail `open`, and so does any card.json read error other than a missing file (an invalid card.json
   is a cache miss). A dirty row without a folder is a finished delete. Both an abandoned create and
   a finished delete sync `threads/` before they clear trash or drop the row, because the row may
   cover an earlier delete whose rename was never synced; a failed sync fails `open` and keeps both.
4. Settle every active run: its open requests resolve `cancelled`, then `run.finished` is
   `interrupted` when the run reached the engine (`run.accepted`, an item or request for it, or an
   accepted turn delivery) and `unknown` otherwise. An unknown run opens request `resend:<runId>`
   (kind resend) holding its undelivered inputs; it is never re-sent automatically.
5. `StartupReport`: threads, index outcome, logs opened, refolded, settled, repaired, abandoned creates,
   removed deletes, corrupt and unsupported threads, per-phase timings.

Every other thread is checked on first touch (append, read, card): tail verified and lines after
`appliedSeq` folded.

Tail repair touches only a demonstrably incomplete tail: trailing bytes made only of NUL (zero-filled
growth) and an unterminated last line whose JSON ends early (a torn write). They are copied to
`goat.jsonl.torn-<n>` and cut. A complete unterminated last line that is the next valid line gets its
newline (also for v > 1). A complete line that is invalid, has a seq gap or a syntax error before its
end, terminated or not, is `CorruptLog` and the file is left as it is. A write error poisons the thread
until the store is reopened.

Format v1 rules (lane C freeze): a v1 line with an unknown `type` is skipped (the fold only advances
`appliedSeq`; reads leave it out; `read_raw` returns it). A line with `v > 1` stops the thread:
append / read / read_page return `UnsupportedEvent`, `read_raw` still works.

## Fold (contract `Fold`)

input.accepted -> queue. input.changed: cancelled -> leaves the queue; text / mode / position edit the
queued entry. input.delivered accepted -> leaves the queue (a turn delivery for the active run counts as
reaching the engine; steer deliveries do not); declined -> stays queued and leaves the run's inputs;
unknown -> held under `resend:<runId>`. run.finished: run inputs still queued are delivered if the run
reached the engine, held if the outcome is unknown, else stay queued. request.resolved for a resend
request: `resend` puts the held inputs back at the front of the queue, `dropped` discards them.
child.started / child.reported track running children by id. Status: open request -> needs_you;
active run -> running; queued inputs -> queued; last run failed -> failed; else idle.

## Cursor contract

| Call | Condition | Result |
|---|---|---|
| read(None) | latest checkpoint whose raw fold has every Fold key, with <= 128 lines and <= 1 MiB after it | snapshot from the checkpoint + those lines |
| read(None) | no such checkpoint, whole log within the limits | every line |
| read(None) | otherwise | snapshot of the current {card, fold} at the head, no lines (history via read_page) |
| read(c) | thread missing | reset ThreadMissing |
| read(c) | other epoch / seq past the head | reset EpochChanged / InvalidCursor + read(None) |
| read(c) | seq == head | nothing |
| read(c) | (seq, head] <= 128 lines and <= 1 MiB | those lines |
| read(c) | otherwise | reset TooFarBehind + read(None) |
| read_page(before, limit) | limit 1..=512, before <= head + 1 | newest lines with seq < before, oldest first, at most `limit` and 1 MiB; hasMore |
| cards_after(c) | other epoch / past the max / before a deletion in this process | every card + reset EpochChanged / InvalidCursor / ThreadMissing |
| cards_after(c) | otherwise | cards with cardSeq > c |

Every thread read returns cursor (epoch, head). Subscriptions register their channel under the same
lock as appends, so nothing falls between replay and live. A full channel (1024) drops the subscriber;
the client resubscribes with its last cursor.

## Blobs

When an item line would exceed 64 KB, one field per item type moves to `blobs/`: user / assistant text,
reasoning text, plan markdown, file_change diffStr, subagent result, system_notice message, compaction
summary. The item keeps the first 2 KB and `ItemCompleted.blob` points at the full text. Contract
omissions are enforced before that (command / dynamic tool output and file patches are dropped with
`*Omitted: true`). Any other item still over 64 KB is refused. `read_blob` accepts exactly
`blobs/<name>` and opens it relative to the blobs directory without following symlinks.

## Measured startup (release, 1,000 threads)

`cargo run --release -p goat2-thread-store --example startup_bench -- --threads 1000` on an Apple M5
Max (18 cores, macOS, APFS), 41 lines per thread (19.2 MB of logs), 50 threads left mid-run:

| Case | open() | logs opened |
|---|---|---|
| warm, index present (median of 5) | 2.9 ms | 0 |
| after deleting cards.sqlite (median of 5) | 104 ms | 1,000 (tail check + sync) |
| unclean (50 open runs settled: 25 interrupted, 25 unknown) | 236 ms | 50 |

The unclean case is dominated by one F_FULLFSYNC per settled run (send-boundary durability).
