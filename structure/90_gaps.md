# 90 Gaps (structure vs code)

| # | Gap | Owner action |
|---|---|---|
| 1 | ~~Command frames, `command_result`, `BotProfile`~~ merged `a2c6b7c`. Rest merged `387cb19` (`Fold.queuedInputs`, `HeldInputs`, `input.accepted.clientRequestId`, `idempotency_conflict`) | E serves; F calls |
| 6 | ~~contracts-rs codegen~~ shipped `a2c6b7c` (ts-rs, u64 as number, JSON Schema 2020-12, drift test). Lane F must drop its temporary export | lane F |
| 2 | ~~`apps/server` Node stub~~ removed by lane G (`5d9368c`) | closed |
| 3 | Two TS contract packages (`packages/contracts` v1-lifted, `packages/contracts-rs` generated) | UI moves thread/card types to contracts-rs; keep v1-lifted provider/model types until replaced |
| 4 | `goat2-thread-store`, `goat2-engine-codex`, `goat2-parity`, `goat2-host` are stubs on `goat2` | lanes A, B, D, E merge |
| 5 | Old Node-era docs (`docs/PRD.md` "engine host" TS wording, `README.md` run commands) | owner updates after G ships |
