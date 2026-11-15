# L09 retry: server misc (lane record)

Lane branch: `chase/t3-261114-server-misc-retry`, head e363f29d85, from origin/chase/t3-261114-all at 56421003ff. The original L09 lane merged as 85920591b0 (#3273); this file is the retry round's full record. Upstream range fa2f4ff2a2..93cbca3fcbd. Lane review NOT RUN: Codex pool at its weekly limit.

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
| 5c0eb5124e a missed fixed-time slot shows as failed | adapt | ccbabda41a | Missed slot marks the task failed and clears last_firing_id so clients fall back to lastRunStatus/lastRunError; reschedule guarded on the snapshot's next_run_at and last_run_at (upstream's stale-slot guard). recordRunFailure not ported: GOAT run rows already follow dispatched runs (ScheduledTaskRuns.ts:464). Upstream's two schedule cases carried (busy case expects the manual firing to stay "running" in GOAT); its recordRunFailure test not carried. Move first: c5bd431a12 (makeDueHint into dueTaskHint.ts). |
| c398b46af0 Codex text generation runs when launch args define an MCP server | adapt | 2b8263bb1b | Off table before launch args, again after them only when they set an mcp_servers table, dotted per-server off flags after them; applied to GOAT's execLaunchArgs (reception isolation / OpenCodex route args). Fake mcp_servers handling in the testkit; two new cases (launch-arg server; replacement table with dotted and spaced names) in CodexTextGeneration.mcpServers.test.ts, server name "goat". Moves first: 2f180929b5, e363f29d85. |
| 8af1fc110e import seed snapshots with peer preview migrations | done in L03m | 730d25fcec (in chase/t3-261114-all) | Landed with the migration shift. Nothing left here. |
| becc7d3510 Tailscale Serve route holder and dead-port repair | not done this round | none | Needs upstream's serve-status parsing (decodeTailscaleServeStatusJson, expandProxy, dialedHostPort, reachesTarget) from d897d3f3f0, which cycle 261103 skipped as D-POLICY (10.020 #185); GOAT's packages/tailscale/src/tailscale.ts (559 lines) has none of it. Port that parsing subset into packages/tailscale, then add the root-holder check before ensure and the 30-second dead-port repair loop to apps/server/src/tailscale/TailscaleServeStartup.ts (a holder that is another live server or unreadable means no attempt, so release never disables it). Context ran out before it was started. |
| a09e54a363 proxied usage limits take their reset time from the CLIProxyAPI hub | not done this round | none | 13 files including packages/contracts (providerUsageLimits.ts, server.ts), Orchestrator.ts and ProviderEventIngestor.ts; reconcile with GOAT quota pool and endpoint attribution (apps/server/src/usage/UsageLimitSources.ts:139). Context ran out before it was started. |
| 06bd84623b wire budget covers stale todo lists | real defer | none | Needs b015ffd7c2's ProjectionStore.ts half (+174/-40 and its ProjectionStore.test.ts cases). Only its migration landed (82f2b9fd0d in chase/t3-261114-all); that half is L03's and waits on 61cb845d96, which is not on dev or in chase/t3-261114-all. |
| 476fc9be66 wire budget measures what clients fetch today | real defer | none | Needs 06bd84623b (above). .github/scripts/thread-transfer-report.cjs and ci.yml stay under the cycle's upstream-CI skip. |
| 7fab4ef978, 9a614e34a6 | real defer | none | Need b42841808d (L02), not on dev or in chase/t3-261114-all. Its predecessors 729f6757d9 and 5ff3d3c0ec are now on this lane branch. |

## C4

- c03f84bcde deletes files: superseded scan-cache versions and temp folders idle for an hour. Negative case: a fresh `.active` temp folder survives (usageCacheUpgrade.testkit.ts upgrade case, asserted directory listing).
- Cache format (coordinator: not a migration). v11 -> v12 (729f6757d9) and v12 -> v13 (5ff3d3c0ec) each have a previous-version-file test (usageClaudeCopies.testkit.ts, usageCacheUpgrade.testkit.ts). Downgrade: a GOAT at v11 reads only usage-scan-cache-v11.json and rejects versions above 11 (usageScanCache.ts:20 and :190 before 4aafe25e50); a GOAT at v12 likewise. After a downgrade the older server ignores the newer file and rescans transcripts; usage of transcripts deleted since its own file was removed is gone on that server.
- 3595b9e038 (auth access stream): revocation during snapshot loading is upstream's case; overflow case added. Wire contract unchanged; an older client already applies a snapshot event at any revision.

## Known limits

- 3595b9e038: a burst over 256 access changes costs one extra snapshot read per subscriber.
- 5c0eb5124e: when a missed slot follows a firing whose run is still running, the task card shows the missed failure; that run's outcome stays visible in its thread.
- 4b316fd544 and b703fdbfdb fail-first evidence is a project timeout (120 s) on the old code, as in upstream's test.

## Surfaces

Server: usage scan cache and pricing, access list stream, git actions and worktree removal, scheduled tasks, Codex text generation, text-generation fallback. Web, desktop, mobile: no client code change; usage totals and costs, task cards (missed slot "Failed" with its reason), Git panel and sidebar labels, and Settings access list change through the server. Agents/MCP: scheduled tasks show the missed-slot failure through the same task fields. Providers: Claude (usage parsing and pricing), Codex (text generation MCP flags, usage cache). Connection modes: none specific.

## Merges

- 74ac106f6e merges origin/chase/t3-261114-all at ad86de82a5. No conflicts. The integration side added two reception cases to CodexTextGeneration.test.ts that use the moved withFakeCodexEnv unchanged.
- Budgets (dd0c3a16cf, own entries only): ws.ts 3736 -> 3656, UsageService.test.ts 3240 -> 3119, ScheduledTaskService.ts 2329 -> 2311.

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


## Gate

`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 VITEST_MAX_WORKERS=4 vp run check:changed` with pipefail on e363f29d85: exit 1.

- pass: unused patches, format, lint, knip 1/2 and 2/2, graphql (server, source-control-github), agent surface audit, agent context budget. `node scripts/goat-rename.ts --check`: 0 lines in 0 files.
- FAIL typecheck: one error, apps/server/src/provider/Drivers/AntigravityDriver.ts:480 `Cannot find name 'processEnvironment'`. The file is byte-identical to origin/chase/t3-261114-all at ad86de82a5 (it came with that branch's dev merge of #3207: processEnvironment is now local at :239 but :480 still uses it).
- FAIL test: 1485 files, 7 failed | 1470 passed | 8 skipped; 67 failed | 23040 passed | 24 skipped. None in files this lane changed: AntigravityDriver.test.ts (13) and ProviderRegistry.test.ts (5) fail with the same ReferenceError (21 in the log); SshWorkspaceSync.test.ts (44), packages/ssh tunnel.client-session, runtimeFactsScripts, launchListenerScripts (1 each), infra/relay FcmDeliveries (2, Postgres fixture).
- Focused runs on the lane's files, all passing: usage + provider Drivers (29 files, 385 tests), scheduledTasks (16 files, 146), textGeneration (12 files, 294), ws.gitActions + ws.authAccess + AccessRpc, shared serverSettings (3 files, 68), atomicWrite (8), server settings/text-generation consumers (6 files, 292).


## NOT RUN

- Lane review: Codex pool at its weekly limit.
- Real-client pass (no visible client change in this lane), CI (runs once on #3397).
- becc7d3510, a09e54a363 (not done this round).

Model: anthropic/claude-opus-5-5 (high reasoning effort) in GOAT through the Codex harness.
