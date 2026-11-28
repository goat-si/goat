# 20 Data

```
<dataDir>/                     ~/.goat2-dev (Dev) | ~/.goat2 (release)
  cards.sqlite                 card index (cache; rebuildable from folders)
  ui-state.json                visits, read marks, pin order (not thread history)
  host.json                    running host: pid, port, generation
  logs/stalls.ndjson           event-loop / blocking stall records
  threads/<threadId>/
    goat.jsonl                 ONLY source of truth, append-only, line = {v, seq, at, ...event}
    card.json                  {"v":1,"card":ThreadCard,"fold":Fold}, atomic replace
    blobs/<itemId>.txt         bodies > 64 KB
```

Rules (PRD storage.md): append-only log, completed items only, `run.started` written before sending to
the engine, card index writes batched only during a run (dirty mark first, write-through otherwise),
no "read every thread body" API, no log migrations (per-line `v`), index epoch new per host start.

## The 14 log events — `crates/goat2-contracts/src/log.rs`

| Event | Written when |
|---|---|
| `thread.created` | thread created |
| `thread.changed` | changed fields only (title, model, archived, ...) |
| `input.accepted` | input enters the mailbox (sender's requested mode) |
| `input.delivered` | engine answered a steer or turn start for that input: accepted / declined / unknown |
| `run.started` | before sending to the engine (dispatch boundary) |
| `run.accepted` | engine acknowledged the turn |
| `item.completed` | an item finished (no deltas) |
| `request.opened` / `request.resolved` | approval / question / signin / resend |
| `run.finished` | done / failed / interrupted / unknown |
| `child.started` / `child.reported` | parent side of a worker thread |
| `user.notified` | `send_to_user` ack / result |
| `checkpoint` | `{card, fold}` after each run |

Card status precedence: needs_you (open request or unresolved unknown, kind `resend`) > running >
queued > failed > idle.

Engines' own transcripts are pointed at, never copied: Codex by thread id + `(turnId, itemId)`.
