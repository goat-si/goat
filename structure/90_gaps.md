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
| E-CONT | Engine work outside a GOAT-started turn (contract in step 3c: `EngineEvent::SessionRequestOpened`, `ContinuationRequested`, `ContinuationWithdrawn`, `EngineSession::start_continuation`): the host logs and ignores these until lane E files session requests with `run_id` None (counted in `openAsks`, in the inbox, answered through the session, closed on `RequestClosed` or session end; in-turn `RequestOpened` starts checking `turn_id`) and records continuations as `input.accepted { from: system, clientRequestId: "continuation:<key>" }` (a later offer replaces a pending one; withdrawn or declined continuations are dropped, never resent as a prompt). Muse and Pi send them; OpenCode for background turns | lane E, after the providers module and E-WF; then P2-S switches Muse and Pi to the events |
