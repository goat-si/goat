# L02 retry: provider adapter fixes (lane record)

Lane branch: `chase/t3-261114-adapters-retry`, pushed at `6e62d5c624` (run 5). No PR yet; this file is the lane's full record. Upstream range fa2f4ff2a2..93cbca3fcbd. Deferrals are tracked in #3176.

## Decisions

| upstream | decision | GOAT commit | reason |
| --- | --- | --- | --- |
| 2248ca8db9 fix(cursor): steer the live run | adapt | 0c89523f1d | GOAT's Cursor adapter keeps the live run; a declined steer queues right after the active run with the user's model. Needed upstream's Kiro capability flag so a steer with attachments still restarts. Moves first: c0d2082486, de2ff5d7b3, 7e6936778a, a462be1344. |
| 315b06c5ec managed installs update past their pin | adapt (Codex half) | 288d66a681 | Owner decision 2026-11-15. SHA-256 from the release's codex-package_SHA256SUMS verified before install, download capped at 1 GiB; pinned release keeps its exact-size check and stays the fallback. Moves first: 3b58c0548f, 028f0c0a56. |
| 315b06c5ec Antigravity registry path | skip | none | Never ported: it installs an archive without a digest GOAT verifies; 4099e62767 replaced it upstream. |
| 4099e62767 Antigravity native goals | adapt | 8a1c2870e1 | Sessions that list a "goal" command report native goals; Antigravity goal controls other than "/goal <objective>" are refused before any event. Moves first: 4d5775de74, d4cc03e826. pair.test.ts not carried (an unrelated Tailscale serve test rewrite). |
| 4099e62767 Antigravity managed CLI updates | adapt (owner decision: port, final form) | 096c5f6af6, 598171a316 | The installer reads Google's CLI manifest (antigravityCliRelease.ts) and installs a release only after its SHA-512 matches; hosts allow-listed to dl.google.com and storage.googleapis.com, redirects refused (fetch RequestInit redirect "error"), download and extracted executable capped at 512 MiB each. Unreachable or unusable manifest: nothing offered, the pinned 1.4.5 stays the fallback with its exact-size SHA-256 check; a release the model manifest withdrew is neither offered nor installed; an installed native CLI newer than the offer is re-checked, never downgraded. CLI arguments (`acp --gemini-dir <run GEMINI_HOME> --app-data-dir antigravity-acp`), the advertised system-prompt append, the driver and auth test expectations and the >=1.5.1 <2 manifest range come with it. Upstream's 1177-line installer is split: AntigravityInstallation.ts 773, Archive 252, Validate 116, Lookup 112, Records 80, antigravityCliRelease.ts 100. Move first: 76f448422c (driver test harness). |
| ee9e36c8b2 check a secret reference before saving it | adapt (C4) | 2627d704b9 | GOAT's resolver: server.checkSecretSource reads the reference once, uncached (resolveSecret with read admission, 45 s cap), answers Resolved or Failed with a reason and never the value; on success it clears the resolver cache and reloads the provider instances whose secrets include the reference (reloadSecretsAndRefresh). Guarded by settings:write in CLIENT_GUARDED_RPC_SCOPES; servers advertise the optional secretSourceCheck capability and clients show Check only where it is present. Web: Check beside a saved reference in SecretReferencePicker. Mobile has no secret reference settings. Moves first: 8323f359e2 (ws.ts), the OTLP check RPC into contracts/serverCheckRpc.ts (rpc.ts 2810 to 2808 with the new RPC). |
| b5b470542a Codex Stop that Codex never confirms | adapt, coordinator Option 2 | 9ad8a91332 (the held 4bedf48e18), 902f3edd06 | Stop fails with ProviderAdapterInterruptTimeoutError after 10 s; the turn stays open and clients offer Force stop. 902f3edd06 makes the state visible to agents for every provider: goat_thread_status, goat_thread_read (summary and messages) and goat_task_status carry an optional `stop: { state: "unresponsive", since }` from the run_interrupt_request's unresponsiveAt; descriptions say only a person can Force stop (goat#2338). goat_thread_interrupt and task_cancel still return interrupt_requested and cancel_requested. Moves first: 5cef8760b0, 5b0b916eae. Agent Force stop not built. |
| c9dfc404cc custom Codex providers no longer report native quota | adapt (earlier run) | 90b3a526f3 | Only a confirmed native OpenAI route reads the login's quota. Not in this table before run 5. Interacts with #3207's CodexDriver.usageHome test; see Gate. |
| b42841808d count Codex request ledgers | deferred | none | Needs 729f6757d9 and 5ff3d3c0ec, ported in L09 retry (chase/t3-261114-server-misc-retry e363f29d85, under review, not yet in chase/t3-261114-all). Portable in a later L02 round once L09 lands there; UsageService.ts has 6 lines of headroom. |

