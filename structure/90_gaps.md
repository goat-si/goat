# 90 Gaps (structure vs code)

| # | Gap | Owner action |
|---|---|---|
| 1 | `ClientFrame` has no commands: send input (with mode), start thread, stop/interrupt, resolve request, resend/drop, archive, rename | lane C adds them to `subscribe.rs`, lane E serves them, lane F calls them |
| 2 | `apps/server` (Node stub) still in the tree | remove when lane G spawns `goat2-host` |
| 3 | Two TS contract packages (`packages/contracts` v1-lifted, `packages/contracts-rs` generated) | UI moves thread/card types to contracts-rs; keep v1-lifted provider/model types until replaced |
| 4 | `goat2-thread-store`, `goat2-engine-codex`, `goat2-parity`, `goat2-host` are stubs on `goat2` | lanes A, B, D, E merge |
| 5 | Old Node-era docs (`docs/PRD.md` "engine host" TS wording, `README.md` run commands) | owner updates after G ships |
