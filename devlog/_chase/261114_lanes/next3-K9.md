# K9 · server, providers, and MCP

Base at start: `2c0e0002a996ec5d46c708919be5a43f579176fa` (`origin/chase/t3-261114-next3`). The GOAT-managed checkout arrived on `goat/upstream-catchup-server-providers-mcp` at that exact commit. The lane branch was created there.

Status **BLOCKED on the current integration tip**. Lane branch `chase/t3-261114-next3-k9` was pushed by plain refspec and verified at `9c9b6d688a315b5195f0b264cc1ce5e16ff92d30`. The lane gate passed on that head against the integration parent it merged, `6def29ca359f546e50dcd731a6364e3f0d575545`.

## Compatibility and implementation plan (before code)

- `76b3e3390e` (C4): older MCP clients send the same bearer to the new server, and newer clients can use the same bearer format on older servers with their old wall-only expiry. The dual-clock age stays in memory. Keep S4's independent client-session cut and GOAT's tombstone, attached-session renewal, revocation, and request-generation checks. Negative cases are a rollback before expiry is observed, rollback after expiry was observed, a detached provider, and permanent revocation. Match upstream's larger elapsed reading and non-revival after observed expiry. GOAT already records expiry via tombstones, so reuse those instead of adding upstream's expired flag ([upstream](https://github.com/pingdotgg/t3code/commit/76b3e3390e2fdb824a3afbc7e6b5300cfec7a6b3)).
- `9c96180aa3` (C2): validate a newly launched project's existence in GOAT's shared launch service, after authorization and replay lookup, before model/default or worktree checks. Upstream reads the project once for new launches and keeps a receipt replay independent of the current project. GOAT places that read in its existing shared local/forwarded launch service and retains scratch and governance admission ([upstream](https://github.com/pingdotgg/t3code/commit/9c96180aa3e0d216abf7b4eaa5e6e03f4cc18541)).
- `75c7fb28af` (C4): old clients can still list and import via unchanged RPCs; old clients omit/ignore the optional repair hint. New clients treat a missing hint from an old server as the existing Open action. Use the existing event types and `v1_import` origin so stored rows do not require a schema migration. Negative cases include no native history, resume-only agents, an already-run thread, an interrupted/failed read, and retries. Upstream uses an ACP snapshot followed by a guarded transaction and an optional repair hint. GOAT already owns the transport-independent session service (including continuation paging and deletion) and retains those paths when adding the history read ([upstream](https://github.com/pingdotgg/t3code/commit/75c7fb28af1d80d0941fa276d5d8f67c2f85c379)).
- `b125e89768` (C4 provider protocol): native-fork requests keep the same method, fork boundary, and returned thread. Older GOAT clients keep working with newer GOAT servers; newer clients preserve their existing fork path on older GOAT servers. At the provider boundary, verify that a Codex app-server predating the property accepts the extra parameter and that unrelated errors never cause a second fork. Upstream requests `excludeTurns: true` and consumes the fork identity. GOAT uses its fork helper so the archived-source recovery remains in the same path ([upstream](https://github.com/pingdotgg/t3code/commit/b125e897682dc380f362925be5f9c4efaa02b0d2)).
- `476fc9be66`: compare GOAT's existing test/report implementation and CI wiring with the upstream row. No wire change from exporting existing query schemas. Keep the GOAT CI workflow as the entry point.

## Verdicts

| Upstream row | Verdict | GOAT commit |
| --- | --- | --- |
| `76b3e3390e2fdb824a3afbc7e6b5300cfec7a6b3` | Adapted. Dual-clock age governs issue, pruning, lookup, inspection, refresh and memory policy. Tombstones keep the existing provider renewal and permanent-revocation distinctions. | `170ab25a26d` |
| `9c96180aa3e0d216abf7b4eaa5e6e03f4cc18541` | Adapted. One checked project read in the common MCP launch service after permission and admission checks. Existing scratch and forwarded calls share it. | `0bdd85e05c6` |
| `75c7fb28af1d80d0941fa276d5d8f67c2f85c379` | Adapted. Load-capable ACP imports write run-less text and reasoning atomically. Pending imports can be repaired through Settings. Resume-only agents retain the existing native thread binding. The commit checks the current project's native binding and run state again under the thread command lock. | `edb16fb9ce3` |
| `b125e897682dc380f362925be5f9c4efaa02b0d2` | Adapted. Request a metadata-only fork in GOAT's shared Codex helper. The old app-server accepted the added parameter. | `c88b4a4403a` |
| `476fc9be6691ab0d81e936f4cc674983cf3913be` | Already covered in part by `f5c1fb4e15e` via `02511156b05` (#3397). The stale-shell scenario is deferred to the K7b shell fallback landing (`9557ab46c5` / `2482b03a01`). GOAT's local report, result and scenarios are already wired. L09 recorded that the upstream PR comment job and its helper are outside the GOAT workflow. | `02511156b05` for the covered parts |

GOAT-side review range `6def29ca359f546e50dcd731a6364e3f0d575545..9c9b6d688a315b5195f0b264cc1ce5e16ff92d30`. The seven lane commits precede the integration merge on the first parent. The three preparatory moves are `3240ff1d188` (project deletion test), `df22b6ff0d0` (PR equality and ACP snapshot reset) and `d0ce520b164` (Codex replay response helper). Clean cherry-picks: none. There were no product decision rows.

### Codex replay expectation authorization and compatibility

The coordinator authorized the `thread/fork` expectation update under Rule 3 IV. Inline `CodexAdapterV2.test.ts` paginated fallback before `params: { threadId: nativeThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG }`, after `params: { threadId: nativeThreadId, excludeTurns: true, config: CodexAdapterV2.CODEX_THREAD_CONFIG }`. In `codex_transcript.ndjson` in `thread_fork_native_continue` (1 frame), `thread_fork_native_prior_turn` (1), `thread_fork_native_siblings` (2) and `thread_merge_back_siblings` (2), before `"params":{<original fields>}`, after `"params":{"excludeTurns":true,<original fields>}`. Replies and assertions are byte-identical. Three further GOAT inline fixtures were identified by the full gate:
- `CodexAdapterV2.computerUse.test.ts` before `{ threadId: f.nativeThreadId, ...params }`, after `{ threadId: f.nativeThreadId, excludeTurns: true, ...params }`.
- `CodexAdapterV2.forkCwd.test.ts` before `{ threadId: nativeThreadId, cwd: targetCwd, ... }`, after `{ threadId: nativeThreadId, excludeTurns: true, cwd: targetCwd, ... }`.
- `CodexAdapterV2.homeRoute.test.ts` before `{ threadId: nativeThreadId, ...routed }`, after `{ threadId: nativeThreadId, excludeTurns: true, ...routed }` (covers two cases).

Official `@openai/codex@0.135.0-darwin-arm64`: generated `v2/ThreadForkParams.json` omitted `excludeTurns`. A scratch-home stdio app-server initialized and returned the same `-32600 no rollout found for thread id` for an absent UUID both with and without the added field. A second probe forked a synthetic local rollout with the field and received a new thread ID. Both app-server and probe exited 0. No agent turn ran. The earlier 0.120.0 executable stalled at startup and its owned command session was stopped with exit 130. This validates the older parser and unchanged application-level refusal, with successful fork and boundary behavior covered by replay.

### Newer upstream commits

Path history for upstream's touched files in `93cbca3fcbd..8a6342e7613`, deduplicated within each row. Shared files such as `Orchestrator.ts` contribute commits outside this lane's specific hunks.

- `76b3e3390e` (1): `0597b9edcdb`.

- `9c96180aa3` (13): `e5d757f51b3`, `4ffa1da7cfe`, `1adc05b8445`, `ffd11ffc95c`, `35b88636d43`, `dfd2187ccb0`, `bc7fe11002a`, `dc7ea2c1b0d`, `5393882fb80`, `b5379160993`, `c71f98cadf6`, `19b33eca4c4`, `2f2730c1134`.

- `75c7fb28af` (85): `47f90ee2e94`, `834eb51301a`, `bee9c3b796f`, `f6d196463cf`, `5dd8cde0831`, `b0a46d28482`, `e8bfabaa398`, `623047ccfd6`, `649d9fc1ab1`, `b35c9702f94`, `ea4e7c1a604`, `7f6e403a888`, `bbda0c10711`, `1c18c16e931`, `0351dbb0920`, `35d01dc291a`, `0aeb9457067`, `1c818a80830`, `81fd06998c6`, `0597532f16d`, `25fada9351c`, `33542a53be7`, `135d7a98012`, `0df1967cfa6`, `0597b9edcdb`, `c71f98cadf6`, `ccae953c46c`, `b79d277cdda`, `e05b087a34b`, `c02b98bb3fd`, `ad1b1365999`, `5da89cfceba`, `e367ef0da11`, `19b33eca4c4`, `6071022cb71`, `d2a894a247c`, `3209fa9534f`, `85168744f7d`, `7a72fe301ca`, `2c5013d153f`, `f5ca0f9427e`, `3e176182122`, `a68c367e4ff`, `4d47d0b76ec`, `a767d232976`, `2e331341862`, `a4bf7922f57`, `997b304dd65`, `cc578d5f9a3`, `719042d9425`, `77ad2ebec50`, `298c38d7f28`, `9e19b7f7e1a`, `a8777e4c7a5`, `9d6da455e20`, `b5379160993`, `aaa3dbabb1f`, `931cd3afab3`, `bc91203bc32`, `13f89ae0a7f`, `91fa913be9c`, `c2e54e3ac9c`, `86863beedef`, `20501a02213`, `94edd64e74c`, `a2edd281df2`, `4ffa1da7cfe`, `7d32075e375`, `14f295e0110`, `46f3ab39f22`, `3a5d7f39a8a`, `a575d45286f`, `2d80cb6bc75`, `055b44919ee`, `5ef603df343`, `aee231133ae`, `632802cd324`, `46b508d119b`, `b4e47a5a62e`, `f82162f0336`, `4b9cf579ba6`, `23ba9b35511`, `1dfc746c8f4`, `51cdf232652`, `03e05f6235c`.

- `b125e89768` (18): `8009cd8c3bc`, `ea6d3fc30fb`, `c02b98bb3fd`, `51cdf232652`, `f1919eb1e29`, `96290af4e0d`, `467ec62e08d`, `1e60d60519c`, `4afa6f0983d`, `6f06f2675d2`, `6b9d90f1213`, `66a40c7ca82`, `f3b43efd9a4`, `9e19b7f7e1a`, `99071c4953b`, `be78ee49401`, `5393882fb80`, `52074e92585`.

- `476fc9be66` (6): `b823ddadd9c`, `86863beedef`, `183029dee8a`, `70b052904b1`, `a62bc8156da`, `a2edd281df2`.

## Verification

- Failing-first guarded server runs: `McpSessionRegistry.test.ts` exit 1 (31 pass, 1 fail, recheck computed against the old wall deadline); `handlers.test.ts` exit 1 (31 pass, 1 fail, an unknown project reached launch); `AcpSessionService.test.ts` exit 1 (8 pass, 1 fail, import never copied history); `CodexFork.test.ts` exit 1 (1 pass, 1 fail, metadata-only option absent).
- `git fetch origin; git merge origin/chase/t3-261114-next3` exit 0, "Already up to date", integration `2c0e0002a996ec5d46c708919be5a43f579176fa` was already HEAD's ancestor. No lockfile changed.
- First changed-files run on the pre-fix head reached typecheck and reported TS2322 for a nullable native ID. Interrupted the owned gate with exit 130, added a null guard, and autosquashed the fix into the unpublished ACP row.
- ACP session codec check with Node 26.12.1, exit 0. The old struct ignores the repair hint and the new struct decodes both absent and present hints.
- Guarded command from `apps/server` on `9d118df1d48fd751f5a627957ae8d742ce0ed123`: `GOAT_TEST_TMP_GUARD=fail vp test run <files below>`, exit 0. 11 files, 282 passed, 0 failed, 0 skipped. Vite+ selected Node 26.13.1 for this package-cwd invocation.
  - `src/mcp/McpSessionRegistry.test.ts` (32).
  - `src/project/AgentSessionImportCompatibility.test.ts` (2).
  - `src/project/AgentSessionImporter.test.ts` (5).
  - `src/provider/AcpSessionService.test.ts` (9).
  - `src/provider/CodexFork.test.ts` (2).
  - `src/orchestration-v2/Orchestrator.migration.test.ts` (2).
  - `src/orchestration-v2/Adapters/CodexAdapterV2.test.ts` (191).
  - `src/orchestration-v2/testkit/ThreadFork.integration.test.ts` (4).
  - `src/orchestration-v2/testkit/ThreadMergeBack.integration.test.ts` (2).
  - `src/mcp/toolkits/project/handlers.delete.test.ts` (1).
  - `src/mcp/toolkits/project/handlers.test.ts` (32).
- Second changed-files run passed every static check at the previous integration base. The coordinator advanced integration while Vitest was still running. Stopped the owned run with exit 130 and merged the newer integration head before running the final gate.
- Final integration merge `git merge --no-edit origin/chase/t3-261114-next3`, exit 0, ort and no conflicts. Merge commit `f58d33321fdc0349e9f822e9bc82036c8ff4ef2a`, first parent `9d118df1d48fd751f5a627957ae8d742ce0ed123`, integration parent `6def29ca359f546e50dcd731a6364e3f0d575545`. The lockfile diff is empty.
- First merged-head gate exited 1. Every static check, 451 server files (5,511 tests), and all 44 workspace files (2,614 tests passed, 2 skipped) passed. Four failures across three strict Codex replay fixtures expected the old outbound frame. The corrections above were autosquashed into the unpublished Codex row. The recreated merge preserves the same integration parent and the exact post-fix tree.
- Final merge `9c9b6d688a315b5195f0b264cc1ce5e16ff92d30`, first parent `c88b4a4403ad2a1f96f624e649f12237b438041d`, integration parent `6def29ca359f546e50dcd731a6364e3f0d575545`.
- Pinned guarded check from `apps/server`: `GOAT_TEST_TMP_GUARD=fail vp env exec --node 26.12.1 -- node <workspace Vitest executable> run <files below>`, exit 0. All 12 changed server test files ran whole, 299 passed, 0 failed, 0 skipped.
  - `src/mcp/McpSessionRegistry.test.ts` (32).
  - `src/project/AgentSessionImportCompatibility.test.ts` (2).
  - `src/project/AgentSessionImporter.test.ts` (5).
  - `src/provider/AcpSessionService.test.ts` (9).
  - `src/provider/CodexFork.test.ts` (2).
  - `src/orchestration-v2/Orchestrator.migration.test.ts` (2).
  - `src/orchestration-v2/Adapters/CodexAdapterV2.computerUse.test.ts` (19).
  - `src/orchestration-v2/Adapters/CodexAdapterV2.forkCwd.test.ts` (1).
  - `src/orchestration-v2/Adapters/CodexAdapterV2.homeRoute.test.ts` (3).
  - `src/orchestration-v2/Adapters/CodexAdapterV2.test.ts` (191).
  - `src/mcp/toolkits/project/handlers.delete.test.ts` (1).
  - `src/mcp/toolkits/project/handlers.test.ts` (32).
- Final `vp run check:changed origin/chase/t3-261114-next3` on `9c9b6d688a315b5195f0b264cc1ce5e16ff92d30` against `6def29ca359f546e50dcd731a6364e3f0d575545`, exit 0. Rename scan found zero residue. Format, lint, both knip checks, server GraphQL, agent surface audit, context budget, and typecheck of 38 packages passed. 454 server files (5,515 passed) and 44 workspace files (2,614 passed, 2 skipped), for 498 files and 8,129 passes, 0 failures, 2 skips.

## Current integration blocker

While the final gate ran, origin integration advanced to `061fd0fee904c2abaada9efb5cfdb9ea58b18919`. After fetching that ref, `git merge-tree --write-tree HEAD origin/chase/t3-261114-next3` exited 1 with conflicts in `apps/server/src/project/AgentSessionImporter.ts` and `apps/server/src/project/AgentSessionImporter.test.ts`. The overlapping commits from SF2 are `c5231efd89f`, `512f0b9b971`, `db4154bb661` and `c80ceb77586`. The lane already merged integration once. The coordinator owns the next integration merge.

Resolve the production conflict by keeping SF2's ordinal-derived `importMessageId` and transcript certification/project ownership rules (current integration file at lines 85–115 and 217 onward), then use the same message ID helper in K9's run-less ACP event writer (lane `AgentSessionImporter.ts:97`). Keep the native history read and locked persistence at lane `AgentSessionImporter.ts:464`. In the tests, preserve SF2's optional scanner fixture and retry expectations, add the adapter fixture to the existing importer harness, and keep both suites (harness near line 182 and K9 history test near line 487).

## Integrated P1

- Settings → Native sessions on web/desktop. Import a scratch ACP session and open the thread. Verify earlier prompt, reply and reasoning, then retry an incomplete import and check that history appears once. Continue the same native session and verify that the saved transcript is not resent as a handoff.
- Fork a scratch Codex thread at an earlier native turn and open the fork. Verify the boundary and continuation from the fork. The old app-server smoke used a synthetic offline rollout.
- Ask MCP to launch against an absent project ID and verify the refusal names the project problem and no thread appears.

NOT RUN: Reconciled current-integration gate, lane CI, integrated P1 real-client pass, live provider turns, repo-wide checks, and the stale-shell transfer-budget assertion pending the K7b fallback.


## Coordinator-authorized merge with U05

`git fetch origin` returned 0 and confirmed the instructed integration head `061fd0fee904c2abaada9efb5cfdb9ea58b18919`. `git merge --no-edit origin/chase/t3-261114-next3` exited 1 with the two expected conflicts. The resolved merge commit is `029c00acb6347a79a539c535917a3eb69441b612`, with first parent `9c9b6d688a315b5195f0b264cc1ce5e16ff92d30` and integration second parent `061fd0fee904c2abaada9efb5cfdb9ea58b18919`. The conflicting attachment/transcript ingest changes were U05. The lockfile comparison returned 0 with an empty diff. The commit hook passed format and lint.

- `AgentSessionImporter.ts:87` retains U05's ordinal-based message identity and original transcript matching. The shared event builder at line 117 calls U05's `importMessageId` for text and emits a run-less reasoning turn item for ACP thoughts. The bodies of U05's `importRecentAgentThreads` and K9's `importNativeHistory` match their parents verbatim. The native read, lock, binding recheck, atomic commit, and repair path are retained.
- `AgentSessionImporter.test.ts:186` accepts either parent's optional fixture. The merged nine test bodies are byte-identical to their owning parents, using U05's already-reviewed expectations for shared cases. This preserves the linked-worktree scan-budget fixture, partial retry and owner checks, and ACP failed-read retry. `AgentSessionImportCompatibility.test.ts` retains the integration parent's parameterized test body verbatim. The U05 scanner and parser suites also ran whole.
- From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp env exec --node 26.12.1 -- node <workspace Vitest> run <whole files>` exited 0. 15 files, 371 passed, 0 failed, 0 skipped. Importer 9, compatibility 2, scanner 47, Codex history scanner 2, transcript parser 19, ACP session service 9, orchestrator migration 2. Remaining guarded files: MCP registry 32, project handlers 32 and deletion 1, Codex adapter 191, computer use 19, fork CWD 1, home route 3, fork helper 2.
- Completed `vp run check:changed origin/chase/t3-261114-next3` on `029c00acb6347a79a539c535917a3eb69441b612` against the instructed integration parent `061fd0fee904c2abaada9efb5cfdb9ea58b18919`. The surviving gate log records every step passing, including typecheck of 38 packages, 458 server files with 5,540 tests passed, and 44 workspace files with 2,616 tests passed and 2 skipped. Total: 502 files, 8,156 passed, 0 failed, 2 skipped. The log reached the success branch (exit 0 by the checker) and reported an input-key change so the result was not cached. The provider exit severed the original shell exit receipt. The tracked tree was clean on resumption and after the run. The already-running gate was allowed to finish without a concurrent or duplicate gate.
- Plain push exited 0. `git ls-remote` confirmed `chase/t3-261114-next3-k9` at `029c00acb6347a79a539c535917a3eb69441b612`. The newer integration tip `258239d88f0c5df1ef43d787957007d1775f823d` also passed a read-only `git merge-tree --write-tree` compatibility check (exit 0, tree `4983030383b080f5f01066ee0b4a54cf757b05a1`).

Status **READY**. NOT RUN: gate on a combined tree with the newer integration tip, lane CI, integrated P1, and the stale-shell budget assertion deferred to the shell fallback.


## Review fix round 1

Base `029c00acb6347a79a539c535917a3eb69441b612`.

- P1 reuses the scanner's 32 MiB transcript budget and its 200-message output ceiling as precedents. ACP replay rejects over-limit snapshots because writing a partial prefix and marking it imported would prevent repair. [Scanner budget](https://github.com/goat-si/goat/blob/029c00acb6347a79a539c535917a3eb69441b612/apps/server/src/project/AgentSessionScanner.ts#L104-L107) and [parser message ceiling](https://github.com/goat-si/goat/blob/029c00acb6347a79a539c535917a3eb69441b612/apps/server/src/project/AgentSessionTranscriptParser.ts#L17).
- P2-1 scopes strict startup to snapshot opens. A continuation open still uses the existing ACP recovery flow. Snapshot opens require load capability and fail before creating a replacement when the existing session cannot be loaded.
- P2-2 changes only the server-internal credential inspection and stream wake. Old and new clients use the same bearer and receive the same lease events in both directions. The negative case is rollback after inspection while a settings read is suspended. Native lease-expiry timestamps remain wall-clock deadlines.
- P2-3 keeps the existing import result requirements. Older clients ignore optional history fields, and newer clients receiving an old result can still list the session to see pending history. The negative cases are a first read failure with the thread retained, an oversize history with a recovery message, and a successful repair that clears the action. No stored schema changes.

### Fixes and failing-first receipts

| Finding | Commit | Failing check and result after the fix |
| --- | --- | --- |
| P1 | `646ff3b1954` | ACP whole-file byte and message boundary probes exited 1 on the previous code, 2 failures. After the fix, exit 0 and 2 passed. The helper checks retained UTF-8 bytes and message count before joining or appending. It latches overflow and drops the buffered snapshot. The native history is never partially persisted. |
| P2-1 | `afebcae5b2f` | The ACP history suite exited 1 with one failure. A failed load opened a second runtime without a native ID. After the fix it exited 0 with 3 passed. The strict path requires load capability and the existing session ID, returns the original load failure, and avoids replacement or reload. |
| P2-2 | `de58b0e1e56` | The fenced stream suite exited 1 with one failure. The old stream stayed open when the monotonic clock reached the credential deadline after rollback. The three focused suites then exited 0 with 35 passed. Existing inspection expectations keep their wall times and add the paired monotonic fields. |
| P2-3 | `14e7c22e6a7` | First-import failure in the service and the missing repair button in Chromium each failed before the fix (exit 1, 1 failure per suite). The importing client gets the optional pending hint and a bounded recovery message for oversize. It can retry on the current row. Successful repair clears the hint. |

### Correction to the Codex compatibility record (P3)

The 0.135.0 stdio smoke used `experimentalApi: true`. The tagged Rust `ThreadForkParams` in 0.135.0 already declares `exclude_turns` as experimental. The earlier schema dump omitted that property and was insufficient to establish absence. The live probe therefore exercised a version that contains the field. The pre-field case is **source-verified only** using the tagged 0.120.0 `ThreadForkParams`, whose Serde definition omits the field. No pre-field binary run completed. [0.135.0 source](https://github.com/openai/codex/blob/rust-v0.135.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L508-L516) and [0.120.0 source](https://github.com/openai/codex/blob/rust-v0.120.0/codex-rs/app-server-protocol/src/protocol/v2.rs#L2770-L2829).

### Verification

- Guarded run on Node 26.12.1 from `apps/server`, exit 0, 6 files and 56 passed. Whole suites: `AcpAdapterV2.history.test.ts` 3, `ComputerUseLeaseThreadStream.fenced.test.ts` 2, `ComputerUseLeaseProxy.crossProcess.test.ts` 1, `McpSessionRegistry.test.ts` 32, `AcpSessionService.test.ts` 9, and companion `AgentSessionImporter.test.ts` 9.
- `vp env exec --node 26.12.1 -- vp test run --reporter=default apps/web/src/components/settings/AcpSessionManagementSection.browser.test.tsx` exited 0, whole Chromium file with 17 passed.
- Integration preview against tip `258239d88f0c5df1ef43d787957007d1775f823d` exited 0. No integration merge for this round.
- Final focused receipts on `14e7c22e6a7464a061dcfd077da3abe5ac27da92`: targeted typecheck exited 0 (4/4 packages), guarded server exit 0 (6 files, 56 passed), Chromium exit 0 (1 file, 17 passed). The legacy import-result decoder strips both optional extensions and the current decoder accepts both prior and pending results (codec smoke, exit 0).
- Full `vp run check:changed origin/chase/t3-261114-next3` on `14e7c22e6a7464a061dcfd077da3abe5ac27da92` exited 0 (durable shell receipt). The command started with integration ref `258239d88f0c5df1ef43d787957007d1775f823d` and used merge base `061fd0fee904c2abaada9efb5cfdb9ea58b18919` as reported by the gate (abbreviated `061fd0fee904`). Format, lint, both knip passes, GraphQL, agent surface audit, context budget, and typecheck of 38 packages passed. 460 server files / 5,547 passed and 44 workspace files / 2,617 passed, 2 skipped. Total 504 files, 8,164 passed, 0 failed, 2 skipped.
- Plain lane push exited 0 and `git ls-remote` confirmed the tested head. Final preview against fetched integration `9af811b8fc3d2fc0039efbafee606ca358d5a490` exited 0 (merge tree `39f12b2827d23ccd71a5db11ee21b0ae21046d83`).

Status **READY**. NOT RUN: CI and integrated P1 real-client pass (coordinator), and a live pre-field Codex app-server smoke.
