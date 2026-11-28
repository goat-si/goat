# 50 Lanes

All on this Mac's GOAT (project `/Users/jun/Developer/goat`), Codex instance, Opus 5.5 high, cxc-loop.
Merge locally into `goat2`, force-with-lease push.

| Lane | Branch / worktree | GOAT thread |
|---|---|---|
| A thread_store | `goat2_thread_store` | `mcp:a0b59ee4-1aa7-4348-87f7-ecb275b23ccb` |
| B engine_codex | `goat2_engine_codex` | `mcp:05e314f6-b3e5-4ade-bebb-861258209746` |
| C contracts — **done** (final report 2026-11-28; reopen for contract changes) | `goat2_contracts` | `mcp:628b0dd7-0b60-4332-9be9-0078ee058667` |
| D parity | `goat2_parity` | `mcp:6bee8c38-9aa4-4405-9f97-61e074c2998c` |
| E host | `goat2_host` | `mcp:663ab05e-dc52-42c8-8a14-ead499458bb8` |
| F ui | `goat2_ui` | `mcp:8c388538-1483-4d66-bcc7-d1851d79fbb0` |
| G desktop + Dev build | `goat2_desktop` | `mcp:c355676a-7fca-48ea-80ed-c6263699fd34` |

Separate: GOAT v1 startup-stall root fix + Nightly release, on mac-studio, thread
`mcp:0ff09b33-5f46-43e3-bcf5-24a070c1ca90` (branch `perf/startup-stall-root-fix` on `dev`).

## Part 2 lanes (wave 1, launched 2026-11-28 ~23:20 KST; rules: docs/lanes/PART2.md)

| Lane | Branch / worktree | GOAT thread |
|---|---|---|
| P2-A Claude driver | `goat2_engine_claude` · `~/Developer/goat2_engine_claude` | `mcp:d2687335-41f7-47cb-ac8d-72a2fcfdde85` |
| P2-B ACP driver + registry | `goat2_engine_acp` · `~/Developer/goat2_engine_acp` | `mcp:a075e047-c61d-4fe5-add6-a335ca44ca3e` |
| P2-S SDK helper (Cursor, OpenCode, Muse, Pi/OmO) | `goat2_engine_sdk` · `~/Developer/goat2_engine_sdk` | `mcp:c5d1ee21-481b-490f-8e7c-20a831758e76` |
| C contracts (continues: trait additions first) | `goat2_contracts` | `mcp:628b0dd7-0b60-4332-9be9-0078ee058667` |

Wave 2 (launched 2026-11-28 ~23:40 KST after host merge 635e915):

| Lane | Branch / worktree | GOAT thread |
|---|---|---|
| P2-E bot runtime (in goat2-host) | `goat2_bot_runtime` · `~/Developer/goat2_bot_runtime` | `mcp:6ea90504-b8ce-4448-9a30-82d756b5e19f` |
| P2-M providers UI | `goat2_providers_ui` · `~/Developer/goat2_providers_ui` | `mcp:28f74b44-8da9-4850-904d-47f6dd9311e0` |
| P2-F bot UI = lane F continues | `goat2_ui` | `mcp:8c388538-1483-4d66-bcc7-d1851d79fbb0` |
| P2-D parity = lane D continues | `goat2_parity` | `mcp:6bee8c38-9aa4-4405-9f97-61e074c2998c` |

## Machines (owner rule 2026-11-28 ~23:45 KST: this Mac was at load ~57 on 18 cores)

| Machine | Lanes | Notes |
|---|---|---|
| this Mac (`juns-macbook-pro`, M5 Max) | A store, B codex, C contracts, D parity, G desktop | G installs GOAT 2 (Dev) here; builds may run on mac-studio and rsync back |
| `mac-studio` (16 cores, 64 GB) | E host, F ui, P2-E bot runtime (`mcp:b9201259-20ae-419f-a056-b7d282998052` there), P2-M providers UI (`mcp:77dce1e5-4b6a-4b79-82fb-5f4ccbacd573` there) | E and F move at their next safe point |
| `macbookpro2` (15 cores, 48 GB) | P2-A claude, P2-B acp, P2-S sdk | move at their next safe point |

Remote thread ids replace the local ones after handoff (read with `goat_thread_read {host, threadId}`).
Each machine merges in its own `~/Developer/goat2`; the non-force push of `goat2` is the cross-machine lock.

Cross-machine messages: `mac-studio` and `macbookpro2` have the SSH alias `juns-macbook-pro-origin` for the origin Mac,
so a remote lane calls `goat thread.send {host: "juns-macbook-pro-origin", threadId}` to reach a lane still there; the
origin reaches remote lanes with `host: "mac-studio"` / `"macbookpro2"`.