## C4

- 315b06c5ec Codex half: negative tests in CodexInstallation.update.test.ts (checksum mismatch, unreachable checksums, withdrawn release, withdrawn install back to the pin). No wire change.
- 4099e62767 updater, AntigravityInstallation.update.test.ts: unreachable manifest keeps the pinned release and downloads no CLI; a SHA-512 mismatch installs nothing and keeps the previous release; a withdrawn release is neither offered nor downloaded; a manifest URL on another host is ignored; a redirected download fails and the redirect target is never fetched. antigravityCliRelease.test.ts refuses a bad digest, pre-1.5.0, http, a lookalike host, another bucket or folder, query strings and a version mismatch. No wire change: ProviderInstallState is unchanged.
- ee9e36c8b2: new RPC server.checkSecretSource. Negative: clientRpcPermissions.test.ts pins settings:write (failed with [] before the scope entry). Older server: SecretReferencePicker.browser.test.tsx shows no Check without the capability. SecretCheck.test.ts: unreadable or empty secret reloads nothing; an unconfigured provider is not read.
- b5b470542a Option 2: the stop field is optional both ways. HostThreadsMcpService.test.ts: a newer host's stop reaches the caller, a host that predates it reports none, and the thread-read fallback for hosts without goat_thread_status carries it; orchestratorMcpStop.test.ts: a caller's pre-field schema reads a newer host's status. Negative: threadStatus.test.ts reports no stop while the provider may still confirm Stop or after it did.

## When updates happen and what the user sees

Codex and Antigravity: GOAT looks for a newer release at most hourly, and only while a client watches the provider's setup with provider update checks on (Settings → Maintenance; gated in providerInstallation.ts). Install or reinstall also checks. Settings → Providers then shows the new version and "Update Codex" or "Update Antigravity"; nothing installs until the user presses it. A fresh install gets the newest verified release (Antigravity) or the pinned one (Codex, and Antigravity when Google's channel is unreachable); an installed release is never downgraded. docs/user/install.md and providers-antigravity.md say this.

## Known limits

