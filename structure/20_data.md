# 20 Data

```
<dataDir>/                     ~/.goat2-dev (Dev) | ~/.goat2 (release)
  cards.sqlite                 card index (cache; rebuildable from folders)
  ui-state.json                visits, read marks, pin order (not thread history)
  host.json                    running host: pid, port, generation (+ token, 0600, manual runs)
  bots/<botId>.json            BotProfile {botId, name, purpose, face{shape,color,goat}, role main|member, threadId, engine}; main bot GOAT created on first start
  logs/stalls.ndjson           event-loop / blocking stall records
  threads/<threadId>/
    goat.jsonl                 ONLY source of truth, append-only, line = {v, seq, at, ...event}
    card.json                  {"v":1,"card":ThreadCard,"fold":Fold}, atomic replace
    blobs/<itemId>.txt         bodies > 64 KB
```

Format freeze: v1 of `goat.jsonl` lines and `card.json` freezes at the `goat2` merge where lane A's store first
writes them. Before that, contract changes need no legacy readers. After it, persisted shapes change only
additively (new optional fields, new event types that readers skip) or bump `v` with a reader for the old one;
a frozen v1 sample log + card.json fixture guards it. `cards.sqlite` is a cache and may change freely (rebuild).

Rules (PRD storage.md): append-only log, completed items only, `run.started` written before sending to
the engine, card index writes batched only during a run (dirty mark first, write-through otherwise),
no "read every thread body" API, no log migrations (per-line `v`), index epoch new per host start.

## The 15 log events — `crates/goat2-contracts/src/log.rs`

| Event | Written when |
|---|---|
| `thread.created` | thread created |
| `thread.changed` | changed fields only (title, model, archived, ...) |
| `input.accepted` | input enters the mailbox (sender's requested mode) |
| `input.changed` | queued input edited, cancelled, reordered or promoted to steer |
| `input.delivered` | engine answered a steer or turn start for that input: accepted / declined / unknown |
| `run.started` | before sending to the engine (dispatch boundary) |
| `run.accepted` | engine acknowledged the turn |
| `item.completed` | an item finished (no deltas) |
| `request.opened` / `request.resolved` | approval / question / signin / resend |
| `run.finished` | done / failed / interrupted / unknown |
| `child.started` / `child.reported` | parent side of a worker thread |
| `user.notified` | `send_to_user` ack / result |
| `checkpoint` | `{card, fold}` after each run |

`Fold` (contracts `log.rs`, owned by lane C, shaped with lane A): `{activeRunId, activeRunInputIds, activeRunReachedEngine, queuedInputs [{inputId, text, mode, source, attachments?}], heldInputs, openRequests, runningChildIds, lastRunOutcome, counters {inputs, runs, items}}` — enough to continue from a checkpoint without the log before it (fields beyond the first cut requested by lane A 2026-11-28, pending lane C merge).

Input text over 64 KB is refused by the store; the host turns it into an attachment (`blobs/`) first. One type for `card.json` and `checkpoint`; the store never keeps its own.

Card status precedence: needs_you (open request or unresolved unknown, kind `resend`) > running >
queued > failed > idle.

Engines' own transcripts are pointed at, never copied: Codex by thread id + `(turnId, itemId)`.
