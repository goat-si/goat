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
| E-WF | Host write-failure robustness (owner waiver on merge `b329b16`): after a failed log write the host fences the thread (engine stopped, no new run until restart), but 5 gaps remain, in priority order: (1) the durable run-start write is outside the fence; (2) a fenced thread accepts input silently instead of refusing it visibly (restart required), and its runtime phase stays Running in memory; (3) a cancelled steer whose requeue write failed is only put back on the active run's accepted-steer list (in memory), not requeued, and is lost at restart; (4) an engine start already in flight (on_permit / on_started) does not recheck the fence; (5) stale session sign-ins on idle threads close only when the thread's actor next starts, not at fence or startup time | lane E, after the providers module, with its own review |
