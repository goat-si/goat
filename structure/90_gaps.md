# 90 Gaps (structure vs code)

| # | Gap | Owner action |
|---|---|---|
| 1 | ~~Command frames, `command_result`, `BotProfile`~~ merged `a2c6b7c`. Rest merged `387cb19` (`Fold.queuedInputs`, `HeldInputs`, `input.accepted.clientRequestId`, `idempotency_conflict`) | E serves; F calls |
| 6 | ~~contracts-rs codegen~~ shipped `a2c6b7c` (ts-rs, u64 as number, JSON Schema 2020-12, drift test). Lane F must drop its temporary export | lane F |
| 2 | ~~`apps/server` Node stub~~ removed by lane G (`5d9368c`) | closed |
| 3 | Two TS contract packages (`packages/contracts` v1-lifted, `packages/contracts-rs` generated) | UI moves thread/card types to contracts-rs; keep v1-lifted provider/model types until replaced |
| 4 | ~~store~~ merged `39b36a4` (durability fixes pending); `goat2-engine-codex`, `goat2-parity`, `goat2-host` still stubs on `goat2` | lanes B, D, E merge |
| 5 | Old Node-era docs (`docs/PRD.md` "engine host" TS wording, `README.md` run commands) | owner updates after G ships |

| A1 | Store not run on real power loss, Linux or Windows; no test for 'first create fails, waiting second succeeds' | lane A follow-up (INFO) |
| E-WF | ~~Host write-failure robustness~~ merged `1348bab` (fresh review PASS): durable run start inside the fence, fenced threads refuse input visibly (restart_required), steer outcomes persisted before the ack, starts in flight cannot cross the fence, idle stale sign-ins closed. Follow-ups tracked by lane E: an accepted-but-unrecorded steer is re-sent after restart; a parent learns of a fenced child only after restart | closed (lane E follow-ups) |
| E-CONT | ~~Engine work outside a GOAT-started turn~~ merged `761e737` (fresh review PASS on ba498d9, merge focused review PASS): `SessionRequestOpened` is filed as a runless request (`runId` null, card inline in `request.opened.item`, an oversized card left out), counted in `openAsks`, answered through the session, closed on `RequestClosed` or session end, and keeps its session from the idle stop; `ContinuationRequested` becomes a system input `continuation:<key>` run alone via `start_continuation` (a later offer replaces a pending one; withdrawn, declined, unknown, session-ended or restart-dropped continuations are never sent as a prompt); an in-turn `RequestOpened` for a turn that is not running is declined. Follow-up in lane E review: after an unanswered continuation the queue goes on | closed; P2-S switches Muse and Pi, P2-A Claude, to the events |
