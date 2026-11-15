# L09 retry: server misc (lane record)

Lane branch: `chase/t3-261114-server-misc-retry`, head 10b92be000, from origin/chase/t3-261114-all at 56421003ff. The original L09 lane merged as 85920591b0 (#3273); this file is the retry round's full record. Upstream range fa2f4ff2a2..93cbca3fcbd. Round 1 ended at e363f29d85 (review: APPROVE WITH NITS, two P2); round 2 (fix delta and the two items not attempted) adds e89c99947a..10b92be000.

Count: 10 ported, 1 landed in L03m, 5 real deferrals, 0 not attempted (16 upstream commits), plus the 3376c8da92 partial row.

## Decisions

| upstream | decision | GOAT commit | reason |
| --- | --- | --- | --- |
| b703fdbfdb a git action that fails partway refreshes the Git panel | adapt | fdff4ad5b0 | ws.ts change verbatim (refreshGitStatus before failing the stream). Test in the new ws.gitActions.test.ts with GOAT's layerWsRpc arguments. Move first: 725e2c3249 (access list stream into auth/AccessRpc.ts; ws.ts 3736 -> 3646). The prepared patch's blocking refresh was not used; upstream's detached refresh is. |
| c03f84bcde stream the usage-scan cache to disk | adapt | 46f44eb09f | Streaming writer and atomic write taken; GOAT keeps encodeScanCache. Superseded cache files and temp folders idle for an hour are removed after the current cache is saved; upstream's .active negative case is carried. Move first: 778b6872ef (upgrade case into usageCacheUpgrade.testkit.ts). |
| 9cb45ec0b7 text generation falls back to an enabled custom instance | adapt | e83a91b06a | includeConfiguredInstances removed; machine-scope caller apps/server/src/serverSettings.ts gains configured instances. Upstream's own test edit carried (rename, flip, delete the opt-in case). TextGeneration.ts hunk has no GOAT counterpart. |
| 729f6757d9 Claude subagent output no longer undercounted | adapt | 4aafe25e50 | Copies of a key merge by channel maximum; cache v12. New usageClaudeCopies.testkit.ts carries upstream's lifecycle case and adds a v11-file-on-disk case. Non-null assertion narrowed (lint). Predecessor of L02's b42841808d: ported here. |
| 5ff3d3c0ec Claude 1-hour cache writes priced at the 1-hour rate | adapt | 0926d3f5f7 | Taken; cache v13; upstream test edits carried; adds a v12-file-on-disk case (cost 8.5 vs 6.25, v12 file removed). Predecessor of L02's b42841808d: ported here. |
| 3595b9e038 access list keeps changes made while its stream opens | adapt | 4ff38f9a07 | Upstream's Queue.unbounded replaced by a 256-change dropping queue per subscriber (docs/internals/server-resilience.md, every buffer has a bound); on overflow the next pull clears it and sends a fresh snapshot as the next revision (clients replace their list on any snapshot, packages/client-runtime/src/state/auth.ts:33). Changes are taken one per pull. Lives in auth/AccessRpc.ts. Tests: upstream's case plus an overflow case, ws.authAccess.test.ts. |
| 4b316fd544 clear deleted checkout labels from the sidebar | take | 84a0326c83 | ws.ts change verbatim. Upstream ships no test; added one: a removed checkout's subscriber gets the non-repository update with the test clock stopped (no polling). |
| 5c0eb5124e a missed fixed-time slot shows as failed | adapt | ccbabda41a, a2c485b248, 7c4de1a9b6 | Missed slot marks the task failed and clears last_firing_id so clients fall back to lastRunStatus/lastRunError; reschedule guarded on the snapshot's next_run_at and last_run_at (upstream's stale-slot guard). Move first: c5bd431a12 (makeDueHint into dueTaskHint.ts). recordRunFailure's reason (round 2, a2c485b248): GOAT's run rows already follow the dispatched run, so instead of upstream's 24-hour waiter the terminal transition in ScheduledTaskRuns.writeResolvedSnapshots (the place onFiringTerminal fires once) stores latestRootProviderFailure's message, else upstream's sentence ("The run was stopped." ...), capped at 500 characters; later receipt changes keep it. Upstream's three-outcome test carried in ScheduledTaskOutcomes.integration.test.ts with two more rows (failed without a provider reason, a 4096-character reason). 7c4de1a9b6: optional lastRunError on goat_schedule_list/create/update and run_scheduled_task_now (older hosts omit it; contracts test reads the new field with an older schema). |
| c398b46af0 Codex text generation runs when launch args define an MCP server | adapt | 2b8263bb1b | Off table before launch args, again after them only when they set an mcp_servers table, dotted per-server off flags after them; applied to GOAT's execLaunchArgs (reception isolation / OpenCodex route args). Fake mcp_servers handling in the testkit; two new cases (launch-arg server; replacement table with dotted and spaced names) in CodexTextGeneration.mcpServers.test.ts, server name "goat". Moves first: 2f180929b5, e363f29d85. |
| 8af1fc110e import seed snapshots with peer preview migrations | done in L03m | 730d25fcec (in chase/t3-261114-all) | Landed with the migration shift. Nothing left here. |
| becc7d3510 Tailscale Serve route holder and dead-port repair | adapt | 777b4ea48b | Round 2. The serve-status parsing subset from d897d3f3f0 (skipped in 261103 as D-POLICY for its policy half) goes into a new packages/tailscale/src/serveRootHolders.ts: the Serve config schema (Services and Foreground are not read), Go-style proxy expansion and dialed host:port, and parseTailscaleServeRootHolders; readTailscaleServeRootHolders in tailscale.ts. GOAT's TailscaleServeStartup keeps its scoped retry and release: the holder check runs inside the forked attempt, so another live server's route or an unreadable status skips ensure, attempted stays false and release never turns it off; every 30 seconds a route found on a dead loopback port is taken back (attempted set first, so release then removes it). Upstream's parser test carried (serveRootHolders.test.ts, Service renamed svc:goat); three startup cases added (other, unreadable, dead-port repair on TestClock). docs/user/remote-access.md: one sentence. |
| a09e54a363 proxied usage limits take their reset time from the CLIProxyAPI hub | real defer | none | Round 2. Predecessor c9dfc404cc (custom Codex providers no longer report native quota) is ported only on L02's retry lane (90b3a526f3, chase/t3-261114-adapters-retry; L02-retry.md:16), not in chase/t3-261114-all: a09e54a363's codexCustomEndpoint is built on that commit's codexRouteBaseUrl/routesToNativeOpenai, which GOAT's CodexProvider.ts lacks, and its contracts (ServerProviderAuth.endpoint, UsageLimitSourceSnapshot.origin) and ProviderEventIngestor fallback serve that endpoint. Port after L02 retry is in chase/t3-261114-all; then also decide whether the OpenCodex quota-pool source (UsageLimitSources.ts:139, no URL origin) answers resets for OpenCodex-routed instances, and test unrelated endpoints and unavailable accounts. |
| 06bd84623b wire budget covers stale todo lists | real defer | none | Needs b015ffd7c2's code half (ProjectionStore.ts +174/-40 and its ProjectionStore.test.ts cases; L03.md:28). Only its migration landed (82f2b9fd0d in chase/t3-261114-all). 61cb845d96 is on the integration tip since 74ae8cc7b2; the blocker is b015ffd7c2's code half itself. |
| 476fc9be66 wire budget measures what clients fetch today | real defer | none | Needs 06bd84623b (above). .github/scripts/thread-transfer-report.cjs and ci.yml stay under the cycle's upstream-CI skip. |
| 7fab4ef978, 9a614e34a6 | real defer | none | Need b42841808d (L02), not on dev or in chase/t3-261114-all. Its predecessors 729f6757d9 and 5ff3d3c0ec are now on this lane branch. |
| 3376c8da92 legacy compile-cache cleanup | partial (#3273) | none | Unchanged this round: the cleanup of Node engine folders v<digit>* under goat/compile-cache (apps/server/src/cliCompileCache.ts:10, cliCompileCache.test.ts:83) waits on owner approval of that deletion. |

Round 2, review P2-1 (e89c99947a): usageClaudeCopies.testkit.ts:60 and :119 and usageCacheUpgrade.testkit.ts:153 are it.effect again (filesystem fixtures only; upstream 43ce39595b, GOAT's e74e5c2030 port of it was undone by round 1).

## C4

- c03f84bcde deletes files: superseded scan-cache versions and temp folders idle for an hour. Negative case: a fresh `.active` temp folder survives (usageCacheUpgrade.testkit.ts upgrade case, asserted directory listing).
- Cache format (coordinator: not a migration). v11 -> v12 (729f6757d9) and v12 -> v13 (5ff3d3c0ec) each have a previous-version-file test (usageClaudeCopies.testkit.ts, usageCacheUpgrade.testkit.ts). Downgrade: a GOAT at v11 reads only usage-scan-cache-v11.json and rejects versions above 11 (usageScanCache.ts:20 and :190 before 4aafe25e50); a GOAT at v12 likewise. After a downgrade the older server ignores the newer file and rescans transcripts; usage of transcripts deleted since its own file was removed is gone on that server.
- 3595b9e038 (auth access stream): revocation during snapshot loading is upstream's case; overflow case added. Wire contract unchanged; an older client already applies a snapshot event at any revision.

## Known limits

- 3595b9e038: a burst over 256 access changes costs one extra snapshot read per subscriber.
- 5c0eb5124e: when a missed slot follows a firing whose run is still running, the task card shows the missed failure; that run's outcome stays visible in its thread.
- 4b316fd544 and b703fdbfdb fail-first evidence is a project timeout (120 s) on the old code, as in upstream's test.
- 4b316fd544: removing a worktree through the agent tools (apps/server/src/mcp/WorktreeInventoryService.ts:666) still does not refresh the removed path; upstream has the same scope. Follow-up: goat#3432.
- 5c0eb5124e: a stored run reason is cut at 500 characters (499 plus an ellipsis).
- becc7d3510: if the Serve status cannot be read at start, Serve stays off until a later check finds the route on a dead port or the server restarts (upstream does the same). The 30-second check runs `tailscale serve status --json` while the server runs with Serve enabled.

## Surfaces

What users see: new Claude costs for subagent output and for 1-hour cache writes (Usage page); a scheduled task card shows "Failed" with its reason, such as the provider's usage-limit message, "The run was stopped." or a missed fixed-time slot; the Git panel refreshes after a git action fails partway; a removed checkout's sidebar label clears; Tailscale HTTPS leaves another running server's route alone and takes over one left by a stopped server. Agents/MCP: schedule results carry an optional lastRunError. Providers: Claude (usage parsing and pricing), Codex (text generation MCP flags, usage cache). Connection modes: Tailscale Serve only.

No captures: no client code changed. The task card already renders lastRunError whenever it differs from the status (packages/client-runtime/src/scheduledTaskRun.ts:12; the comment there now names older servers), and GoatBotRoutines.browser.test.tsx:146 renders a provider reason the same way; only the server's stored text changed.

## Merges

- 74ac106f6e merges origin/chase/t3-261114-all at ad86de82a5. No conflicts. The integration side added two reception cases to CodexTextGeneration.test.ts that use the moved withFakeCodexEnv unchanged.
- Budgets (dd0c3a16cf, own entries only): ws.ts 3736 -> 3656, UsageService.test.ts 3240 -> 3119, ScheduledTaskService.ts 2329 -> 2311.
- bd5d929d01 merges origin/chase/t3-261114-all at 1f34e35e42. No conflicts. Not merged: scm-retry, adapters-retry.
- 10b92be000 merges origin/chase/t3-261114-all at 3f9cb15cba (L19 48ea0bb5b0, L03 follow-up 630fd9e68e, dev 6fa6fe39e6). No conflicts here; L06 and L09 conflict in ws.ts and code-budgets.json at the coordinator's merge (the ws.ts entry takes the merged length).

- Round 2 budgets: no entry changed. Files this round touches: ScheduledTaskRuns.ts 767 -> 810, TailscaleServeStartup.ts 186 -> 256, tailscale.ts 559 -> 573, orchestratorMcp.ts unchanged against chase/t3-261114-all (1161 at 3f9cb15cba), new serveRootHolders.ts 116.

## Fail-first

- c03f84bcde fail-first: 6/6 upgrade cases fail (old cache files remain); atomicWrite streams iterable fails: expected [object Array Iterator]
- 9cb45ec0b7 fail-first: falls back to a configured non-default instance: expected undefined to be codex_work
- 729f6757d9 fail-first: 11 failed | 67 passed: merges partial Claude copies...; re-parses Claude usage a v11 cache...; upgrades v4..v10 (file name); retains v10 history...; re-parses a Claude transcript cached before partial copies were merged; merges partial copies of a key by channel maximum
- 5ff3d3c0ec fail-first: 11 failed | 200 passed; v12 case: expected 6.25 to be close to 8.5; prices one-hour cache writes...; advisor record; round trip; upgrades v4..v10 (file name)
- 3595b9e038 fail-first: upstream case: expected {revision 2 pairingLinkRemoved later} to deeply equal {revision 2 clientRemoved revoked-elsewhere}; overflow case: timed out 120000ms (old stream subscribes only after the ack)
- 4b316fd544 fail-first: removing a worktree tells its own status subscribers...: timed out 120000ms (no local update reaches the removed path without polling)
- 5c0eb5124e fail-first: missed slot case: expected {status running} to deeply equal {status failed, error Missed...}; negative case fails without the stale-snapshot guard: expected failed to be running
- c398b46af0 fail-first: launch-arg server: Error loading config.toml: invalid transport in mcp_servers.goat; table case and existing case: missing arg (old order)
- b703fdbfdb: a git action that fails partway...: timed out 120000ms on the old code (no refresh), passes after.
- Round 2, 5c0eb5124e reason: 5 failed | 12 passed on the old ScheduledTaskRuns.ts: expected 'failed' to equal 'Weekly usage limit reached'; expected 'failed' to equal 'The run failed.'; expected 'interrupted' to equal 'The run was stopped.'; expected 'cancelled' to equal 'The run was cancelled.' (and the 4096-character row); 17 passed after.
- Round 2, becc7d3510: serveRootHolders.test.ts cannot import parseTailscaleServeRootHolders (no module); the three startup cases hang without the holder check (run killed at 200 s); 5 files, 38 tests passed after.


## Gate

Round 2 gate, on juniui-Macmini (macOS 27.0, node v26.12.1): `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 VITEST_MAX_WORKERS=4 vp run check:changed` with pipefail on 10b92be000 (merged with origin/chase/t3-261114-all at 3f9cb15cba): exit 1.

- pass: unused patches, format, lint, graphql (server, source-control-github), agent context budget, agent surface audit (doc unchanged), knip 1/2 and 2/2, typecheck (42 packages). `node scripts/goat-rename.ts --check`: 0 lines in 0 files.
- FAIL test: 1896 files, 5 failed | 1884 passed | 7 skipped; 23 failed | 27400 passed | 33 skipped. None in files this lane changed: GrokTextGeneration.test.ts (16, goat#3425: `exec: node: not found`, node only on an nvm PATH), cli/app.test.ts (4 relative-cwd cases, goat#3238; the flag, env and bootstrap fixtures start a real server and never exit, so each fixture child of this gate was stopped by PID after it hung; the cwd case fails its assertion), runtimeFactsScripts.test.ts (goat#3363), tunnel.client-session.test.ts (goat#3418), NotesGit.test.ts large-attachment case (goat#3439, new). app.test.ts "relative cwd" and the NotesGit case fail identically alone on 3f9cb15cba.
- Focused runs on the round's files, all passing: ScheduledTaskOutcomes.integration (17), UsageService + contracts orchestratorMcp + thread handlers + scheduledTaskRun + scheduledTasks (21 files, 255), TailscaleServeStartup + packages/tailscale (5 files, 38).


Round 1 gate, on cpaui-MacBookAir: `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 VITEST_MAX_WORKERS=4 vp run check:changed` with pipefail on e363f29d85: exit 1.

- pass: unused patches, format, lint, knip 1/2 and 2/2, graphql (server, source-control-github), agent surface audit, agent context budget. `node scripts/goat-rename.ts --check`: 0 lines in 0 files.
- FAIL typecheck: one error, apps/server/src/provider/Drivers/AntigravityDriver.ts:480 `Cannot find name 'processEnvironment'`. The file is byte-identical to origin/chase/t3-261114-all at ad86de82a5 (it came with that branch's dev merge of #3207: processEnvironment is now local at :239 but :480 still uses it).
- FAIL test: 1485 files, 7 failed | 1470 passed | 8 skipped; 67 failed | 23040 passed | 24 skipped. None in files this lane changed: AntigravityDriver.test.ts (13) and ProviderRegistry.test.ts (5) fail with the same ReferenceError (21 in the log; fixed on chase/t3-261114-all, merged in round 2); SshWorkspaceSync.test.ts (44, goat#3417 full-suite load), packages/ssh tunnel.client-session (goat#3418, node only in fixed system dirs), runtimeFactsScripts (goat#3363), launchListenerScripts (goat#3403), infra/relay FcmDeliveries (2, no PostgreSQL on that Mac).
- Focused runs on the lane's files, all passing: usage + provider Drivers (29 files, 385 tests), scheduledTasks (16 files, 146), textGeneration (12 files, 294), ws.gitActions + ws.authAccess + AccessRpc, shared serverSettings (3 files, 68), atomicWrite (8), server settings/text-generation consumers (6 files, 292).


## NOT RUN

- Round 2 review (the coordinator's next review round), CI (runs once on #3397).
- Real-client pass and captures: no client code change (Surfaces).
- becc7d3510 against a real tailnet: covered by the parser and TestClock startup cases only.

Model: anthropic/claude-opus-5-5 in GOAT through the Codex harness (round 1 and round 2).