- Agents cannot Force stop (goat#2338). A Stop the provider never confirms shows as stop=unresponsive; only a person's Force stop, the provider ending the turn or an unload ends the run.
- The child's lane slot stays held until that run ends (PermissionProfiles.unresponsiveStop.test.ts pins the release on completed, interrupted and failed).
- task_cancel drops the parent's completion wake for local children on every provider; that is its contract on dev (OrchestratorMcpService.ts cancel-task-completion-delivery, tested by "returns cancel requested when post-stop disposal fails"), not new with b5b470542a. Its description says to read the child with task_status after a cancel.
- The installer validates new installs with the environment it was built with (unchanged from the integration tip); checks and launches pass the current one.

## Cross-lane

- L03: commandThreadId.ts is one blob (c150d91d8b) on both sides; L03's beforeTurnItemsWrite harness edit lives in test/ProviderSessionManagerHarness.testkit.ts; Orchestrator.ts 13917 to 13878 by 058f65acfe.
- L06 (scm-retry merges first): once it is in the integration tip this lane merges, delete ProviderSnapshotMerge.ts's saved Antigravity account carry-over and testkit/watchedPullRequestDetail.ts and import L06's ProviderSavedAccount.ts and runtimeLayer.testkit.ts. Not yet in bd69c4db0b.
- L09 (merges before this lane): b42841808d becomes portable then.

## Integration merges

- 87dbaa401a (56421003ff), run 4.
- 485b911ac4 (74ae8cc7b2): conflicts in AntigravityAdapterV2.ts (kept native goals and the session launch resolver), provider-acp adapter.ts (kept the integration import and re-export of acpPerTurnPromptUsage), ProviderSessionManager.test.ts (kept the testkit, carried L03's edit there).
- a71bd62a47 (24c7a4e0da) and 8aa9952bd8 (bd69c4db0b, with dev b53dea9e4b): no conflicts.

## Gate (run 5, head 6e62d5c624, merged with chase/t3-261114-all bd69c4db0b)

Not READY. check:changed on 8aa9952bd8 (load 3 to 7): unused patches, format, lint, graphql, agent context budget, knip 1/2 and 2/2, typecheck (42 packages) pass; agent surface audit failed on a stale audit doc, regenerated in d7acf1300a. Test (2994 files): 7 failed, 2979 passed, 8 skipped (39341 tests passed). Of the 8 failing tests, 3 are the known unrelated macOS ones (runtimeFactsScripts and tunnel.client-session, goat#3363; NotesGit). 4 were this lane's stop-field reads meeting mocks without turn items and a test racing the effect worker; fixed in 6e62d5c624 (those 10 tests pass). The last one is open:

- CodexDriver.usageHome.test.ts "a new home's own reading is not overridden by a later report from the old home" fails on the lane and passes on bd69c4db0b. It fails already at 485b911ac4, so it is not from run 5's ports: #3207's fake Codex answers account/read with requiresOpenaiAuth false, and the lane's c9dfc404cc port (90b3a526f3, codexRoutesSpendNativeQuota, CodexProviderAccount.ts:95) treats that as a custom provider with no native quota, so the session's 10% reading is never shown. With requiresOpenaiAuth true the test gets past that and then fails at its later [5] check. Next step: decide whether the fixture should describe a native ChatGPT login (and finish adapting its later steps) or whether a native route without OpenAI auth must still report usage; then rerun check:changed.

goat-rename --check: 0 (in the check:changed run).

## Remaining rows (next concrete step each)

- CodexDriver.usageHome conflict above: decide fixture vs rule, fix, rerun the gate.
- Orchestrator.ts budget after L04: free at least 34 more lines (13878 now; L04 adds about 25). Prepared: move the lane's steer follow-up queue position and the reorder of later queued runs into steerFollowUpQueue.ts (about 24 lines), plus another verbatim move; measure again on the tip with L04.
- EffectOutboxRequest.ts: when the merged tip has L04, put modelSelection and steerFollowUpAfterRunOrdinal there (they are in EffectOutbox.ts's provider-turn.steer request now).
- L01 ProviderSessionManagerErrors.ts (feea042f19) is not in bd69c4db0b: when it is, delete the five error classes and the release reason from ProviderSessionManagerTypes.ts, import them, and grep that no class is defined twice.
- L06 scm-retry and L09 retry: not in bd69c4db0b; follow-ups listed under Cross-lane.
- Lane review: NOT RUN.

NOT RUN: a green check:changed on 6e62d5c624; real Codex, Cursor or Antigravity turns; a real Antigravity CLI update against Google's channel (only the manifest and storage URLs were fetched with curl: both answer 200 without a redirect); captures of "Update Codex", "Update Antigravity" and the secret Check; native-client checks; independent review of the C4 commits.

Model: anthropic/claude-opus-5-5 via Codex in GOAT on pen-macmini, coordinated by anthropic/claude-opus-5-5
