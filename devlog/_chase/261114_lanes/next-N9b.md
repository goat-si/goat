# Lane N9b, provider adapters (L11 retry 2), next PR

Lane branch `chase/t3-261114-n9b-providers`, based on origin/dev `bcb2a18ac8`. Contains the integration head `44d7d60d20` (merge `9b92d2e71f`) and origin/dev `cbe919c652` (merge `750d243cdb`). Part 1 head `7fe3d68aa5` merged into `chase/t3-261114-next` at `0879c4cca4` (git's own result, no conflict); review APPROVE WITH NITS, no P0 or P1 (next-N9b-review-7fe3d68a.md). Part 2 is on `chase/t3-261114-n9b2-providers` (section Part 2).

## Rows

| Row | Upstream | Commit(s) | State |
| --- | --- | --- | --- |
| 4e0b52806b Cursor shell commands stream while they run (owner-named, C4 patched dependency) | 4e0b52806b | 76adb119ae8bdea39ec2bc8e8884af61db09ae79 | ported |
| ACP /compact per-session map (card item, #3332 review, plan row 118) | ac7c7f66d9 follow-up | 912c1318d6a15c2ac7b05b34d3113652c4d4d083, MAX_SESSIONS unexport 7fe3d68aa5db89e1ad0bd7f60c0a2e4aeec07456 | ported |
| L383 jsonc-parser into provider-cursor (C4 new dependency) | cc97303381 | 49bcd979ee8201d0bea79e0e4236b24f7e03de7a (move-out), 8550f8ea2f9fc22213ffa6d2632ff616001ace8f | ported; needs ci:full (not dispatched by the lane) |
| L406 Pi prompt ACK tracking | f255158370 | 14edd1cc219bec2f2063190b1ec0032be2b6b5f6 (move-out), 886de17bba371fc08117d9965d4cc3a02af6b450, a868b9c9b236a646c96b29f4604369a4659e5634 | ported |
| L408 supportsTextGeneration (C4 contract) | 817b92f13a | none | not started (context) |
| O23 / L407 Cursor team usage (C4) | 497aac20f7 | 672400a7da + 49c834520a (part 3, own branch chase/t3-261114-n9b2-o23) | held out of #3519 until a live Cursor read passes (goat#3632); needs a live Cursor check (see Part 3) |
| a3cde98425 remainder, ACP mock agent bundled once per file | a3cde98425 | none | not started (context) |
| goat#3491 Cursor declined steer after Stop | (2248ca8db9 gap) | none | not started (context) |

## Decisions and adaptations

- 4e0b52806b: upstream's patch file taken byte-identical; upstream's adapter.test.ts case moved to the new packages/provider-cursor/src/server/adapter.shellOutput.test.ts (adapter.test.ts at its 1891 entry; upstream extends an existing test there), plus a GOAT case for an older SDK event without toolCallId.
- /compact: `AdvertisedCommands.BySession` map, cap 8, oldest out, re-announce moves a session to newest. Names held per session are bounded by one announcement's list (each announce replaces that session's set, as upstream), so retention is at most 8 announcement lists.
- cc97303381: GOAT always sends a turn-time mcpServers set and rebuilds it on active-run recovery (prepareMessage); the workspace servers join both, GOAT's server last. Upstream's case is in packages/provider-cursor/src/server/workspaceMcpServers.test.ts with `settings` added for GOAT's adapter options.
- f255158370: upstream's adapter hunks with GOAT's `driver` for PI_PROVIDER in the moved start block. Prompt ids are `goat-prompt-N` instead of upstream's `t3-prompt-N` (goat-rename --check flags the T3 spelling), and the testkit's ADAPTER_REQUEST_ID is `/^(?:t3|goat-prompt)-\d+$/u` instead of upstream's `/^t3-(?:prompt-)?\d+$/u`; withRequestId is upstream's text. The 64-prompt bound on held plus pending prompts stays.

- (N9b-P3-3) 886de17bba's message still says prompt ids are t3-prompt-N; a868b9c9b2 changes them to goat-prompt-N. In the mcp.json row (cc97303381) GOAT passes the session's merged environment (packages/provider-cursor/src/server/adapter.ts:1583, `env`) where upstream passes adapterOptions.environment; both hold the instance variables over the host environment.

## Owed to #3519's integrated pass (part 1 rows, not checked by the lane)

- 4e0b52806b Cursor command output while a command runs: web and desktop through CommandOutputPanel, mobile through thread-command-output.tsx, and a reload mid-command shows the tail. Needs a live Cursor run.
- cc97303381 Cursor MCP servers that use ${workspaceFolder}: no new UI; the agent gets the server's tools. Needs a live Cursor run and a project .cursor/mcp.json.
- ACP /compact per-session map: /compact in a second ACP session shows a compaction row instead of the refusal. Needs a live ACP agent that advertises compact.
- L406 Pi prompt ACK: see (d) under L406.

## Rule 3 authorisations (verbatim)

### advertisedCommands.test.ts

Coordinator authorisation, 2026-11-16, rule 3, lane N9b (the ACP /compact per-session map, plan row 118, cap 8): AUTHORISED. In packages/provider-acp/src/server/advertisedCommands.test.ts the existing case "keeps only the session that advertised last, so retention stays bounded" becomes "keeps the last 8 sessions that advertised, oldest out, so retention stays bounded": the same 100 announcements go through remember(current, sessionId, commands); expect(advertised).toEqual({ sessionId: "session-100", names: new Set(["plan"]) }) becomes expect([...advertised.keys()]).toEqual(session-93 .. session-100), and the null case goes because the map starts as AdvertisedCommands.empty. Reason, checked here: the old assertion encodes the single-session shape from #3332 that this plan row replaces; upstream ac7c7f66d9 keeps a per-session map (packages/provider-acp/src/server/adapter.ts: "const advertisedCommandNames = yield* Ref.make(new Map<string, ReadonlySet<string>>());" and "updated.set(sessionId, new Set(advertisedCommands.map((command) => command.name.trim().toLowerCase())))"), and the plan sets the cap at 8, oldest out. Upstream never edits this GOAT test file. Conditions: (1) the bounded-retention check stays exact: after 100 announcements the map holds exactly those 8 keys in that order; (2) the test keeps its two other existing assertions: before eviction advertises(..., "session-1", "compact") is true for the name announced as " Compact " (trim and case), and after eviction it is false; (3) the purpose of the removed null case is kept by an empty-map case: with no announcement, advertises(AdvertisedCommands.empty, anySession, "compact") is false; (4) the new cases beside it stand as described (a child session that announces late, a resume that does not re-announce, a re-announce that moves the session to newest), and the record says what bounds the names held per session (one announcement's list, as upstream). No other expectation in an existing dev test may change in this lane without asking.

Conditions met: (1) after 100 announcements the map holds exactly session-93 .. session-100 in that order; (2) " Compact " (trim and case) advertises compact for session-1 before eviction and not after; (3) new case "with no announcement, no session advertises /compact" (advertises(AdvertisedCommands.empty, "session-1", "compact") is false); (4) the late child, resume without re-announce and re-announce cases stand; names per session are bounded by one announcement's list, as upstream. Note: 912c1318d6's message says "After: 4 passed"; with the empty-map case the file has 5 cases, all passing.

### L406 (f255158370)

Coordinator authorisation, 2026-11-16, rule 3, lane N9b, row L406 (upstream f255158370 "fix(pi): settle prompts consumed by input handlers"): AUTHORISED, items 1 to 5, as upstream's own edits to its own tests. Checked here: the three old titles each appear once in packages/provider-pi/src/server/adapter.test.ts on dev and once as a removed line in upstream's diff; upstream adds the it.effect.each tables "settles consumed input after its ack: $text", "waits for a settled turn's late prompt ACK before accepting the next turn: %s" and "ignores stale idle probes, handled=$handled steer=$steer", the fake.deferNextLifecycle("prompt") setup lines, and edits apps/server/src/orchestration-v2/Adapters/PiAdapterV2.testkit.ts itself (ADAPTER_REQUEST_ID /^t3-\d+$/u becomes /^t3-(?:prompt-)?\d+$/u and withRequestId rebinds id-less expected prompts).
(1) "settles a command-only prompt from its deferred ack and idle probe" is replaced by upstream's table "settles consumed input after its ack: $text" (three rows). (2) "keeps a settled turn's late prompt rejection off the next turn" is replaced by upstream's table "waits for a settled turn's late prompt ACK before accepting the next turn: %s" (five rows). (3) "ignores an idle snapshot made stale by a steer" is replaced by upstream's table "ignores stale idle probes, handled=$handled steer=$steer" (ten rows; the handled=false steer=starts row is the old case plus the added ACK with data: { disposition: "started" }). (4) fake.deferNextLifecycle("prompt") before startTurn in the six existing cases named in the request: setup only, no assertion changed. (5) the testkit edit as upstream wrote it.
Conditions: (a) each carried table and hunk is upstream's text apart from GOAT's import paths and the move of the cases into packages/provider-pi/src/server/test/promptAckChecks.ts; any other difference is listed in the record; (b) the record lists the three replaced titles with their new titles and the six setup-only hunks, and states the behaviour change in plain words: a Pi turn whose prompt was consumed by an input handler stays running until its ACK arrives; a late ACK owed by a settled turn holds the next turn's start until it arrives; (c) the record says what ends that hold when the ACK never comes: Stop and cancellation (the six new rows), and the Pi process exiting or its session closing. If no test covers the process exiting (or the session closing) while a start is ACK-blocked, add one as a new case: the blocked start must end with a failure the user sees, not stay pending. A start that can wait forever on a dead process is the one outcome this must not have; (d) what the user sees while a start is held (the turn shows as starting) goes into the per-surface lines owed to #3519's integrated pass. No other expectation in an existing dev test may change in this lane without asking.

(a) The five tables in packages/provider-pi/src/server/test/promptAckChecks.ts are upstream's text (extracted from f255158370:packages/provider-pi/src/server/adapter.test.ts) apart from import paths, the registration wrapper and `isProviderProtocolError` declared in that file. Other differences: prompt ids `goat-prompt-N` and the testkit regex above.
(b) Replaced titles: "settles a command-only prompt from its deferred ack and idle probe" -> "settles consumed input after its ack: $text"; "keeps a settled turn's late prompt rejection off the next turn" -> "waits for a settled turn's late prompt ACK before accepting the next turn: %s"; "ignores an idle snapshot made stale by a steer" -> "ignores stale idle probes, handled=$handled steer=$steer". Setup-only hunks (fake.deferNextLifecycle("prompt") before startTurn), upstream @@ -823, -1307, -1645, -1718, -1773, -5064: extensionStatusChecks.testkit.ts "rejected prompt" row; adapter.test.ts the compaction_start dialog case, the "Hello pi" prompt case, the agent_settled aborted case, the "/hello" case and "Raced compaction". Behaviour change: a Pi turn whose prompt was consumed by an input handler stays running until its ACK arrives; a late ACK owed by a settled turn holds the next turn's start until it arrives.
(c) What ends the hold when the ACK never comes: Stop and caller cancellation, and the session closing or the Pi process ending. The new table "settles an ACK-blocked start on $end cancellation at $boundary admission" covers all three ends at both admission points: `session` closes the runtime scope, `transport` ends Pi's stdout (the process going away), `caller` interrupts the start; session and transport rows assert the blocked start fails with a ProviderAdapterProtocolError (the adapter fails the ACK wait on session close and on transport close, and a woken start refuses a closed session) and a later start fails too; the start error reaches the user as a failed turn start. No extra case was needed. Corrected after review (N9b-P2-1): a Pi process that stays alive but never acknowledges a consumed prompt holds the next turn's start until Stop or the session closing; there is no timeout, as upstream f255158370 (packages/provider-pi/src/server/adapter.ts:2654-2665, :2748-2826 wait on pendingPromptResponsesDrained with no deadline). A bounded wait that tells the person Pi has not acknowledged the earlier message is goat#3588.
(d) Owed to #3519's integrated pass, per surface (not checked by the lane): web, desktop and mobile should show the held turn as starting until Pi acknowledges the earlier prompt, and a failed turn start once Pi exits or the session closes. Press Stop on a held Pi start on web, desktop and mobile and confirm the start ends (N9b-P2-1).

### goat-prompt- prefix (coordinator decision, verbatim)

Coordinator decision, 2026-11-16, lane N9b: (1) the goat-prompt- prefix for Pi prompt ACK ids (a868b9c9b2) is ACCEPTED as a GOAT difference from upstream f255158370, which writes t3-prompt-; with it item 5 of the L406 authorisation reads: ADAPTER_REQUEST_ID becomes /^(?:t3|goat-prompt)-\d+$/u in apps/server/src/orchestration-v2/Adapters/PiAdapterV2.testkit.ts. Conditions: the ids are generated and matched only by GOAT's own adapter (the record names every place in packages/provider-pi and apps/server that builds, matches or classifies a request id by prefix, with path:line, and says none still expects t3-prompt-); the existing t3-<n> ids of other requests are unchanged; recorded Pi fixtures still replay; the record cites the goat-rename rule that flagged the upstream prefix. (2) The lane's remaining four rows (L408 817b92f13a, C4; O23 L407 497aac20f7; the rest of a3cde98425; goat#3491) stay in lane N9b for #3519 and run as N9b part 2 in a fresh thread in the same worktree on a NEW branch chase/t3-261114-n9b2-providers cut from 7fe3d68aa5, so that part 1's head stays fixed for its review; part 2 merges the integration head when part 1 is merged. O23 keeps its condition: one live check by a person with a Cursor team account, or the row stays open as "needs a live Cursor check".

Note (2026-11-17): O23 was later held out of #3519 by the coordinator decision quoted in Part 3 (goat#3632); #3519 does not contain it.

Conditions, checked on 7fe3d68aa5db89e1ad0bd7f60c0a2e4aeec07456 (`rg` over packages/provider-pi and apps/server for `t3-`, `goat-prompt` and `prompt-` id spellings):

- Builds an id: packages/provider-pi/src/server/adapter.ts:426 (`goat-prompt-${nextPromptId++}`, prompt and steer records the adapter sends itself) and packages/provider-pi/src/server/rpc.ts:431 (`t3-${nextRequestId++}`, every other request through PiRpc.request). No other place builds a Pi request id.
- Matches an id: by exact equality only. packages/provider-pi/src/server/rpc.ts:297-298 looks a response id up in its own pendingRequests map (only `t3-<n>` ids are ever put there, rpc.ts:433); any other response, including `goat-prompt-<n>`, goes on to the adapter (rpc.ts:316). packages/provider-pi/src/server/adapter.ts:2087 finds the pending prompt with `pending.id === responseId`. Neither reads a prefix.
- Classifies an id by prefix: only the replay testkit, apps/server/src/orchestration-v2/Adapters/PiAdapterV2.testkit.ts:115 (`/^(?:t3|goat-prompt)-\d+$/u`), used by adapterRequestId and withRequestId (:117-131) to rebind adapter-made ids without pinning counters.
- Nothing in packages/provider-pi or apps/server still expects `t3-prompt-`: the spelling appears nowhere in either tree.
- Other requests keep `t3-<n>`: rpc.ts:431 is unchanged from dev, and the testkit regex still accepts `t3-<n>`.
- Recorded Pi fixtures still replay: `vp test run src/orchestration-v2/testkit/PiReplayFixtures.integration.test.ts` (apps/server) on 7fe3d68aa5: 1 file, 8 tests passed. Corrected after review (N9b-P3-3): the 8 `pi_transcript.ndjson` fixtures carry `t3-<n>` ids on other requests (16 to 62 per file); only the prompt frames have none (expected prompts are id-less and rebound by withRequestId).
- The goat-rename rule: the residue check (scripts/lib/goat-rename/engine.ts:169-181, any `[Tt]3` token left after keep rules, engine.ts:160) flags upstream's line because the only keep rule for Pi request ids, `provider-and-mcp-peers` at scripts/lib/goat-rename/rules.ts:724-726, keeps `t3-(?=\$\{nextRequestId)` and nothing for `nextPromptId`. Checked with findResidue and KEEP_RULES on packages/provider-pi/src/server/adapter.ts: ``const id = `t3-prompt-${nextPromptId++}`;`` is reported, the `goat-prompt-` line and rpc.ts's `t3-${nextRequestId++}` line are not.

## Fail first

- 4e0b52806b: 2 failed: "TypeError: Reflect.get(...) is not a function" (CursorAgentSdk.test.ts) and "expected [] to deeply equal [ { command: 'slow-shell', …(1) } ]" (adapter.shellOutput.test.ts). After: 4 files, 31 passed.
- /compact: 4 failed "TypeError: commands.map is not a function"; old API on the late child case: "parent still advertises compact after a late child announce: false". After: 5 passed; AcpAdapterV2Compaction.test.ts 5 passed.
- cc97303381: "Error: Cannot find module './workspaceMcpServers.ts'". After: provider-cursor src/server 41 files, 367 passed.
- f255158370: 24 failed (the new and rewritten rows). After: provider-pi src/server 271 passed, 1 skipped; PiReplayFixtures.integration.test.ts 8 passed.

## C4 cases

- 4e0b52806b (patched dependency): newer SDK (patched, hook present) routes output by toolCallId; older SDK or user shells (no toolCallId) still reach the latest shell (new case); negative: another conversation's output and output after the run are dropped (upstream case), an exit event and a non-string chunk emit nothing.
- cc97303381 (new dependency): servers without workspace variables, with envFile or enabledTools, plugin- names and disabled names are left to the SDK; unreadable mcp-disabled.json starts none of the overrides and the turn still goes; missing mcp.json files give {} (upstream case). Older server/client: no wire change; an older Cursor CLI without the files behaves as before.

## Lockfile and patch evidence

- patches/@cursor__sdk@1.2.0.patch: git hash-object cf657be869d5c688ad99443f02097f1ac3d8559c, equal to upstream 4e0b52806b's blob.
- pnpm-lock.yaml (4e0b52806b): @cursor/sdk@1.2.0 patch_hash b9966f50182358ded9d1a72f39d9cd850f2e7471e7b8224d3d618bdbbe00e055 -> 57f502128bf6accd976963b126e227c86a45d815a53a8dc450461beae3bed4a4 (upstream's hash) on patchedDependencies, two importers (zod 4.6.5 and 4.6.7) and two snapshot keys; vp i --frozen-lockfile accepts it and the installed SDK contains the sdk.shellStreamOutput hook.
- pnpm-lock.yaml (cc97303381): one importer entry, packages/provider-cursor jsonc-parser specifier 3.3.1 version 3.3.1; no new package (jsonc-parser@3.3.1 already locked for apps/web).

## O23

Not ported. Needs a live Cursor check by a person with a Cursor team account (POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetTeams, Keychain token as bearer, connect-protocol-version: 1, body {}). Row stays open.

## Budgets

provider-cursor adapter.ts 2434 -> 2394; provider-acp adapter.ts 8573 -> 8558; provider-pi adapter.ts 3476 -> 3464; provider-pi adapter.test.ts 4784 -> 4582. No entry raised.

## Gate

Run on pen-macmini after merging origin/chase/t3-261114-next (44d7d60d20) and then origin/dev (cbe919c652), lane head then 750d243cdb + a868b9c9b2. Node 26.12.1 first on PATH, `set -o pipefail`.
- `node scripts/goat-rename.ts --check`: 0 (after a868b9c9b2; the first run flagged upstream's `t3-prompt-` id).
- `vp run check:changed`: GATE_EXIT 1. Passed: goat-rename, unused patches, format, graphql (2), lint, agent context budget, agent surface audit (no change to docs/internals/agent-surface-audit.md), knip 1/2, typecheck (42 packages). knip 2/2 failed on `MAX_SESSIONS` (unused export), fixed in 7fe3d68aa5; `vp run knip:check:exports` then exit 0. vp test (1228 files): 2 failed, 1222 passed, 4 skipped (19620 tests passed). Both failures are packages/ssh files with no diff against origin/dev, failing because this Mac has no node in a system directory (no /usr/local/bin/node, /usr/bin/node, /opt/homebrew/bin/node): packages/ssh/src/tunnel.client-session.test.ts "passes quoted values unchanged through the real runner and shell" (goat#3418) and packages/ssh/src/runtimeFactsScripts.test.ts "reads a built runner in one call and parses only the lines before its end line" ("expected +0 to equal 1"; reproduced alone). Corrected after review (N9b-P3-1): runtimeFactsScripts is goat#3363 (macOS /bin/bash 3.2 ignores BASH_XTRACEFD, so the trace stays empty), not goat#3418; receipt https://github.com/goat-si/goat/issues/3363#issuecomment-6924431939. tunnel.client-session stays under goat#3418.
- After 7fe3d68aa5: advertisedCommands.test.ts 5 passed. The full check:changed was not repeated after that one-line unexport.

## Known limits

- The Cursor shell listener is removed when run.wait ends (as upstream); a run whose wait never runs keeps one listener that only matches its own agent id.
- L383 needs a full CI run (ci:full); the lane did not dispatch it.
- (N9b-P3-2) A live ACP session pushed out of the 8-session map answers /compact with "This provider does not support /compact"; nothing is sent to the agent and nothing is lost. Nothing bounds how many child sessions an ACP agent opens.
- (N9b-P3-4) Cursor shell streaming copies up to 256K characters on the server's main thread for every chunk once a command has printed that much (packages/provider-cursor/src/server/adapter.ts:1378) and hands chunks on without waiting into an unbounded event queue (CursorAgentSdk.ts:664, adapter.ts:308), as upstream; goat#3589 (measure a flood, keep the tail as a list of chunks trimmed only when needed, bound the queue).

## NOT RUN

- L408, O23, a3cde98425 remainder, goat#3491 (not started).
- Full CI (ci:full) for L383; real-client pass; live Cursor check.

## Part 2 (branch chase/t3-261114-n9b2-providers, cut from 7fe3d68aa5)

Rows L408 817b92f13a, O23 L407 497aac20f7, the a3cde98425 remainder, goat#3491. Commits, fail-first, C4 cases, gate and limits follow below once gated.

### Coordinator texts (verbatim)

#### L408 rule 3

Coordinator authorisation, 2026-11-16, rule 3, lane N9b part 2, row L408 (upstream 817b92f13a "fix(pi): stop offering extension-only models for text generation"): AUTHORISED. In packages/provider-pi/src/server/status.test.ts, the GOAT-only case "does not pass inherited GOAT session credentials to any Pi or OmO probe process" (:144), the observed process list at :178 changes from ["version", "rpc", "auth"] to ["version", "rpc", "rpc", "auth"]. Checked here at c5d8d872d0 and in upstream's diff: the credential assertions run in a loop over every observed probe (extendEnv not true, no GOAT_MCP_BEARER_TOKEN, no T3_MCP_BEARER_TOKEN, GOAT_ACP_MCP_AUTHORIZATION ""), so they now cover the second rpc process too, and nothing in them changes; upstream's status.ts adds discoverPiTextGenerationModelSlugs, forked into the check's scope with a timeout (Effect.timeoutOrElse, Effect.forkScoped) and launched with disableExtensions and disableTools, which is the second rpc process. Upstream has no such test, so this is GOAT's test meeting upstream's new process. The three GOAT calls that pass options to piDiscoverySpawner may move the options to the fourth argument with undefined, Effect.void before them, as upstream does for its own call: setup only, no assertion changed.
Conditions: (1) add one assertion in that case that pins which process is new: exactly one of the two rpc probes carries the no-extensions (and no-tools) launch flags and the other does not; (2) the record states the cost and its bounds in plain words: every Pi and OmO status check now starts one extra short-lived process (pi in rpc mode without extensions or tools); how often a status check runs (at server start, when Settings opens, on a refresh: say which, with path:line) and for how many Pi instances; the timeout upstream gives it and what the user sees when it times out or fails (which models are then offered for text generation: the old list or none; textGenerationUnavailable only when the list came back empty); that the process ends with the check (scoped fiber) and cannot outlive a server shutdown; (3) the contract change in packages/contracts/src/server.ts is C4: the older-peer cases both ways as tests (an older server's status without the new field decodes and behaves as before: every model still offered; an older client ignores the field) and on which surfaces the picker changes (web Settings text generators, source control writing, voice: mobile has no such picker or it does: say which); (4) fail-first shown for the row's own new tests. No other expectation in an existing dev test may change in this lane without asking.

#### O23 rule 3

Coordinator authorisation, 2026-11-16, rule 3, lane N9b part 2, row O23 (L407, upstream 497aac20f7 "include Cursor team usage in account history", owner decision A: move GOAT to upstream's api2 bearer requests): AUTHORISED. In packages/provider-cursor/src/server/accountUsage.test.ts, "reads paginated Cursor account history including headless calls with separate cache tokens" (:68), the three assertions that pinned the old destination (:77 the cursor.com dashboard URL, :79 the origin header, :81 the WorkosCursorSessionToken cookie) become upstream's own three for the same case: the URL https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents, connect-protocol-version "1", and authorization "Bearer <accessToken>". The redirect "error" and content-type assertions and everything after stay. The shared fetch helper may answer GetMe and GetTeams first, as upstream's helper does: setup only. Checked here: the three old lines are at :77, :79 and :81 at c5d8d872d0, and the decision sheet's O23 entry names this move.
Conditions (C4: a stored login token goes to a new endpoint, and a cache file changes version):
(1) Keep the pin the old assertions gave, as new negative tests: across a whole account read (GetMe, GetTeams, every GetFilteredUsageEvents page, every team) each request goes to https://api2.cursor.sh and nowhere else, carries the token only in the authorization header, never in a cookie, a URL or a body, and is sent with redirect "error" (a redirect must not carry the bearer to another host); a login whose token is missing or expired sends nothing.
(2) Failure and bounds, each with a test and a line in the record: GetTeams refused or failing (what the user gets: personal history, or an error: say which and that it matches upstream); a personal account with no teams; a 401 (the read fails visibly and does NOT clear or change the stored Cursor login); how many requests one usage read makes (1 + 1 + pages x (1 + teams)) and the limits on teams and pages; timeouts and the abort signal reach every request; nothing of the token or of response bodies goes to a log, a span or an error message.
(3) The cache file v1 to v2: what this build does with a leftover v1 file (ignored, removed, by which code) and what an older build does with a v2 file after a downgrade (it reads only v1 and rescans; nothing crashes; the v2 file is left for a later upgrade), each as a test or with path:line; a malformed v2 file falls back to a fresh read.
(4) The live check. This row replaces a request that works today, so it does not merge unverified. Put the O23 commit LAST on chase/t3-261114-n9b2-providers (or on its own branch on top) so the rest of part 2 can be reviewed and merged without it. It joins the lane when a live read through the new code path has returned usage for a real Cursor login: if a Cursor CLI login exists on the lane's Mac, run that read once yourself (it is the same read GOAT's Usage page makes, against Cursor's own API, as the owner's decision A names) and record only status codes, the number of events and the number of teams, never the token or event contents; if no login is there, say so and the commit waits for a person. The team fan-out still needs a person with a Cursor team account: until then the #3176 row stays open as "needs a live Cursor check" even if the personal read passed.
No other expectation in an existing dev test may change in this lane without asking.

Lane coordinator note: in READY, give two heads if O23 is on its own branch (the part 2 head without O23, and the O23 head on top), and say plainly whether the live read ran and its counts. Never print, log or paste the token.

#### Block B

N9b part 1 review at 7fe3d68aa5: APPROVE WITH NITS, no P0 or P1; two P2 on the record only; four P3. Report /Users/jun/handoff-in/chase/next-N9b-review-7fe3d68a.md. MERGED into chase/t3-261114-next at 0879c4cca4 (git's own result, no conflict). The record work goes to the N9b part 2 thread (records branch only, plus two issues; no code change to part 1):
1. N9b-P2-1. Reword condition (c) in next-N9b.md: a Pi process that stays alive but never acknowledges a consumed prompt holds the next turn's start until Stop or the session closing; there is no timeout, as upstream f255158370. Add to the lines owed to #3519's integrated pass: press Stop on a held Pi start on web, desktop and mobile and confirm the start ends. File a goat issue for a bounded wait that tells the person Pi has not acknowledged the earlier message (adapter.ts:2654-2665, :2748-2826; say what the user sees today), and send me the number.
2. N9b-P2-2. Per-surface lines for the other three rows (the reviewer's check 8 lists them): Cursor command output while a command runs (web and desktop through CommandOutputPanel, mobile through thread-command-output.tsx, a reload mid-command; needs a live Cursor run); Cursor MCP servers that use ${workspaceFolder} (no new UI; the agent gets the tools; needs a live Cursor run and a project .cursor/mcp.json); /compact in a second ACP session (a compaction row instead of the refusal; needs a live ACP agent that advertises compact).
3. N9b-P3-1. The gate's runtimeFactsScripts failure is goat#3363 (macOS bash 3.2 ignores BASH_XTRACEFD: "expected +0 to equal 1"), not goat#3418; tunnel.client-session stays under #3418. Correct the Gate line and add the pen-macmini receipt to #3363.
4. N9b-P3-2. Known limits: a live session pushed out of the 8-session map answers /compact with "This provider does not support /compact"; nothing is sent to the agent and nothing is lost; nothing bounds how many child sessions an ACP agent opens.
5. N9b-P3-3. Record: the Pi fixtures do carry t3-<n> ids on other requests (only prompt frames have none); 886de17bba's message says t3-prompt-N and a868b9c9b2 changes it; in the mcp.json row GOAT passes the session's merged environment (adapter.ts:1583) where upstream passes adapterOptions.environment.
6. N9b-P3-4. File a goat issue: Cursor shell streaming copies up to 256K characters on the server's main thread for every chunk once a command has printed that much (adapter.ts:1378) and hands chunks on without waiting into an unbounded event queue (CursorAgentSdk.ts:664, adapter.ts:308), as upstream; to do: measure a flood, then keep the tail as a list of chunks trimmed only when needed and bound the queue. Send me the number.
Then the merge line (7fe3d68aa5 merged into the integration branch at 0879c4cca4), the card row and the #3176 rows, unticked. Part 2 now merges origin/chase/t3-261114-next at 5c798a3072 or newer into chase/t3-261114-n9b2-providers (part 1 is in it), sets Orchestrator.ts and every other entry to its real length by countLines, nothing raised.

Done: items 1-6 above in this file; goat#3588 (item 1), goat#3589 (item 6), the #3363 receipt (item 3).

#### Block C (goat#3491 rule 3)

Coordinator authorisation, 2026-11-16, rule 3, lane N9b part 2, goat#3491 (a Cursor steer declined after Stop is dropped and still looks delivered; no upstream diff: upstream 2248ca8db9 has the same gap): AUTHORISED. In apps/server/src/orchestration-v2/SteeringDeclined.integration.test.ts, "persists a declined steer without blocking the worker: %s", the row stop-before-decline no longer returns early on assert.isUndefined(queued) (:120): it runs the shared assertions the other rows run (the follow-up run is queued with that message id, and the steer's user message is not among the visible turn items, "a declined steer waiting in the queue must not appear delivered") and then asserts queued?.queueHeld is true. Checked here at c5d8d872d0: the early return is at :120-123, and the issue's first fix option is "queue the follow-up held, as the stop-after-decline case does", with "a test that asserts what the timeline shows". The old assertion pinned the defect the issue describes.
Conditions: (1) held means held: tests that after Stop the queued follow-up does not start by itself, by a runtime mode change (lane N6's C13 rule: a queue held by Stop stays held), by a usage-limit reset, by a provider or model change, or by a server restart; it starts once when the person resumes the queue or sends it, and can be discarded; a second Stop or a replayed decline does not queue it twice; (2) the stop-after-decline row keeps its assertions unchanged, and the two rows now end in the same state: say so in the record; (3) what a person sees and does on web, desktop and mobile (the held item in the queue, how to send or discard it) and what an agent sees through the queue tools, as lines owed to #3519's integrated pass, with the docs/user/cursor.md sentence matching; (4) the verbatim move-out 4430ca2aaa is checked by a scripted diff in the record, and at the merge of the integration head the Orchestrator.ts entry is set to the file's real length, nothing raised. This is an orchestrator change inside a provider lane: keep the hunk in Orchestrator.ts as small as it is now, or put the rule in a GOAT-owned module with a hook. No other expectation in an existing dev test may change in this lane without asking.

### Rows (part 2)

| Row | Upstream | Commit(s) | State |
| --- | --- | --- | --- |
| L408 supportsTextGeneration (C4 contract) | 817b92f13a | 0a3efad7250b4cbea8a11d2d9de16c32882129c4 | ported; rule 3 authorised, conditions 1-4 below |
| goat#3491 Cursor steer declined after Stop | (2248ca8db9 gap) | 4430ca2aaad63396926fe7ab86ad011c5605dd83 (move-out), dfcea5f1aa37de3e98c4fcc7480dd61827be5641, 0ce90194c8101951e221695fc5c921743411d8e2, 780468c0eb0036b54f3547e89bbd74ed3ed6625c (missing import from the move-out) | fixed; rule 3 authorised (block C) |
| a3cde98425 remainder, ACP mock agent bundled once per file | a3cde98425 | e9e859c8c7e17b669dbef7a5546916919598d82f | ported |
| O23 / L407 Cursor team usage (C4) | 497aac20f7 | none in part 2 | ported in part 3 (672400a7da, own branch), held out of #3519 (goat#3632), see Part 3 |

Merges: 9bb7b171c5fa799574f41e9b31e540c719eb44c6 (integration head 5c798a3072, frozen; conflict only in code-budgets.json, Orchestrator.ts entry set to its real 13541), 4bd81da946cf9c67a744452cbbe66a2ebbc5da52 (origin/dev 1d41f2c97f, clean). d6aea844546eddddf07b4d512ed0501761e3a7fd sets AcpAdapterV2.test.ts 8987 -> 8448 and SettingsPanels.tsx 1713 -> 1574 (countLines). Nothing raised.

### L408 decisions and conditions

- GOAT has no TextGeneration.ts preflight. The selection resolvers in packages/shared/src/serverSettings.ts skip a model marked supportsTextGeneration: false (isModelTextGenerationCapable, packages/contracts/src/server.ts) when given provider snapshots: the server passes them for the writer selection and the review guide's own selection, which fall back to the text generation model. The review guide's fallback to the text generation model (serverSettings.ts:243-249) is not checked, and generateReviewGuide is not hooked by the fix round's item 1 (corrected in fix round 2). Memory: every server caller passes no provider list (MemoryWorker.ts:117, MemorySyncService.ts:147, MemorySettingsService.ts:31), so only the web memory display reads the flag; harmless, Pi has no memory runner (packages/provider-pi/src/server/textGeneration.ts:160-163). The base text generation selection: part 2 left it to Pi's own error; the fix round's item 1 (8042a90a37) moves it off a flagged model in TextGeneration.ts (corrected in the fix round, item 5).
- Left out: TextGeneratorsSettings.tsx and VoiceSettingsPanel.tsx (GOAT has neither); TextGeneration.ts and its CodexTextGeneration.test.ts preflight rows in part 2 (no preflight in GOAT; carried in the fix round, item 1); MemoryGenerationSettings.tsx (Pi runs no memory operations). Upstream's web case lives in apps/web/src/modelSelection.textGeneration.test.ts (modelSelection.test.ts would pass its 1320 entry).
- Condition 1: the credentials case pins that exactly one rpc probe carries --no-extensions and --no-tools; with --no-tools dropped it fails ([[false,false],[true,false]]).
- Condition 2: every Pi and OmO status check now starts one extra short-lived process (pi --mode rpc --no-extensions --no-tools). When a status check runs (packages/provider-core/src/server/managedProvider.ts; one managed provider per Pi or OmO instance, packages/provider-pi/src/server/driver.ts:206-212): at instance start (:448, applySnapshot forceRefresh), on each settings change of that instance (:417), periodically every providerHealthRefreshInterval while a client wants it (default 5 minutes, packages/contracts/src/settings.ts:1014; 30 s after a failed check, managedProvider.ts:45), and on a refresh request (:460). So the extra process runs once per check per Pi/OmO instance. Timeout 5 s (PI_TEXT_GENERATION_DISCOVERY_TIMEOUT_MS, upstream's value), inside the normal discovery deadline. Timeout or any other failure of the listing: models unchanged (every model still offered, as before). Pi exiting before answering (PiRpcError read or exit) or answering with an empty list: every listed model marked false and the provider supportsTextGeneration false (textGenerationUnavailable only for an empty result). The listing is a fiber forked into discoverPiViaRpc's scope (Effect.forkScoped under Effect.scoped) and its connection is scoped, so the process ends with the check and is closed with the server's scopes at shutdown.
- Condition 3 (C4): packages/contracts/src/server.test.ts "decodes both ways between peers with and without supportsTextGeneration" (an older server's model without the field decodes and reads as supported, so every model is still offered; the pre-change model struct, an older client, decodes a payload carrying false and drops the field) and "rejects a model whose text generation flag is not a boolean". packages/shared/src/serverSettingsTextGeneration.test.ts: with the flag absent (older server) the writer, review guide and memory selections keep the model. Pickers that change: web Settings text generation model (GeneralSettingsPanel in SettingsPanels.tsx:545, the row at :580; corrected in the fix round) and Source control writing (writer and review guide models; turning on a separate writer refuses a flagged default with a toast). GOAT has no text generators or voice cleanup picker. Mobile has no text generation model picker (apps/mobile only reads the resolved memory selection, SettingsMemoryRouteScreen.tsx:397).
- Condition 4, fail first: provider-pi status.test.ts 4 failed | 20 passed; shared serverSettingsTextGeneration.test.ts 3 failed | 1 passed; contracts server.test.ts 2 failed (field removed); web modelSelection.textGeneration case "getTextGenerationModelOptionsByInstance is not a function". After: provider-pi src 275 passed | 1 skipped, shared src 2283 passed | 5 skipped, contracts server.test.ts 23 passed, web modelSelection 49, providerInstances 28, new file 1, SourceControlWritingSettings browser 1.
- Owed to #3519's integrated pass: with a Pi that has an extension-registered model, the web text generation and source control pickers do not offer it; the thread composer still does.

### goat#3491

- Fix: Orchestrator.ts dispatchMessage no longer drops a steer follow-up whose run Stop already reached; it records steerFollowUpAfterStop and the queued run gets queueHeld: true (5 lines in Orchestrator.ts plus the import). Opened with the verbatim move-out 4430ca2aaa. Scripted check: the lines 4430ca2aaa removes from Orchestrator.ts equal threadUnfinishedWork.ts, blank lines aside (diff of `git diff 4430ca2aaa^ 4430ca2aaa -- Orchestrator.ts | grep '^-'` against the new file: no difference); ScratchThreadPromotion.ts changes only its import path. 4430ca2aaa's commit message says "one consumer", but Orchestrator.ts:4048 also used it: the move-out missed that in-file use (TS2304 in the gate); 780468c0eb adds the import and drops a one-line comment so the file stays at 13541. 4430ca2aaa through 4bd81da946 do not typecheck alone and cannot be used for bisecting (corrected in the fix round).
- Fail first: stop-before-decline 1 failed | 3 passed, "expected undefined to equal 'queued'". After: 5 passed.
- Condition 1 (0ce90194c8): after Stop, a second Stop, a replayed decline, a runtime mode change, a model change and a restart (resumeQueuedRuns) leave exactly one follow-up, queued and held, and start nothing; queue.resume starts it once (a second resume and a restart start nothing more); the row "stop-before-decline, discarded" cancels it and it never starts. With the hold removed both rows fail ("expected 2 to equal 1"). Not tested separately: a usage-limit reset. The reset path dispatches a continuation message (UsageLimitRecoveryWorker.ts:69-80), and queued runs start only through startNextQueuedRun, which skips held runs (nextQueuedRun, Orchestrator.ts:634), the same path the restart case covers.
- Condition 2: the stop-after-decline row is unchanged. Corrected in the fix round (coordinator decision, item 2): the follow-up is held after a Stop that holds the queue, by a person or an agent, and queued and run otherwise; in both orders it is not shown as delivered.
- Condition 3, owed to #3519's integrated pass: on web, desktop and mobile the held follow-up shows in the thread's queue while the queue is held after Stop; the person sends it by resuming the queue (or sending that item now) and discards it by removing the queued item; an agent sees it through the queue tools as a held queued message. docs/user/cursor.md (d68baa330e) says that after a Stop by you or an agent the follow-up stays held until the queue is resumed, also when Cursor answers the steer after the Stop, and that after an interruption that leaves the queue running it is queued and runs (corrected in fix round 2).
- Condition 4: see the scripted check above; Orchestrator.ts entry 13541 (its real length) after the merge of 5c798a3072.

### a3cde98425 remainder (test speed)

AcpMockRuntime.testkit.ts builds one bundle of scripts/acp-mock-agent.ts per test file (upstream's vite-plus build options), runs it with NODE_COMPILE_CACHE beside it, and removes the temp directory in afterAll. GOAT's beforeAll is plain vitest and ignores a returned Effect, so the build runs through Effect.runPromise. Wall clock of vp test run on pen-macmini, Node 26.12.1: AcpAdapterV2.test.ts 27.04 s -> 14.49 s (94 passed both); the five sibling ACP files together 10.37 s -> 5.68 s (32 passed both).

### O23

Rule 3 authorised (quoted above). Not started in this thread: the context went to the other rows and the gate. A Cursor CLI login exists in this Mac's Keychain (item cursor-access-token present; the token was not read), so the live personal read can run on pen-macmini once the port exists. The team fan-out still needs a person with a Cursor team account. The #3176 row stays open as "needs a live Cursor check".


### Gate (part 2)

Run on pen-macmini at 780468c0eb0036b54f3547e89bbd74ed3ed6625c (contains the frozen integration head 5c798a3072, merge 9bb7b171c5, and origin/dev 1d41f2c97f, merge 4bd81da946). Node 26.12.1 first on PATH, `set -o pipefail`.
- `node scripts/goat-rename.ts --check`: 0 (0 lines with T3 residue).
- `vp run check:changed`: GATE_EXIT 1. Passed: goat-rename, unused patches, format, graphql (2), typecheck (42 packages), lint, agent context budget, agent surface audit (no change to docs/internals/agent-surface-audit.md), knip 1/2 and 2/2. vp test (1304 files): 2 failed, 1298 passed, 4 skipped (20360 tests passed, 12 skipped). The two failures are the known packages/ssh cases with no diff against origin/dev: runtimeFactsScripts.test.ts "expected +0 to equal 1" (goat#3363) and tunnel.client-session.test.ts "Remote host is missing node on PATH" (goat#3418).
- Earlier attempts do not count: the first found TS2304 (fixed in 780468c0eb); a stale node_modules (@betteroffice/xlsx 0.3.0 against 0.5.1 in the lockfile) failed web typecheck until `vp i`; two runs overlapped my own earlier gate runs and failed with vitest cache and module-runner errors. I stopped those runs by PIDs traced from my own gate shells (goat#3238 rule) and reran alone.

### Full CI for part 1

The full CI run of #3519 on the frozen head 5c798a3072, which holds part 1 (merged at 0879c4cca4), finished SUCCESS: https://github.com/goat-si/goat/actions/runs/43922119605 (28 jobs, 26 passed, 2 skipped, none failed). That is the full-matrix proof for part 1, including the jsonc-parser row (L383 cc97303381) and its server bundle build, which needed ci:full.

### Known limits (part 2)

- L408: part 2 left the base text generation selection on a flagged Pi model (settings-only fallback); the fix round's item 1 closes this. The listing adds one short-lived process per Pi or OmO status check.
- goat#3491: a usage-limit reset has no separate test (see condition 1 above).
- O23 not ported in this thread.

### NOT RUN (part 2)

- O23 (port, its C4 tests, the live personal read on this Mac, the team fan-out check).
- Full CI for part 2; the real-client pass (#3519) for the L408 pickers and the held goat#3491 follow-up; a live Pi with an extension-only model.

## Part 2 fix round (branch chase/t3-261114-n9b2-providers, 780468c0eb -> 8964efb090)

Review /Users/jun/handoff-in/chase/next-N9b2-review-780468c0.md: APPROVE WITH NITS at 780468c0eb (one P2, five P3). The fix round runs in a separate GOAT-managed worktree on pen-macmini; part 3 (O23) works in part 2's original worktree on chase/t3-261114-n9b2-o23, untouched here. Item 7 (the merge of the post-N3 integration head and the gate) waits for lane N3.

### Coordinator texts (verbatim)

#### Ruling

> N9b part 2 review at 780468c0eb: APPROVE WITH NITS, no P0 or P1; one P2, five P3. Report /Users/jun/handoff-in/chase/next-N9b2-review-780468c0.md. The lane is not merged now: chase/t3-261114-next is frozen until lane N3 lands. The wait is used for a fix round on chase/t3-261114-n9b2-providers, one commit per item, test first, focused tests only on pen-macmini while part 3 works there, no force push:
> 1. N9b2-P2-1 (code, test first; COORDINATOR DECISION: fix it here, not a record line). After this lane a text generation model saved on Pi that is now flagged (an extension-only model, or any model on a Pi whose extension-free listing is empty) shows in Settings as another model ("Pi default", or another provider's model) while the server keeps running the saved one, and thread titles, branch names and commit messages keep failing with Pi's "rejected model ... runs Pi with --no-extensions" error. Upstream 817b92f13a moves off such a model in its TextGeneration.ts hunk, which this lane left out. Carry that behaviour: in apps/server/src/textGeneration/TextGeneration.ts resolveText (:78-102) read the selected instance's status snapshot (the file already holds the provider registry) and fall back the way resolveSourceControlWriterModelSelection does, with isModelTextGenerationCapable and isProviderTextGenerationCapable, so what Settings shows is what the server runs. Port upstream's hunk and its CodexTextGeneration.test.ts case where they fit and record every difference. Tests first: a saved flagged Pi model generates through the fallback model instead of failing; a Pi whose whole listing is flagged falls back to another capable provider or to the documented default; an older status without the flag keeps the saved model; a model an agent sets through goat_environment_settings_update gets the same fallback (the tool does not check the list: say so in the record). If the snapshot is not yet available at server start, the saved model is used as before (say what the user then sees). Keep the change a thin check; if TextGeneration.ts needs more than that, put the rule in a GOAT-owned module.
> 2. N9b2-P3-1 (code, test first). The declined follow-up is held only when the Stop held the queue. Orchestrator.ts:5170 uses stopReachedRun (:9866-9878), which is true after ANY interrupt (an agent's interrupt, a forced stop, a queued goal command that stops the turn, the approval-wake withdraw, the goal worker, the channel bot), so a thread an agent is driving can stall behind a held follow-up until a person acts, and later agent and server messages queue held behind it (:5967-5999). Hold the follow-up only when the interrupt that reached the run held the queue; after an interrupt that did not, the follow-up is queued without a hold and runs, exactly as when the decline lands before such an interrupt. Use state the orchestrator already has (the thread's queue-held state, or the interrupt's own record); if this needs a new field on a stored item or event, STOP and ask: that is a C4 change. Tests: an agent interrupt then a decline (queued, not held, starts once); a person's Stop then a decline (held, as now).
> 3. N9b2-P3-2 (code, test first, if small). When the hold applies and the steered run is no longer active at dispatch, queue the follow-up held behind the source run, as worktreeMissingRun does (:5791-5804), so a follow-up can never start right after a Stop; if that is not a small change, record the dependency on the per-thread effect order (EffectOutbox.ts:274-290) with the reviewer's reasoning instead.
> 4. N9b2-P3-3 (test). The held-means-held step uses a real model change ({ ...runSelection, model: "other-model" }); the record says a provider switch is covered by reading the code (only queue.resume, queued-run.start and thread.runtime-mode.set start the queue, Orchestrator.ts:12891-12897).
> 5. N9b2-P3-4 (record). GeneralSettingsPanel, not ThreadsSettingsPanel; the memory sentence (only the web memory display reads the flag; Pi has no memory runner); 4430ca2aaa's "one consumer" corrected; 4430ca2aaa through 4bd81da946 do not typecheck alone and cannot be used for bisecting.
> 6. N9b2-P3-5 (docs). One sentence in docs/user/providers-pi.md: models that an extension or package registers run in threads but are not offered for text generation (titles, branch names, commit messages).
> 7. After lane N3 is merged (I tell you the head): merge origin/chase/t3-261114-next once; adapt to Effect 4.1.3 (apps/server/src/orchestration-v2/Adapters/AcpMockRuntime.testkit.ts is the lane's only own Effect code: Scope.makeUnsafe, Scope.provide, Scope.close; status.ts is upstream's code written on 4.1.3); every budget entry at its real length, none raised; if lane N7 part 2 landed first, the Orchestrator.ts conflict at the top of dispatchMessage keeps both sides (N7's narrowed projection read and this lane's let steerFollowUpAfterStop) and the reviewer counts 13532 lines; goat-rename --check, format, lint, typecheck, the focused tests, check:changed; READY. A narrow fresh review of this fix round and the merge runs before the lane is merged.
> Owed to #3519's integrated pass (put in the record): the three web pickers with a Pi whose models are extension-only (General text generation, source control writer, review guide) and the toast; a held follow-up after a Stop and a declined Cursor steer on web, desktop and mobile with resume and discard; live Pi and live Cursor are NOT RUN.

#### Item 2 decision

> Coordinator decision, 2026-11-16, lane N9b part 2, item 2 (N9b2-P3-1): OPTION A. The run_interrupt_request turn item gains an optional holdsQueue (written as true by run.interrupt only when holdQueue is true, omitted otherwise) at both schema sites (packages/contracts/src/orchestrationV2.ts:1714 and :2602), and the declined steer's follow-up is held only when the interrupt request that reached the steered run carries it. Reasons: B gets one direction wrong (after an agent's or a channel's thread.stop, which holds the queue, the follow-up would start a turn on a thread that was just stopped) and C the other (after an interrupt that does not hold the queue, a thread an agent is driving stalls, and later agent and server messages queue held behind it, until a person acts); both happen in orchestrated work, and A is one optional field. A string match on the stop reason is not a contract.
> Conditions (C4: a stored and wire shape gains an optional field):
> (1) Additive only: no migration, no change to any other reader of run_interrupt_request (list every reader with path:line and say it ignores the field: stopTerminationKind, the timeline rows on web and mobile, agents' thread reads, checkpoints, restart recovery).
> (2) Tests, each failing first where it can: a person's Stop then the decline: held; an agent's thread.stop (holdQueue true, an agent reason) then the decline: held; an interrupt that does not hold the queue (an agent's run interrupt, the goal worker) then the decline: queued without a hold and it starts once; an item WITHOUT the field (written by a build before this one) then the decline: not held (the follow-up runs, which is dev's order for a decline that lands before the interrupt); two interrupts on one run, the first without and the second with a hold: held (the rule is "any interrupt request on that run that holds the queue").
> (3) Older peers: an older client and an older agent reader decode an item that carries the field (the test decodes it with the pre-change struct and the field is dropped); an older server never writes it and this build reads its items as not held; after a downgrade the older server ignores the field and behaves as dev (the follow-up is dropped there: say so). The record states the one case this leaves: a Stop recorded by an older build, then an upgrade, then the decline: the follow-up runs; a restart cancels process-bound effects, so this needs the decline to survive the restart: say whether it can.
> (4) The item's size and frequency do not change in any way that matters (one boolean on an item written once per interrupt). The hunk in Orchestrator.ts stays small (stopReachedRun's caller reads the field; no new projection read: the items are already loaded there, or say what is read and its cost under lane N7's narrowed reads).
> (5) docs/user/cursor.md and the record's sentence "the two rows now end in the same state" are corrected to: held after a Stop that holds the queue, by a person or an agent; queued and run otherwise. goat#3491 gets a comment with the final rule.
> Item 3 (N9b2-P3-2) stands as ruled and uses the same rule. This goes into the narrow fresh review of the fix round as a C4 item.

### Commits (fix round)

| Item | Commit | What |
| --- | --- | --- |
| 1 N9b2-P2-1 | 8042a90a377351a69ba069e2679bfd49b6c443ac | text generation moves off a model or provider the status flags (textGenerationCapability.ts; thin hook in TextGeneration.ts) |
| 2 (budget) | 71f086e1ed232a6d004e315f503f65a8ec6795e6 | verbatim move-out of pendingThreadTitleGenerationEffect to threadTitleGenerationEffect.ts (Orchestrator.ts at its 13541 entry) |
| 2 N9b2-P3-1 (C4) | 1f4552a7cf6ced0024ef133f787948af6afaf9cf | holdsQueue on run_interrupt_request; the follow-up is held only when it is set |
| 3 N9b2-P3-2 | f22ab6dcae2f1132fce49c0d12a790ab64473ccf | held follow-up queues behind the steered run once it has ended |
| 4 N9b2-P3-3 | 8477676ee6f6d38df0beab741795706b170f256b | held-means-held step selects another model |
| 2 condition 5 | d68baa330ec1ebc0c8da24978cd18c95ea710688 | docs/user/cursor.md: held after a Stop by a person or an agent; queued and run otherwise |
| 6 N9b2-P3-5 | 2b7a967987fe9a5000bb061fd6c6d9ef7f64b1a7 | docs/user/providers-pi.md: extension models are not offered for text generation |
| 2 (second writer) | 8964efb090fdc6bac72f27d4d00d49271aad8186 | markStoppedRun's item carries holdsQueue (its only callers are holding stops) |
| 5 N9b2-P3-4 | records only | corrected in place in the part 2 sections above |

Plain fast-forward push 780468c0eb..8964efb090; no merge in this round (integration branch frozen at 5c798a3072, already contained).

### Item 1: text generation runs what Settings shows

- Rule (apps/server/src/textGeneration/textGenerationCapability.ts:38): for thread titles, branch names, commit messages and PR content, TextGeneration.ts:79 reads the selected instance's status snapshot through the provider instance registry. A model flagged supportsTextGeneration: false on a capable provider runs on that provider's default model (fix round 2: textGenerationDefaultModel, the same pick the web makes; Pi and OmO: "default"). A provider flagged as a whole moves to the first enabled, available, capable instance in fallbackTextGenerationModelSelection's order (packages/shared/src/serverSettings.ts: codex, claudeAgent, cursor, grok, muse, pi, omo, opencode, antigravity, then configured instances); with none, to its own default (Pi "default", the documented "Pi default", which skips Pi's set_model and so its --no-extensions rejection). API text generators (settings.textGenerators) are not checked. Review guide, channel reception and memory use resolveAgent and are unchanged; the writer selection and the review guide's own selection are resolved with provider snapshots on the server (GitManager.ts:2958, ThreadLaunchService.ts:458); the review guide's fallback to the text generation model (serverSettings.ts:243-249) is not checked and generateReviewGuide is not hooked (corrected in fix round 2).
- Differences from upstream 817b92f13a: upstream's hunk adds two conditions to the preflight in its TextGeneration.ts, which GOAT does not have; GOAT carries the rule in a GOAT-owned module with a 15-line hook. Upstream's CodexTextGeneration.test.ts rows ("cannot generate text", "model cannot generate text") extend that preflight table, so they become TextGeneration.test.ts cases. Where upstream's fallback goes through its preflight settings fallback, GOAT moves a flagged model to the same provider's default model, as the web picker does. Remaining differences from the web picker: the web takes the first enabled, available provider in the server's provider list order, the server the fallback driver order (same result when the list follows that order; not proven for every list); the web keeps model options normalised for the new model, the server drops options on a fallback model; with no capable provider at all the web shows no provider and the server runs the provider's own default.
- Agent path: goat_environment_settings_update stores textGenerationModelSelection through ServerSettingsService.updateSettings (apps/server/src/mcp/toolkits/environment/handlers.ts:258-300) without checking the model against the provider's list. The test saves a flagged model that way and the call runs on Pi default.
- Before the first status check (isAwaitingFirstCheck) or for an unregistered instance the saved model runs, as before. The placeholder snapshot carries no flags, so Settings shows the saved model too; if it is an extension model, calls fail with Pi's rejection until the check that runs at instance start completes.
- Tests (TextGeneration.test.ts "TextGeneration model Settings no longer offers"): flagged model -> Pi default; whole listing flagged -> codex's default model; no other capable provider -> Pi default; status without the flag and status not checked yet -> saved model; agent-saved flagged model -> Pi default. Fail first: 4 failed | 4 passed ("model": "demo/demo-model" where "default" or codex was expected). After: TextGeneration.test.ts and TextGeneration.installationGate.test.ts 9 passed; OpenCode2TextGeneration, TextGeneratorApi, providerMaintenanceInstallationGate 40 passed. Setup-only change: the installation gate test's stub instance gains snapshot { isAwaitingFirstCheck: true } (no expectation changed).

### Item 2: holdsQueue (C4)

- Writes: run.interrupt (Orchestrator.ts:10548-10571) sets holdsQueue: true when holdQueue is true or an earlier request on the run already carries it. The item id is per run (runSignalTurnItem "interrupt-request") and each interrupt rewrites it, so a later interrupt that does not hold keeps the flag. markStoppedRun (:9925) writes it always: its only callers are holdStoppedThread (:10015) and thread.stop (:11175), both holding stops, and it never overwrites an existing request. The unresponsive marker (:10116-10132) spreads the item and keeps it. thread.stop reaches the steered run through run.interrupt with holdQueue: true (:11140).
- Read: dispatchMessage (:5156) calls stopReachedRun(..., true) (:9858-9875), the same indexed read it made before (turnItemTypes run_interrupt_request, turnItemRunIds [steered run]); no new projection read. Lane N7's narrowed projection read is a separate call and does not change this one. run.interrupt adds that read only when holdQueue is not true: one indexed lookup of at most one row per interrupt.
- Condition 1, every reader ignores the field (no migration; 068_ShellStopRequestIndex.ts:10 indexes by type only): stopTerminationKind and its callers read message (runTerminationCause.ts:128, goat/ProviderRunControls.ts:77-83); agents' thread reads print message (mcp/threadReadItems.ts:61) and status reads unresponsiveAt (mcp/threadStatus.ts:115-129, delegatedForceStop.ts:30,76); web timeline rows (MessagesTimeline.logic.ts:1051,1724, TimelineV2EventRow.logic.ts:37, V2LifecycleRow.tsx:64,88, session-logic.ts:372); mobile (lib/threadActivity.ts:479,538,2021, threadActivityIcons.ts:85); client runtime (state/orchestrationV2Projection.ts:427, threadExecution.ts:632-637, threadHistoryMerge.ts:97); shared timeline (orchestrationV2Timeline.ts:36,100); restart recovery and continuations (RestartContinuation.ts:320-354, restartedDelivery.ts:10, provider/CodexSurvivorRecovery.ts:239,402-415, Orchestrator.ts:1686,2059); history and shell reads (threadHistoryPaging.ts:227,519-525,570,700, threadShellProjection.ts:424, ProjectionShellThreadRows.ts:159,220, ProjectionStore.ts:2230,2424,2509,3609,5653-5658,5875-5878); fleet fallback (fleet/resources/Fallback.ts:305-310); ThreadManagementService.ts:1167,1220; the other Orchestrator.ts reads test presence only (:9646-9655, :9893-9894). Checkpoints do not read the item. The agent-visible text is unchanged (message only), so no agent surface or context budget output changes.
- Condition 2, tests (SteeringDeclined.integration.test.ts): person's Stop -> held (existing stop-before-decline rows); agent thread.stop ("Stopped by an agent: done") -> held; agent run interrupt ("Stopped by an agent") -> queued, unheld, starts once; goal worker ("The fleet goal no longer needs this worker.") -> same; an item without holdsQueue (run.interrupt with neither holdQueue nor reason, byte for byte what an older build wrote for a Stop) -> same; unheld then held -> held; held then unheld -> held. Fail first (old code, final tests): 4 failed | 8 passed, three rows "expected true to equal false" (held where they should run) and the item 3 row. The rows that pass on old code (agent thread.stop, the two two-interrupt rows) guard the hold against this change.
- Condition 3, older peers: packages/contracts/src/orchestrationV2.interruptRequest.test.ts. The field survives storage and the wire; the pre-change struct (an older client or agent reader) decodes a request carrying it and drops it; an older server's request has no field and reads as not held; any value but true is refused. Fail first with the contract change removed: 2 failed | 2 passed. After a downgrade the older server ignores the field. On dev before this lane it drops the follow-up of a steer declined after Stop (the early return part 2 removed); on a part 2 build without this round it holds after any interrupt. The upgrade case (a Stop recorded by an older build, an upgrade, then the decline, which would run the follow-up) cannot happen: provider-turn.steer is process-bound (EffectOutboxEffectTypes.ts:21-27) and is cancelled when the server process ends (EffectOutbox.ts:337-350), except on threads the runtime recovery protects (ProviderRuntimeRecoveryService.ts:902-908). Cursor's decline comes from the live steer effect, so a pre-upgrade steer's decline is not delivered after the upgrade. By reading; not tested.
- Condition 4: one boolean key on an item written once per interrupt request (and once by markStoppedRun). Orchestrator.ts: +14 lines across the read, the write and markStoppedRun (move-out -14 first).
- Condition 5: docs/user/cursor.md corrected (d68baa330e); the part 2 sentence is corrected in place above; goat#3491 comment with the final rule: https://github.com/goat-si/goat/issues/3491#issuecomment-6928593708

### Item 3: a held follow-up never starts after a Stop

When the hold applies and no run is active at dispatch, queueBehindRun falls back to the steered run (Orchestrator.ts:5786-5794), so the follow-up queues held, as after a failed worktree setup. Test row "stop, then the run ends before decline": a person's Stop, then ingestion ends the run (turn.terminal interrupted, awaited on the domain event stream) inside the steer effect, then the decline. Fail first with item 2 only: 1 failed | 11 passed, "expected false to equal true" (not held; it started). After: 12 passed.

### Item 4

The held-means-held step now dispatches thread.model-selection.set with { ...runSelection, model: "other-model" }. A provider switch is covered by reading the code: only queue.resume, queued-run.start and thread.runtime-mode.set start the queue (Orchestrator.ts:12892-12896 at 8964efb090).

### Item 5 (corrections made in place above)

- The text generation setting is in GeneralSettingsPanel (SettingsPanels.tsx:545; the row at :580), not ThreadsSettingsPanel.
- Memory: every server caller passes no provider list (MemoryWorker.ts:117, MemorySyncService.ts:147, MemorySettingsService.ts:31), so only the web memory display reads the flag; harmless, Pi has no memory runner (packages/provider-pi/src/server/textGeneration.ts:160-163).
- 4430ca2aaa's commit message says the moved function has "one consumer"; Orchestrator.ts:4048 (at 780468c0eb) also used it (the TS2304 fixed in 780468c0eb). 4430ca2aaa through 4bd81da946 do not typecheck alone and cannot be used for bisecting.
- L408 decision and known limit lines now point to item 1.

### Item 6

One sentence in docs/user/providers-pi.md (2b7a967987).

### Budgets (fix round)

oxlint-plugin-goat/code-budgets.json unchanged. Orchestrator.ts 13541 -> 13541 (entry 13541, its real length). packages/contracts/src/orchestrationV2.ts 4476 -> 4478 (entry 4478; the new field has no doc comment to stay inside it). Under the 1000-line default: TextGeneration.ts 232 -> 248, TextGeneration.test.ts 297 -> 468, SteeringDeclined.integration.test.ts 278 -> 399, new textGenerationCapability.ts 75, threadTitleGenerationEffect.ts 18, orchestrationV2.interruptRequest.test.ts 60. No new non-null assertions outside tests, no casts to any, no React effects.

### Checks run (fix round, pen-macmini, Node 26.12.1)

Focused tests above, plus the orchestration files that read or write interrupt requests: ThreadStop, ThreadManagementService, RestartContinuation (+survivor), RestartUnsupported, SelectionRestart, SteeringCompletion.goal, CloudIngress, WorkTimerContinuation, DelegatedCompletionDelivery.restart, ProviderTurnStartService, delegatedForceStop, Fallback, threadStatus, ThreadStream: 15 files, 361 passed. Steering suites (SteeringCompletion x4, SteeringCompletionWake, SteeringDeclined): 41 passed. Typecheck apps/server, apps/web, packages/contracts: 0. vp fmt and vp lint on changed files: 0 (pre-commit hook on every commit). node scripts/goat-rename.ts --check: 0.

### Owed to #3519's integrated pass

The three web pickers with a Pi whose models are extension-only (General text generation, source control writer, review guide) and the toast; a held follow-up after a Stop and a declined Cursor steer on web, desktop and mobile with resume and discard; after an agent's run interrupt, the declined follow-up runs. Live Pi and live Cursor are NOT RUN.

### Known limits (fix round)

- Item 1: the server's fallback order for a wholly flagged provider follows the text generation driver order, the web picker the provider list order; options are dropped on a fallback model.
- Item 2: a run stopped only through markStoppedRun is not reachable by a steer today (a steered run has an active provider turn, so Stop interrupts it through run.interrupt); its holdsQueue has no behaviour test.

### NOT RUN (fix round)

- vp run check:changed and the gate (item 7, after N3, when the heavy slot is free); full CI.
- Mobile typecheck and tests (contracts change is additive; mobile reads the item by type only).
- Real-client passes (#3519 list above); live Pi with an extension-only model; live Cursor steer decline.
- A behaviour test for markStoppedRun's holdsQueue; a usage-limit reset test (as in part 2).


## Part 3 (O23) (branch chase/t3-261114-n9b2-o23, cut from 780468c0eb)

O23 is held out of #3519 (coordinator decision 2026-11-17 below; goat#3632): #3519 does not contain it, and until the O23 pull request merges, dev keeps the cursor.com dashboard read with the Keychain token and no team history.

Row O23 only (L407, upstream 497aac20f7, owner decision A), on its own branch on top of part 2's head 780468c0eb0036b54f3547e89bbd74ed3ed6625c, which stays fixed. Integration head contained: 5c798a3072 (frozen), through 780468c0eb. No merge of origin/dev on this branch, so the O23 commit stays the only change on top of part 2.

### Coordinator text (verbatim)

Coordinator authorisation, 2026-11-16, rule 3, lane N9b part 2, row O23 (L407, upstream 497aac20f7 "include Cursor team usage in account history", owner decision A: move GOAT to upstream's api2 bearer requests): AUTHORISED. In packages/provider-cursor/src/server/accountUsage.test.ts, "reads paginated Cursor account history including headless calls with separate cache tokens" (:68), the three assertions that pinned the old destination (:77 the cursor.com dashboard URL, :79 the origin header, :81 the WorkosCursorSessionToken cookie) become upstream's own three for the same case: the URL https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents, connect-protocol-version "1", and authorization "Bearer <accessToken>". The redirect "error" and content-type assertions and everything after stay. The shared fetch helper may answer GetMe and GetTeams first, as upstream's helper does: setup only. Checked here: the three old lines are at :77, :79 and :81 at c5d8d872d0, and the decision sheet's O23 entry names this move.
Conditions (C4: a stored login token goes to a new endpoint, and a cache file changes version):
(1) Keep the pin the old assertions gave, as new negative tests: across a whole account read (GetMe, GetTeams, every GetFilteredUsageEvents page, every team) each request goes to https://api2.cursor.sh and nowhere else, carries the token only in the authorization header, never in a cookie, a URL or a body, and is sent with redirect "error" (a redirect must not carry the bearer to another host); a login whose token is missing or expired sends nothing.
(2) Failure and bounds, each with a test and a line in the record: GetTeams refused or failing (what the user gets: personal history, or an error: say which and that it matches upstream); a personal account with no teams; a 401 (the read fails visibly and does NOT clear or change the stored Cursor login); how many requests one usage read makes (1 + 1 + pages x (1 + teams)) and the limits on teams and pages; timeouts and the abort signal reach every request; nothing of the token or of response bodies goes to a log, a span or an error message.
(3) The cache file v1 to v2: what this build does with a leftover v1 file (ignored, removed, by which code) and what an older build does with a v2 file after a downgrade (it reads only v1 and rescans; nothing crashes; the v2 file is left for a later upgrade), each as a test or with path:line; a malformed v2 file falls back to a fresh read.
(4) The live check. This row replaces a request that works today, so it does not merge unverified. Put the O23 commit LAST on chase/t3-261114-n9b2-providers (or on its own branch on top) so the rest of part 2 can be reviewed and merged without it. It joins the lane when a live read through the new code path has returned usage for a real Cursor login: if a Cursor CLI login exists on the lane's Mac, run that read once yourself (it is the same read GOAT's Usage page makes, against Cursor's own API, as the owner's decision A names) and record only status codes, the number of events and the number of teams, never the token or event contents; if no login is there, say so and the commit waits for a person. The team fan-out still needs a person with a Cursor team account: until then the #3176 row stays open as "needs a live Cursor check" even if the personal read passed.
No other expectation in an existing dev test may change in this lane without asking.

### Row (part 3)

| Row | Upstream | Commit | State |
| --- | --- | --- | --- |
| O23 / L407 Cursor team usage (C4) | 497aac20f7 | 672400a7da33a75a8d2d28c64006ddf6d0df2d82 (port), 49c834520adcfd1e4992a78b1522287f6a5cf7ba (test, review P3-3) | held out of #3519 until a live Cursor read passes (goat#3632); code complete, live read owed (the lane's read sent nothing, see (4)); needs a live Cursor check |

### What the port does

- packages/provider-cursor/src/server/accountUsage.ts: all three GOAT credential sources (Cursor auth file, macOS Keychain login, API key) now read account history from https://api2.cursor.sh/aiserver.v1.DashboardService/* with `authorization: Bearer <token>` and `connect-protocol-version: 1` (:217-223). GetTeams and GetMe run first, together (:251-254), then GetFilteredUsageEvents for personal history and for each team with teamId and the GetMe userId in the body, two scopes at once (:475-479). Team records carry the team id in their dedupe identity; personal dedupe keys are unchanged (the paginated-history case keeps its exact key). The cursor.com dashboard URL, the Origin header and the WorkosCursorSessionToken cookie are gone, and with them the userId taken from the JWT subject.
- packages/provider-cursor/src/server/accountCache.ts:88-89: usage-cursor-account-cache-v2.json, version 2, as upstream.
- GOAT differences from upstream (also the cursor.usage.teams span annotation, accountUsage.ts:482, a count only): GOAT keeps its credential sources and readCursorAccountUsage's signature, so CursorAccountReader.ts is unchanged. Added here: an expired token (JWT exp at or before now) returns "Sign in to Cursor again to read account usage." before any request (:205-216); more than 100 teams fails the read before any page (MAX_TEAMS, :116, :258); GetMe/GetTeams failures carry a fixed reason inside their span (:243-249).
- Left out: upstream's in-memory session cache (makeCursorAccountUsageReader with Cache.makeWith, keyed by API key, TTL up to 5 minutes or the token's exp, invalidated on 401) and its test "reuses discovery for $lifetime, invalidates rejected auth, and isolates API keys". GOAT's reader has no per-layer state and CursorUsageAccounts already limits refreshes to one per credential per CURSOR_ACCOUNT_TTL_MS (60 s); the cost is the two membership requests on every refresh. Also left out: the test helper's API-key exchange shortcut (GOAT's API-key test keeps the exchange in its request list), and the queued:false half of upstream's queued-deadline test (GOAT's "reads the pages behind the first together and keeps them in page order" is that case).
- Tests carried from upstream: "includes each team's own-user history alongside personal history", "rejects unscoped or incomplete team history without keeping personal totals", "starts personal and team reads together without waiting for either response", "reads concurrent pages in order with a full request deadline after queuing" (queued case).

### Rule 3

Only the three authorised assertions changed in an existing test (accountUsage.test.ts paginated-history case: the api2 URL, connect-protocol-version "1", authorization "Bearer <accessToken>"). The shared helper answers GetMe and GetTeams before the test's own answer (setup only) and has an optional `seen` hook the new tests use; no other existing expectation changed.

### Conditions and evidence

(1) Pin: "sends every request of a team account read to api2 with the token only as a bearer and redirects refused" (accountUsage.test.ts) reads a two-team account with two pages per scope, once from the auth file and once from the Keychain source, and checks all 8 requests: origin https://api2.cursor.sh, path under /aiserver.v1.DashboardService/, redirect "error", authorization exactly "Bearer <token>", no cookie header, the token in no other header, not in the URL, not in the body. "sends nothing for a missing or expired login": Keychain returning no token, and an expired token from the auth file and from the Keychain, make 0 requests.

(2) Failure and bounds:
- GetTeams or GetMe refused or failing (403, 500, transport error, error envelope, malformed teams, non-positive team id, GetMe 401, GetMe without userId): the user gets an error, "Cursor account usage could not be read.", and no personal history; no usage page is requested. This matches upstream, where readSession fails and the whole read fails. Test: "fails the whole read, as upstream does, when GetTeams or GetMe is refused or broken".
- No teams (GetTeams answers {} or {teams: []}): personal history only, 1 + 1 + pages requests. Test: "reads only personal history for an account with no teams".
- 401: a 401/403 on a usage page shows "Sign in to Cursor again to read account usage."; a 401 on GetMe/GetTeams shows "Cursor account usage could not be read." (upstream treats any non-2xx membership answer the same way). Records stay empty. The stored login is not changed: the test "reports a rejected login without changing the stored Cursor login" checks the auth file is byte-identical afterwards; the Keychain service only reads (CursorKeychain.ts:38-46, one accessToken effect) and nothing in packages/provider-cursor writes the item; CursorUsageAccounts records the failure for its TTL and leaves the account cache as it was (CursorUsageAccounts.ts:135-141).
- Request count for one read: GetTeams 1 + GetMe 1 (+ the API-key exchange 1 for an API key) + pages per scope, summed over personal and each team, so 1 + 1 + pages x (1 + teams) when every scope has the same page count. Limits: teams at most 100 after de-duplication, otherwise an error before any page; pages per scope at most 1000 until Cursor reports a count, then at most 2 x ceil(count / 1000) + 1 (:276); at most 2 scopes at once and 6 page requests in flight across them (:261, :478); each request has a 10 s deadline (membership :247, page :338, the page deadline starts once it holds a slot, :342); the whole read has 60 s (:493).
- Timeouts and abort: "times out and aborts a membership or team request that never answers" (a hanging GetTeams, and a hanging team page: after 10 s the read fails and every hanging request's AbortSignal fired, 0 left open). The existing "ends like a page-by-page read when a page fails, leaving no request open" covers read-ahead pages.
- No leaks: "keeps the token and response bodies out of spans, logs and errors" runs a successful team read and six failing reads under a recording tracer and logger: a 401 with the token and a marker in the body, an error envelope holding both, a malformed count, a GetTeams answer holding both whose message key stops the read at the error-envelope check before the decoder, a GetTeams answer { teams: [{ id: <marker> }] } with no message key so the teams decoder runs (49c834520a, review P3-3), and a 500 with the marker. No span name, attribute, event or failure cause and no returned error contains the token, its payload segment or the marker. Nothing in the read path logs, so the logger half holds by construction and only guards a future log line. The fixed-reason mapping of membership failures is extra protection: in Effect 4.0.5 a SchemaError names the path and not the value (the reviewer removed the mapping and the tests still passed).

(3) Cache v1 to v2:
- This build reads and writes only usage-cursor-account-cache-v2.json (accountCache.ts:88; CursorUsageAccounts.ts:63) and accepts only version 2 (accountCache.ts:160). A leftover v1 file is ignored and not removed: no code refers to the v1 name any more. The first scan after the upgrade reads the whole retention window again. Test: CursorUsageAccounts.test.ts "rescans past a v1 or malformed cache and leaves the v1 file for an older build": a fresh v1 file means 1 read and the v1 file is byte-identical afterwards; v1 contents under the v2 name are refused by the version check (1 read); a malformed v2 file means 1 read (CursorUsageAccounts.ts:70-77 falls back to an empty cache); a valid v2 file means 0 reads (control).
- An older build after a downgrade: it reads only usage-cursor-account-cache-v1.json (accountCache.ts:88 at 780468c0eb) and accepts only version 1 (accountCache.ts:160 at 780468c0eb). It never opens the v2 file, uses its own v1 file if one is left or rescans, and the v2 file stays for a later upgrade. Nothing in the older build reads the v2 file, so nothing there can fail on it.

(4) Live read: run once on this Mac (pen-macmini; hostname juniui-Macmini) through the new code path, with no request sent. A scratch script outside the commit called readCursorAccountUsage({ kind: "keychain" }, now - 30 days, now, CursorKeychain.accessToken) with FetchHttpClient, the same read and Keychain reader as GOAT's Usage page, wrapping the client only to count response status codes and team ids; it printed nothing else and was deleted. Result: missing true, error "Cursor account history needs a macOS Keychain CLI login on this server.", no status codes (0 requests), 0 records, 0 teams. The Keychain reader (@napi-rs/keyring, CursorKeychain.ts:48-56) got no token. `security find-generic-password -s cursor-access-token -a cursor-user` (attributes only, no -w) finds the item in /Users/junny/Library/Keychains/login.keychain-db, created 2026-09-22, and `security show-keychain-info` on that keychain answers "User interaction is not allowed": this agent session cannot unlock or approve access to the login keychain, so the token cannot be read from here. The token was never read, printed or stored. The commit waits for a person: run the Usage page's Cursor account read once on a Mac where GOAT can read the Cursor CLI login (a logged-in GUI session that allows the Keychain prompt) and record the status codes, the number of events and the number of teams.

### Fail first

On 780468c0eb with the new tests in place: accountUsage.test.ts 12 failed | 11 passed: the authorised paginated-history case and 11 of the 12 new O23 tests. The twelfth, "starts personal and team reads together without waiting for either response", passes on 780468c0eb because the parent's Keychain read went to cursor.com and the test's transform only holds requests ending in /GetFilteredUsageEvents, so nothing waited. On the new code it still proves the scopes start together: if personal and team ran one after the other, each would wait on the other and the test would hang; CursorUsageAccounts.test.ts 1 failed | 1 passed ("usage-cursor-account-cache-v1.json ...: expected +0 to equal 1", the v1 file was still read). After the change: packages/provider-cursor src/server 41 files, 380 passed.

### C4 cases

The usage result shape (UsageRecord, CursorAccountUsageReadResult) and every wire contract are unchanged, so older and newer clients see the same Usage page data. The version boundary is the cache file, covered both ways in (3). Negative cases: the api2-only pin, missing and expired tokens send nothing, the 100-team cap, a 401 leaves the stored login alone, nothing of the token or bodies in spans, logs or errors.

### Budgets

No entry changed. accountUsage.ts keeps its nonNull 2 (no new non-null assertion, 506 lines); accountUsage.test.ts 983 lines at 672400a7da (wc -l and countLines; the earlier 986 was measured before a three-line change in the same commit) and 986 at 49c834520a (no entry, under 1000); CursorUsageAccounts.test.ts 132 lines.

### Gate (part 3)

Run on pen-macmini at 672400a7da33a75a8d2d28c64006ddf6d0df2d82 (part 2's head 780468c0eb plus the O23 commit; contains the frozen integration head 5c798a3072 and origin/dev 1d41f2c97f through part 2's merges; origin/dev not merged again so O23 stays the only change on top of part 2). Node 26.12.1 first on PATH, `set -o pipefail`. No other check:changed was running when it started; another worktree started its own vitest run during it (not touched).
- `node scripts/goat-rename.ts --check`: 0 (0 lines with T3 residue).
- `vp run check:changed`: exit 1. Passed: goat-rename, unused patches, format, graphql (2), lint, agent context budget, agent surface audit (no change), knip 1/2 and 2/2, typecheck (42 packages). vp test (1308 files, 3872.5 s): 2 failed, 1302 passed, 4 skipped (20405 tests passed, 12 skipped). The two failures are the known packages/ssh cases, the same as part 2's gate, and O23 changes nothing in packages/ssh: runtimeFactsScripts.test.ts "reads a built runner in one call and parses only the lines before its end line", "expected +0 to equal 1" (goat#3363), and tunnel.client-session.test.ts "passes quoted values unchanged through the real runner and shell", "Remote host is missing node on PATH" (goat#3418).
- Focused: packages/provider-cursor src/server 41 files, 380 passed; package typecheck 0 errors; lint of the four files 0.

### Known limits (part 3)

- Every refresh makes the two membership requests (no session cache, see Left out).
- An expired Keychain or auth-file token shows "Sign in to Cursor again"; GOAT does not refresh Cursor's token.
- A 401 on GetMe or GetTeams shows the general read error, not the sign-in message (as upstream).
- An account in more than 100 teams gets an error instead of partial history.
- The v1 cache file stays in place after the upgrade, as upstream; nothing removes it. A downgrade continues from it. (Review P3-4; removing it after the first v2 save would be a GOAT difference.)
- A Cursor login revoked on Cursor's side while its token has not expired now shows "Cursor account usage could not be read." where it showed "Sign in to Cursor again": GetMe and GetTeams answer 401 before any usage page. A team that refuses a member's usage read with 403 fails the whole read, personal history included, with "Sign in to Cursor again", which signing in does not fix. Both as upstream. (Review P3-2.)

### What only the live read can prove (review)

- That DashboardService accepts the Cursor CLI login token as a bearer. A run on macOS proves the Keychain token only, not the auth-file token on Linux or Windows.
- The response shapes for this kind of token: GetMe's userId and the team ids as JSON numbers.
- Pagination and counts on real data.
- No double count: personal history does not include team events.
- That an ordinary member, not only an admin, gets 200 on their team scope.
- That a real account finishes within the 60 s read deadline.

### NOT RUN (part 3)

- check:changed at 49c834520a (test-only commit on top of the gated 672400a7da): focused only, packages/provider-cursor src/server 41 files 380 passed, package typecheck 0, lint and format clean.

- The live personal read with a working login: owed by a person with the one command under "O23 live check for a person" (this session cannot read the login keychain; see (4)).
- The team fan-out against a real Cursor team account (needs a person with one).
- Full CI for this branch; the Usage page in a real client (web, desktop, mobile) with a Cursor login: owed to the O23 pull request (goat#3632), not to #3519.


### O23 live check (coordinator text, verbatim)

O23 noted: the live read sent nothing because the lane's session cannot read the login keychain; that is the honest result and condition (4) holds: the O23 commit does not merge until a person's read has returned usage. For N9b part 3:
(1) Do not try other ways to reach the token (no keychain unlock, no reading Cursor's files, no asking a session for the password). The check is a person's.
(2) Prepare the check so that a person needs ONE command and about a minute: a small script in the branch's scratch area OUTSIDE the repository tree (or a documented invocation of the existing code through node from apps/server, not a committed file) that runs the same account read the Usage page makes through the new code path and prints only: each request's method name (GetMe, GetTeams, GetFilteredUsageEvents), its HTTP status, the number of events, the number of teams, and whether the cache file v2 was written; never the token, never an event's content, never a team's name. Put the exact command, the worktree path on pen-macmini, what the person will see (a macOS keychain prompt naming the item, which they may allow once), and how to read the output (pass = every request 200 and at least one event for an account that has usage; team pass = GetTeams returns at least one team and a per-team read answers 200) into next-N9b.md under O23, and send me those lines. The same command serves the team-account check on any Mac where the branch is checked out.
(3) Finish the gate, the records and READY for the O23 branch as "code complete, live read owed"; I have it reviewed while it waits, and it merges only after the person's result line is in the record.

Lane coordinator note: test the script yourself only as far as it can go without the token (it must report the missing login and send nothing, exactly as your run did); send the command lines with goat_origin_report as soon as they exist (before READY if the gate is still running), and READY afterwards.

### O23 review ruling (verbatim)

N9b part 3 (O23) review at 672400a7da: APPROVE WITH NITS, P3 only; the verdict covers the code. Report /Users/jun/handoff-in/chase/next-N9b-O23-review-672400a7.md. The commit still does not merge until a person's live read returns usage. For the part 3 thread, in this order:
1. O23-P3-1, FIRST and now, before the owner runs it: tighten the live check. In /Users/junny/handoff-in/chase/o23-cursor-live-read.mjs (and its text in next-N9b.md) "personal read: PASS" requires ALL of: the checkout's commit is 672400a7da or a descendant that contains it (print the commit and say which); every request line starts with api2.cursor.sh; a GetTeams line and a GetMe line are present; NO exchange_user_api_key line (if CURSOR_API_KEY or another API-key source is in play the script says "API-key path: this run does not test the Keychain login" and the verdict is NOT TESTED, not PASS); every request 200; at least one event. "team read: PASS" requires at least one team, every "team n" line 200 and a team event count above zero. Print an event count per scope (personal N, team 1 M, ...): counts only. Also print one line saying whether the read used the Keychain or an auth file. Send me the new sha256 and the changed lines at once; the command the owner was given stays the same.
2. O23-P3-3 (test, optional but small): one scenario where GetTeams returns { teams: [{ id: <secret> }] } with no message key, so the decoder is reached, asserting no span, log or error carries the value; correct the record's sentence about the malformed answer and about logs (nothing in the read path logs).
3. Record: O23-P3-2 as a Known limit in plain words (a login revoked on Cursor's side while its token has not expired now reads "Cursor account usage could not be read." where it read "Sign in to Cursor again"; a team that refuses a member's read with 403 fails the whole read with "Sign in to Cursor again"; as upstream) and a line in the live-check guide: the person notes whether they are an ordinary member or an admin of the team; O23-P3-4 (the v1 cache file stays in place, as upstream; a downgrade continues from it); O23-P3-5 (accountUsage.test.ts is 983 lines; 11 of the 12 new tests fail on 780468c0eb and "starts personal and team reads together" passes there and why it still proves something; the cursor.usage.teams span annotation at accountUsage.ts:482 is a GOAT addition); what only the live read can prove, as the reviewer lists it (the endpoint accepts the CLI login token as a bearer: a macOS run proves the Keychain token only, not the Linux or Windows auth file; response shapes; pagination on real data; no double count between personal and team history; an ordinary member's team read; a real account inside 60 s).
4. When I say so (after part 2's head is final), merge origin/chase/t3-261114-n9b2-providers into chase/t3-261114-n9b2-o23 (git merge-tree is clean against 5f857339c8; no shared files).

Review report: /Users/jun/handoff-in/chase/next-N9b-O23-review-672400a7.md (APPROVE WITH NITS at 672400a7da, P3 only; the verdict covers the code).

### O23 held out of #3519 (coordinator decision, verbatim; goat#3632)

Coordinator decision, 2026-11-17 01:35 UTC, lane N9b part 3 (O23, upstream 497aac20f7): O23 DOES NOT JOIN #3519. The owner was asked on 2026-11-16 20:48 UTC to run the live check and answered on 2026-11-17 that the coordinator decides. No login exists that an agent session can read: the Keychain on every Mac needs a person ("User interaction is not allowed" on pen-macmini); ~/.cursor/auth.json on juns-MacBook-Pro holds a JWT that expired on 2026-11-06; ~/.config/cursor/auth.json on pen-clisu-oracle was written on 2026-08-24; the cloud VMs have no Cursor login (existence, dates and the exp claim only were read; no token was printed or sent). A code review is not a runtime check, and this port changes where a credential is sent (C4), so condition (4) of the O23 authorisation stands: it merges only after "personal read: PASS". It must not hold #3519 either. Therefore:
1. chase/t3-261114-n9b2-o23 stays at 49c834520a. Item 4 of the O23 follow-ups (merge part 2's head) is CANCELLED for now: no merge into that branch until dev contains #3519.
2. After #3519 merges into dev, a thread merges origin/dev into the branch (not a rebase), adapts it to Effect 4.1, runs the gate and opens its own DRAFT pull request to dev. It leaves draft only when a person's live read with "personal read: PASS" by the tightened rules is pasted into next-N9b.md. The narrow fresh review then covers the merge and adaptation.
3. Tracking: goat#3632 (filed by the coordinator). Cite it in next-N9b.md Part 3 (with this decision verbatim), in the 10.026 card row, in next-pr-plan.md as a follow-on row, and in the #3176 L407 row, which now reads "ported in lane N9b part 3, 49c834520a, held out of #3519 until a live Cursor read passes (goat#3632); needs a live Cursor check", unticked.
4. #3519's body and the N9b record must not list O23 among what the pull request contains. Until the O23 pull request merges, dev keeps today's Cursor account history (the cursor.com dashboard with the Keychain token, no team history).
5. N9b part 2 (5f857339c8) is unaffected: item 7 after N3 as ruled.

State of the branch: chase/t3-261114-n9b2-o23 stays at 49c834520adcfd1e4992a78b1522287f6a5cf7ba; no merge into it until dev contains #3519. Tracking: https://github.com/goat-si/goat/issues/3632.

### O23 live check for a person

State: code complete, live read owed; held out of #3519 (goat#3632). The O23 commits leave draft only after a person's result line with "personal read: PASS" is below.

Script: /Users/junny/handoff-in/chase/o23-cursor-live-read.mjs on pen-macmini, outside the repository (sha256 a60dda56570619a271e2ed1b8e356005e81f5daf70f9946675b2c270757e6304, 181 lines, tightened for review P3-1; the first version was b8d495ea196a08c47468bfd7ba079784f018e6639caa38fa1c9fa57bdc34871e; full text below for other Macs). It runs the Usage page's path through the new code: CursorUsageAccounts.scan for the default Cursor instance with Keychain usage on, awaiting the refresh, with the real CursorAccountReader and CursorKeychain and a temporary state directory removed at exit. It prints only: the checkout's commit and whether it contains 672400a7da; which login was read (Keychain, auth file or API key); each request's host, method name, scope (personal, or team 1..n by order) and HTTP status; the number of requests; billed events per scope (rows with token usage, counted from each 200 page); the usage records after de-duplication; the number of teams; whether usage-cursor-account-cache-v2.json was written; the reader's fixed error text if any; and two verdicts.

The one command (unchanged), on pen-macmini, in a Terminal window of the logged-in desktop user (not over SSH and not from an agent session, which cannot show the Keychain prompt):

```sh
cd /Volumes/CLIsu/goat-worktrees/goat/chase-t3-261114-n9b-pro-2c6a8c74eb0ff019/packages/provider-cursor && git rev-parse --short HEAD && ~/.local/share/vite-plus/js_runtime/node/26.12.1/bin/node --input-type=module < /Users/junny/handoff-in/chase/o23-cursor-live-read.mjs
```

On another Mac (the team-account check): check out chase/t3-261114-n9b2-o23, run `vp i`, save the script below as o23-cursor-live-read.mjs outside the checkout, and run the same command from <checkout>/packages/provider-cursor with Node 26.12.1 (or any Node 22.18 or newer) and the script's path. Unset CURSOR_API_KEY first, or the run tests the API-key path instead.

What the person sees: a macOS Keychain dialog saying node wants to use the confidential information stored in "cursor-access-token" in the keychain (it may ask for the login password). Click Allow (once) within 30 seconds. After 30 seconds the read stops with "error: Allow Keychain access on the Mac running GOAT, then refresh."; run the command again.

Reading the output: `commit: <sha> (contains O23 672400a7da: yes)`, `login read: Keychain`, then lines such as `api2.cursor.sh GetTeams 200`, `api2.cursor.sh GetMe 200`, `api2.cursor.sh GetFilteredUsageEvents personal 200`, `api2.cursor.sh GetFilteredUsageEvents team 1 200`, then `requests:`, `events: personal N, team 1 M`, `usage records after de-duplication:`, `teams:`, `usage-cursor-account-cache-v2.json written:` and the verdicts.
- "personal read: PASS" needs all of: the commit contains 672400a7da; every request line starts with api2.cursor.sh; a GetTeams line and a GetMe line; no exchange_user_api_key line; every request 200; the v2 cache written; at least one event. "REQUESTS OK, NO EVENTS (no usage in the last 30 days)" proves the requests but not usage.
- "team read: PASS" needs the same request checks, at least one team, every "team n" line 200 and a team event count above zero. Compare each team's count with Cursor's dashboard if you can.
- "NOT TESTED (this checkout does not contain 672400a7da)" or "NOT TESTED (API-key path)", with "API-key path: this run does not test the Keychain login", means the run proves nothing for O23: an API key was in play (CURSOR_API_KEY set, an API-key login, or an exchange_user_api_key line), or the checkout is wrong.
- For the team check, the person notes whether they are an ordinary member or an admin of the team. If an ordinary member gets 403 on a team line, that goes to a follow-up issue (review P3-2).
- The output holds no token, event content, team name or team id. Paste it whole, with the command's first line (the short commit), the Mac and the member or admin note, as the person's result line below.

Tested in the lane:
- Real run here, without a usable token: "commit: 672400a7da33a75a8d2d28c64006ddf6d0df2d82 (contains O23 672400a7da: yes)", "login read: Keychain", "requests: 0", "events: personal 0", "usage records after de-duplication: 0", "teams: 0", "usage-cursor-account-cache-v2.json written: no", "error: Cursor account history needs a macOS Keychain CLI login on this server.", "personal read: FAIL", "team read: NOT CHECKED (nothing was read)"; nothing was sent.
- A harness copy with only the Keychain reader and fetch replaced by fakes (not Cursor's API): a team account gave PASS / PASS with "events: personal 1, team 1 1"; a team with no events gave personal PASS, team FAIL; a team page 403 gave FAIL / FAIL with "Sign in to Cursor again"; no team gave PASS / NOT CHECKED (no team on this account); CURSOR_API_KEY set gave "login read: API key", an exchange_user_api_key line, the API-key line and NOT TESTED / NOT TESTED; a commit not in the checkout gave NOT TESTED / NOT TESTED.

Person's result line: (owed)

```js
// O23 live check: one Cursor account read through GOAT's Usage path (CursorUsageAccounts.scan,
// the Keychain login, api2 bearer requests). Prints the commit, request method names, HTTP statuses
// and counts only: never the token, an event's content or a team's name or id.
// Run from <checkout>/packages/provider-cursor:  node --input-type=module < o23-cursor-live-read.mjs
import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@goat/contracts";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { CURSOR_ACCOUNT_CACHE_FILE_NAME } from "./src/server/accountCache.ts";
import * as CursorAccountReader from "./src/server/CursorAccountReader.ts";
import * as CursorKeychain from "./src/server/CursorKeychain.ts";
import * as CursorUsageAccounts from "./src/server/CursorUsageAccounts.ts";

const O23 = "672400a7da33a75a8d2d28c64006ddf6d0df2d82";
const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const head = git("rev-parse", "HEAD") ?? "unknown";
const containsO23 = git("merge-base", "--is-ancestor", O23, "HEAD") !== null;

const lines = [];
const teamLabels = new Map();
const events = new Map();
const scopeOf = (request) => {
  if (!request.url.endsWith("/GetFilteredUsageEvents") || request.body._tag !== "Uint8Array") return "";
  const teamId = JSON.parse(new TextDecoder().decode(request.body.body)).teamId;
  if (teamId === undefined) return "personal";
  if (!teamLabels.has(teamId)) teamLabels.set(teamId, teamLabels.size + 1);
  return `team ${teamLabels.get(teamId)}`;
};
const name = (request) => new URL(request.url).host + " " + request.url.split("/").at(-1);
// Counts billed rows per scope; the body is handed on unchanged and never printed.
const countRows = (scope, response) =>
  response.text.pipe(
    Effect.map((text) => {
      try {
        const rows = JSON.parse(text).usageEventsDisplay;
        const billed = Array.isArray(rows)
          ? rows.filter((row) => row !== null && typeof row === "object" && row.tokenUsage != null).length
          : 0;
        events.set(scope, (events.get(scope) ?? 0) + billed);
      } catch {}
      return HttpClientResponse.fromWeb(
        response.request,
        new Response(text, { status: response.status, headers: response.headers }),
      );
    }),
  );
const counting = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.make((request) => {
      const scope = scopeOf(request);
      const label = name(request) + (scope ? ` ${scope}` : "");
      return client.execute(request).pipe(
        Effect.tap((response) => Effect.sync(() => lines.push(`${label} ${response.status}`))),
        Effect.flatMap((response) =>
          scope && response.status === 200 ? countRows(scope, response) : Effect.succeed(response),
        ),
        Effect.tapError(() => Effect.sync(() => lines.push(`${label} no HTTP response`))),
      );
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

let read = null;
let source = "none (no read)";
const reader = Layer.effect(
  CursorAccountReader.CursorAccountReader,
  Effect.map(CursorAccountReader.CursorAccountReader, (real) => ({
    read: (credentialSource, ...rest) => {
      source =
        typeof credentialSource === "string"
          ? "auth file"
          : credentialSource.kind === "keychain"
            ? "Keychain"
            : "API key";
      return real.read(credentialSource, ...rest).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            read = { records: result.records.length, missing: result.missing, error: result.error };
          }),
        ),
      );
    },
  })),
).pipe(
  Layer.provide(CursorAccountReader.layer),
  Layer.provide(Layer.mergeAll(CursorKeychain.layer, counting, NodeServices.layer)),
);

const program = Effect.gen(function* () {
  const accounts = yield* CursorUsageAccounts.CursorUsageAccounts;
  const now = Date.now();
  const since = now - 30 * 24 * 60 * 60 * 1000;
  const scans = yield* accounts.scan({
    instances: [{ instanceId: ProviderInstanceId.make("cursor"), config: {}, environment: [] }],
    keychainUsageEnabled: true,
    windowStartMs: since,
    retentionCutoffMs: since,
    awaitRefresh: true,
  });
  yield* accounts.awaitPersisted;
  const host = yield* ProviderHost.ProviderHost;
  const cachePath = (yield* Path.Path).join(host.paths.stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME);
  const cacheWritten = yield* (yield* FileSystem.FileSystem).exists(cachePath);

  console.log(`commit: ${head} (contains O23 672400a7da: ${containsO23 ? "yes" : "NO"})`);
  console.log(`login read: ${source}`);
  for (const line of lines) console.log(line);
  const methods = lines.map((line) => line.split(" ")[1]);
  const apiKeyPath =
    source === "API key" ||
    methods.includes("exchange_user_api_key") ||
    Boolean(process.env.CURSOR_API_KEY?.trim());
  const allApi2 = lines.every((line) => line.startsWith("api2.cursor.sh "));
  const everyOk = lines.length > 0 && lines.every((line) => line.endsWith(" 200"));
  const membership = methods.includes("GetTeams") && methods.includes("GetMe");
  const teamScopes = [...teamLabels.values()].map((index) => `team ${index}`);
  const teamEvents = teamScopes.reduce((sum, scope) => sum + (events.get(scope) ?? 0), 0);
  const totalEvents = [...events.values()].reduce((sum, count) => sum + count, 0);
  console.log(`requests: ${lines.length}`);
  console.log(
    `events: ${["personal", ...teamScopes].map((scope) => `${scope} ${events.get(scope) ?? 0}`).join(", ")}`,
  );
  console.log(`usage records after de-duplication: ${read === null ? "no read" : read.records}`);
  console.log(`teams: ${teamLabels.size}`);
  console.log(`${CURSOR_ACCOUNT_CACHE_FILE_NAME} written: ${cacheWritten ? "yes" : "no"}`);
  if (read?.error) console.log(`error: ${read.error}`);
  if (read === null)
    console.log(`note: ${scans.map((scan) => scan.message ?? "no Cursor login found").join("; ") || "no Cursor login found"}`);
  if (apiKeyPath) console.log("API-key path: this run does not test the Keychain login");

  const notTested = !containsO23
    ? "NOT TESTED (this checkout does not contain 672400a7da)"
    : apiKeyPath
      ? "NOT TESTED (API-key path)"
      : null;
  const personal =
    notTested ??
    (!(allApi2 && membership && everyOk && cacheWritten)
      ? "FAIL"
      : totalEvents > 0
        ? "PASS"
        : "REQUESTS OK, NO EVENTS (no usage in the last 30 days)");
  const team =
    notTested ??
    (lines.length === 0
      ? "NOT CHECKED (nothing was read)"
      : teamLabels.size === 0
        ? "NOT CHECKED (no team on this account)"
        : allApi2 && membership && everyOk && teamEvents > 0
          ? "PASS"
          : "FAIL");
  console.log(`personal read: ${personal}`);
  console.log(`team read: ${team}`);
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(
      Layer.provideMerge(
        CursorUsageAccounts.layer.pipe(Layer.provide(reader)),
        Layer.provideMerge(TestProviderHost.layer(), NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
```

## Part 2 fix round 2 (5f857339c8)

Review /Users/jun/handoff-in/chase/next-N9b2-fix-review-8964efb0.md: APPROVE WITH NITS at 8964efb090 (one P2, four P3). Item 7 of the first ruling stays for after lane N3.

### Ruling (verbatim)

> Fresh narrow review of N9b part 2's fix round at 8964efb090: APPROVE WITH NITS, no P0 or P1; one P2 and four P3. Report /Users/jun/handoff-in/chase/next-N9b2-fix-review-8964efb0.md. The holdsQueue field (C4) is additive and correct and every new test fails when its change is reverted. The lane stays on chase/t3-261114-n9b2-providers under the freeze; these go in now, one commit per item, test first, focused tests only, no force push:
> 1. N9b2F-P2-1 (code, test first). Item 1 fixed Pi but not OmO, the other profile of the same provider package: OmO has no entry in the text generation default tables (packages/contracts/src/model.ts:142-165), so providerDefaultModel("omo") gives the global default "gpt-6-luna" (model.ts:134) and the server runs OmO with that slug, which Pi's text generation refuses ("must use provider/model format"), while Settings shows "OmO default". Fix as the reviewer says: when the driver has no text generation default, use the first model in the instance's status that can generate text, before the global default (Pi and OmO list "default" first). Tests: an "omo" row for a flagged saved model, for OmO flagged as a whole with no other provider, and for Pi flagged as a whole with OmO the first capable fallback; and one case that pins the web and the server to the same pick for OmO (resolveAppModelSelectionState against the server's rule), since the whole point of item 1 is that Settings shows what the server runs. Then look once at every other driver that has no entry in those tables and say what each gets.
> 2. N9b2F-P3-1 (code, test first). markStoppedRun (Orchestrator.ts:9889-9896) returns when a request item already exists, so a run whose first interrupt did not hold the queue keeps an item without the flag even after a holding thread.stop that could not interrupt it or found it already ended (:11169-11176), and the follow-up then starts right after a Stop that held the queue. Re-emit an existing request that lacks the flag as { ...request, holdsQueue: true }, the same preserve rule as :10548-10550. Test: steer, an agent's run interrupt, a holding thread.stop that goes through markStoppedRun, then the decline: held.
> 3. N9b2F-P3-2 (record). Known limit: a declined follow-up that arrives after the person resumed the queue is held again (queue.resume does not clear the run's item), and later agent and server messages queue held behind it until a second Resume.
> 4. N9b2F-P3-3 (record and issue). In item 1's differences: the server's fallback accepts any instance that is enabled, not "unavailable" and capable, where upstream 817b92f13a also requires it to be installed, signed in, not in error, enabled for the project, not usage-exhausted and a different instance; the web uses the same looser predicate (providerInstances.ts:88), so Settings and the server agree, and a fallback can land on a provider that is signed out (the call fails with that provider's error) or run on the person's other account without a log line. File a goat issue to tighten both sides together and to log the fallback once, and send me the number. Do not tighten the server alone.
> 5. N9b2F-P3-4 (record). Condition 3 under goat#3491 quotes the old cursor.md sentence; the review guide sentence (only the guide's own selection is resolved with snapshots; its fallback to the text generation model, serverSettings.ts:243-249, is not checked and generateReviewGuide is not hooked).
> Then READY with the head for these five. Item 7 of the earlier ruling stands unchanged for after lane N3 (merge the post-N3 head, adapt, every budget entry at its real length: Orchestrator.ts and packages/contracts/src/orchestrationV2.ts are exactly at their entries; with lane N7 part 2 merged first the Orchestrator.ts hunk at the top of dispatchMessage keeps both sides and the reviewer counts 13532; mobile typecheck; check:changed). One narrow fresh review then covers this round's two code items and that merge together.

### Commits (fix round 2)

| Item | Commit | What |
| --- | --- | --- |
| 1 N9b2F-P2-1 | dcc44087b78779dd04fcfc5106a0f96901c0fb18 | textGenerationDefaultModel (packages/shared/src/serverSettings.ts:154) picks the fallback model for both the web and the server; OmO runs "default" |
| 2 (budget) | 5051f76b67d96fbdd9d37782042a5214ba201c63 | verbatim move-out of WORKSPACE_PREPARATION_INPUT and withoutPreparationResult to preparationItem.ts |
| 2 N9b2F-P3-1 | 87c97d8e54728f083942dbdf8f8438fc721b4087 | markStoppedRun re-emits an earlier unflagged request with holdsQueue |
| budget | 5f857339c800fcd3936bfbbd77b22ab4ef6d4ae8 | Orchestrator.ts entry 13541 -> 13537 (its real length) |
| 3, 4, 5 | records; goat#3608 | known limit, item 1 difference and issue, corrections in place |

Plain fast-forward push 8964efb090..5f857339c8.

### Item 1: OmO

- Rule: textGenerationDefaultModel(snapshot) returns the driver's text generation default (DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER). Otherwise it takes the status's capable model marked isDefault, else its first capable model, then DEFAULT_MODEL_BY_PROVIDER, then DEFAULT_TEXT_GENERATION_MODEL. The server uses it for the selected instance (a flagged model, or no other provider) and for the fallback instance. It replaces fallbackTextGenerationModelSelection's model choice, so a custom thread-default model on the fallback instance is no longer used there, which is what the web picker does. Pi and OmO prepend an unflagged "default" entry (provider-pi status.ts:86-110; only discovered models are flagged, :265-271), so even a wholly flagged listing still picks "default".
- Tests (TextGeneration.test.ts "runs OmO's own default for %s"): a flagged OmO model, OmO flagged as a whole with no other provider, and Pi flagged as a whole with OmO the first capable fallback all run {omo, "default"}. Web (modelSelection.textGeneration.test.ts): for a flagged OmO model, resolveAppModelSelectionState returns textGenerationDefaultModel(omo) and "default". Fail first: server 3 failed | 8 passed ("model": "gpt-6-luna"); web "textGenerationDefaultModel is not a function". After: 64 passed across TextGeneration, the installation gate, web modelSelection.textGeneration, and the shared serverSettings, serverSettingsTextGeneration and textGeneratorFallback tests. Typecheck shared, server and web: 0.
- Drivers with no text generation default table entry, and what each gets now:
  - grok: its current model (status marks it isDefault, provider-grok status.ts:202-285).
  - muse: its catalog default (isDefault, provider-muse modelCatalog.ts:74).
  - pi and omo: "default".
  - fx: the model its status marks isDefault (provider-fx status.ts:62).
  - acpRegistry: "default" or the agent's current model (isDefault, provider-acp-registry driver.ts:134-145).
  - claudeCloud, cursorCloud and devinCloud: their first capable model, else the global default. These, fx and acpRegistry are never fallback targets (not in TEXT_GENERATION_FALLBACK_DRIVERS). claudeCloud's status sets supportsTextGeneration: false (ClaudeCloudDriver.ts:119), so a saved selection there moves to another provider.
  - The web picker makes the same pick through its options (default option, else the first).
- Item 1 difference (N9b2F-P3-3): the server's fallback accepts any instance that is enabled, not "unavailable" and capable. Upstream 817b92f13a also requires the fallback to be installed, signed in, not in error, enabled for the project, not usage-exhausted and a different instance. The web uses the same looser predicate (apps/web/src/providerInstances.ts:88), so Settings and the server agree. A fallback can still land on a provider that is signed out (the call then fails with that provider's error), or run on the person's other account without a log line. goat#3608 tracks tightening both sides together and logging the fallback once. The server is not tightened alone.

### Item 2: Stop marker

markStoppedRun reads the run's request through runInterruptRequest (formerly runInterruptReason: pending events first, then the committed item; it now returns the item, and its other caller reads .message). A request that already holds returns as before. A request without the flag is re-emitted as { ...request, holdsQueue: true, updatedAt }, keeping its id, ordinal and message. No request at all gets a new item with the flag. New test row "agent interrupt, the run ends, then an agent thread.stop before decline": held. Fail first: 1 failed | 12 passed, "expected false to equal true". After: SteeringDeclined, ThreadStop, ThreadManagementService, RestartContinuation, delegatedForceStop, SteeringCompletion.stoppedQueue and CloudIngress, 7 files, 217 passed. The row "stop, then the run ends before decline" now spells the run's end as a step in its interrupt list, with the same assertions. Typecheck server: 0.

### Budgets (fix round 2)

Orchestrator.ts 13541 -> 13537. The move-out freed 7 lines and the fix used 3. Its entry is lowered to 13537. With lane N7 part 2 merged first, the reviewer's count of 13532 becomes 13528. packages/contracts/src/orchestrationV2.ts is unchanged at 4478 = entry. packages/shared/src/serverSettings.ts 905 -> 920 and TextGeneration.test.ts 468 -> 497, SteeringDeclined.integration.test.ts 399 -> 402 stay under 1000; preparationItem.ts is new (10 lines).

### Known limits (fix round 2)

- N9b2F-P3-2: a declined follow-up that arrives after the person resumed the queue is held again, because queue.resume does not clear the run's request item. Later agent and server messages then queue held behind it until a second Resume.
- Fallback predicate: see goat#3608.

### NOT RUN (fix round 2)

check:changed and the gate (item 7, after N3, now with mobile typecheck and the tests that read run_interrupt_request: apps/mobile threadActivityIcons.test.ts and client-runtime threadExecution, threadHistoryMerge and threads-sync tests); full CI; real-client passes; live Pi and OmO; live Cursor.

## Part 2 item 7: merge of the post-N3 integration head (19a0127f5b)

### Coordinator texts (verbatim)

#### Decision, 04:25 UTC

> Coordinator decision, 2026-11-17 04:25 UTC, lane N9b part 2, ITEM 7: GO. Lane N3 is merged; the integration head is 24aa0d5f70a7080483897996a13eabf62af0dbc6 (chase/t3-261114-next; Effect 4.1.3, dev through 229ae283d3). N9b part 2 stands at 5f857339c8 (fix round 2 READY). O23 stays out of #3519 (goat#3632) and is not touched. Now, on chase/t3-261114-n9b2-providers, in the fix-round worktree on pen-macmini:
> 1. Merge origin/chase/t3-261114-next at 24aa0d5f70 (a merge, not a rebase). The trial merges conflict only in oxlint-plugin-goat/code-budgets.json: every entry at the merged file's real length by countLines; Orchestrator.ts and contracts orchestrationV2.ts (4478, at its entry) need a verbatim move-out first if the merge or the adaptation adds a line.
> 2. Adapt to Effect 4.1.3 until typecheck is 0 in server, shared, contracts, web and mobile. Known points from the N3 reviews: NodeServices-only provisions at AcpMockRuntime.testkit.ts:51 and in packages/provider-pi status.test.ts (NodeCrypto); command.args.includes in status.test.ts:203-217 (args may now be Redacted); Effect.ignore at SteeringDeclined.integration.test.ts:272 and :319 with forkScoped at :138 and :374; catchIf, orElseSucceed and forkScoped in packages/provider-pi status.ts:231-241 (the scoped second probe: does it still start, and is it still interrupted with the check); forkChild followed by TestClock.adjust in status.test.ts:375-377; Effect.orElseSucceed in TextGeneration.ts and the registry reads in textGenerationCapability.ts. Any test whose harness must change beyond an import or a provide line is a rule 3 request to me with the exact before and after; no expectation changes. Apply lane N3's audits to the lane's own production code: forks into a closed scope (startImmediately, uninterruptible), typed recoveries over a mixed cause, crypto, and the capture, yield on a database read, object-identity comparison shape. For goat#3491's hold: the steer follow-up reads stopReachedRun and the interrupt request item across yields: say whether any of it compares identity or assumes no turn between the read and the write under the per-thread dispatch lock.
> 3. Checks (item 7 as extended): goat-rename --check; format; lint; typecheck server, shared, contracts, web, MOBILE; the lane's focused suites (provider-pi status and prompt ACK files, provider-cursor, provider-acp, SteeringDeclined and the steering suites, TextGeneration and the installation gate, the contract tests, web modelSelection and SettingsPanels files, mobile threadActivityIcons, client-runtime threadExecution, threadHistoryMerge and threads-sync); then check:changed against 24aa0d5f70 on pen-macmini. Known failures cited by issue (goat#3363, goat#3418, goat#3416).
> 4. Plain push; records; READY with the head. N7 part 2 merges into the integration branch BEFORE you: when I send you the head that contains it, merge the integration branch once more (both lanes edit the top of dispatchMessage in Orchestrator.ts: keep both sides; the reviewer computed 13528 lines for the combined file after your round 2: the entry is the real length), rerun the focused orchestration files and typecheck, push, and say so. Then ONE narrow fresh review covers your round 2's two code items, the adaptation and both merges.

#### Budget rule and the moved integration head, 04:45 UTC

> Coordinator answer, 2026-11-17 04:45 UTC, the budget rule after a merge of the integration head (lane N7 part 2 asked; it applies to N9b part 2 as well): THE CHILD'S READING IS RIGHT, no move-out is needed for the four entries, and my 04:25 sentence was badly worded. The rule, stated exactly, the same as the dev-merge rule of 02:58 UTC: after merging the integration head, an entry is the merged file's real length by countLines when (1) every line the merged file has beyond the integration side is the lane's own line as it stood at the lane's reviewed head (the merged file is byte-identical to the lane head's file, or it is git's automatic merge of the two sides), and (2) the entry is at or below dev's entry. A verbatim move-out FIRST is required only when lines written NOW (an adaptation to Effect 4.1, a hand resolution) would land in a file that is at its entry, or when the entry would pass dev's. I checked the four here: ProjectionStore.ts 8823 (integration 8744, dev 8836), ThreadManagementService.ts 2196 (2195, 2201), ScheduledTasksSettings.tsx 1747 (1737, 1750), the mobile SettingsScheduledTasksRouteScreen.tsx 1181 (1178, 1202): each is the lane head's reviewed entry and below dev's. Quote this paragraph in the record beside the entries; the narrow review verifies both conditions per file.
> ALSO, the integration head has moved once more, by three small commits: chase/t3-261114-next = f848a4dcd2ecb457d7cb15d801771709c6afd094 (fast-forward from 24aa0d5f70, verified on origin): lane N3's test-only follow-up (653864850b a verbatim testkit move, 823ffe7d2f one added row and a reworded comment in ProviderSessionManager.test.ts, entry 5906 to 5903) and a docs note (f848a4dcd2, docs/internals/effect-services.md "Reads under the database connection lock"). N7 part 2 and N9b part 2: merge origin/chase/t3-261114-next at f848a4dcd2 before your push (N7: once more on top of your local 76a43a3eec; it touches only that test file, a new testkit, the docs page and one budget line), say that the result is git's own merge, and run check:changed against f848a4dcd2. Read that docs section: it names the shape to look for in your own production code.

### Commits

| Commit | What |
| --- | --- |
| a87d9d0c117a2fc3bc6b05381a4b5c2e73c29e16 | refactor(contracts): verbatim move of isOlderSettledThreadShell to orchestrationV2OlderSettled.ts, re-exported from orchestrationV2.ts (the now-unused DateTime import goes) |
| 1b6bddb80b672024a41fdefb06e899af5a752afc | merge of origin/chase/t3-261114-next at 24aa0d5f70 (conflict only in code-budgets.json) |
| 19a0127f5b0c45d571e3331d741351a19caa5caa | merge of origin/chase/t3-261114-next at f848a4dcd2, git's own merge (no conflict) |

Plain fast-forward push 5f857339c8..19a0127f5b. The head contains f848a4dcd2.

### Budgets after the merges (the 04:45 rule)

| File | Head entry = real (countLines) | Integration entry | Dev entry | Merged file |
| --- | --- | --- | --- | --- |
| apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts | 8452 | 8629 | 8987 | git's automatic merge; beyond the integration side only the lane's reviewed lines |
| apps/web/src/components/settings/SettingsPanels.tsx | 1574 | 1573 | 1713 | git's automatic merge: integration's file plus the lane's one reviewed L408 line |
| apps/server/src/orchestration-v2/Orchestrator.ts | 13537 | 13555 | 13908 | git's automatic merge; the lane's round 2 entry |
| packages/contracts/src/orchestrationV2.ts | 4463 | 4476 | 4478 | git's automatic merge after the move-out a87d9d0c11 |

Only code-budgets.json was resolved by hand. The integration branch had lowered the contracts entry to 4476, while the lane's holdsQueue field makes the lane's file 4478. Following the 04:25 wording, I opened with the verbatim move-out a87d9d0c11 before the 04:45 answer arrived. Under the 04:45 rule it was not required: the two extra lines are the lane's own reviewed lines, and 4478 is dev's entry. It only lowers the file (4478 -> 4463) and changes no behaviour. contracts typecheck 0; orchestrationV2ThreadFields and client-runtime olderSettledThreads tests 19 passed. Every other entry in code-budgets.json equals its file's real length (scripted countLines check over every lines entry: 0 differences).

### Effect 4.1.3 adaptation

No code change was needed. After `vp i` (effect 4.1.3 installed), typecheck is 0 in packages/contracts, packages/shared, apps/server, apps/web, apps/mobile, packages/provider-pi, packages/provider-cursor, packages/provider-acp and packages/client-runtime. No harness or expectation changed, so there is no rule 3 request. The listed points:
- AcpMockRuntime.testkit.ts:51 and provider-pi status.test.ts provide NodeServices.layer only. The bundle build and the status probes need no Crypto service: ACP files 919 tests with provider-pi, provider-cursor and provider-acp, all passing (below).
- status.test.ts:203-217: ChildProcess args are now `string | Redacted<string>` (effect process/CommandLine.ts:60). The probe flags are plain strings, so includes finds them; a Redacted value never equals a flag. The tests' exact matrices (["version","rpc","rpc","auth"], and exactly one rpc probe carrying both flags) pass.
- Effect.ignore (SteeringDeclined :272, :319) and Effect.orElseSucceed (TextGeneration.ts, provider-pi status.ts): same failure-only semantics in 4.1.3; 4.1.3 adds only an "Unhandled" log option to ignore.
- forkScoped (SteeringDeclined :138, :374; provider-pi status.ts:241) and forkChild (status.test.ts:375-377): fork options and defaults are unchanged between 4.0.5 and 4.1.3 (startImmediately optional, default off; internal/effect.ts forkUnsafe). The scoped text generation listing still starts when the check's fiber yields and is interrupted with the check's scope. If that scope closes first, an unstarted listing is never spawned, as before. The status test that forks the check and adjusts the TestClock passes.
- catchIf (status.ts:231-236) recovers only PiRpcError read and exit failures; orElseSucceed only typed failures. Defects pass through, so there is no recovery over a mixed cause.
- textGenerationCapability.ts registry and snapshot reads are in-memory and have no error channel. TextGeneration.ts's capable() recovers only getSettings's typed failure.
- Crypto: the lane's production code uses none.
- "Reads under the database connection lock" (docs/internals/effect-services.md): the lane's production code has no capture, yield on a read, then identity comparison shape. TextGeneration.ts's one identity check (modelSelection === input.modelSelection) asks whether the resolver returned its own input. No read is compared, and a fresh object at worst copies an equal selection.
- goat#3491 hold: stopReachedRun, runInterruptRequest and markStoppedRun compare fields (item.type, holdsQueue === true), never identity. The read and the write run inside one command under the per-thread dispatch lock. Another fiber may run during the database read's scheduler turn, but no command for the same thread can commit between them. markStoppedRun also checks the command's own pending events first.

### Checks (pen-macmini, Node 26.12.1, after the merges)

- node scripts/goat-rename.ts --check: 0 (0 lines with T3 residue).
- Typecheck as above: all 0.
- Focused suites, all passing:
  - provider-pi, provider-cursor and provider-acp src plus AcpAdapterV2 (+Compaction, Form, Updates), AcpClosedSessionStop, AcpPermissionGrants and AcpPromptInactivity: 88 files, 919 passed, 1 skipped (omo.live).
  - The steering suites, SteeringDeclined, ThreadStop, ThreadManagementService, RestartContinuation, delegatedForceStop and CloudIngress, TextGeneration and the installation gate, the contracts tests (interruptRequest, server, orchestrationV2ThreadFields), the shared serverSettings tests, client-runtime threadExecution, threadHistoryMerge, threads-sync and olderSettledThreads, web modelSelection (3 files) and SettingsPanels.logic: 27 files, 531 passed.
  - Mobile threadActivityIcons: 4 passed.
  - Web browser SettingsPanels.restore and SourceControlWritingSettings: 5 passed.
- `vp run check:changed f848a4dcd2` (34 files since f848a4dcd2ec), GATE_EXIT 1:
  - Passed: goat-rename, format, graphql, lint, agent context budget, agent surface audit (no change to docs/internals/agent-surface-audit.md), knip 1/2 and 2/2, typecheck (39 packages).
  - vp test (371 files): 1 failed | 369 passed | 1 skipped (16 failed | 6968 passed | 1 skipped tests). The one failing file is apps/server/src/textGeneration/GrokTextGeneration.test.ts, "exec: node: not found" from its fake grok launcher. That is the known goat#3425 (node only on an nvm PATH on this Mac). It fails identically on the integration head f848a4dcd2 alone (detached checkout, one case, same error) and the lane does not touch provider-grok, provider-acp or that test.
  - An earlier run against 24aa0d5f70 was stopped by me (its own session) when the integration head moved; it does not count.

### Still to come

N7 part 2 merges into the integration branch first. When the coordinator sends that head: merge it once more (keep both sides at the top of dispatchMessage; the entry is the real length, about 13528), rerun the focused orchestration files and typecheck, push, and report.

### NOT RUN (item 7)

Full CI; real-client passes (#3519); live Pi, OmO and Cursor; the merge of the head that contains N7 part 2.

### The palette test fix merged; the integration head is ab59bbdacc

> Coordinator, 2026-11-17 05:30 UTC: the palette test fix is read and MERGED. chase/t3-261114-next = ab59bbdacc95f4e12ab05bde02cfaa3e2fdb7ad4 (fast-forward from f848a4dcd2, verified on origin): one commit, one line in apps/web/src/components/CommandPalette.browser.test.tsx (the one-shot query becomes await expect.element(row).not.toBeInTheDocument()). All four conditions of the authorisation are met in the commit message: nothing else in the case changes; with flushSync(close) removed on a scratch copy the case fails ("expected document not to contain element ... Matcher did not succeed in time"); the mechanism is named (Base UI keeps the closed popup mounted and unmounts it in a later commit of its own after the popup's animations finish: @base-ui/react 1.9.0 internals/useUnmountAfterClose.js:88 and useAnimationsFinished.js:88 and :72; a person sees the designed 200 ms dialog exit while the drag ghost follows the pointer); and under CI-like load (24 copies on 8 workers, 20 runs each) the old assertion failed in 11 of 20 runs with CI's exact message and the new one passed 20 of 20.
> For N3d (mcp:639f307d): the goat#3416 comment (the commit, the mechanism, the counts, "fixed in #3519; the issue closes when #3519 merges into dev"), then the records line (the authorisation verbatim, the commit, the merge line "merged into the integration branch at ab59bbdacc (#3519)") and you are done.
> For N7 part 2 (mcp:ae0dbf69) and N9b part 2 (mcp:76435a27): the integration head is now ab59bbdacc; the only change since f848a4dcd2 is that one line in a web test neither lane touches. N7 part 2: when check:changed against f848a4dcd2 has passed, merge origin/chase/t3-261114-next once more (git's own merge, say so), no second check:changed for it, push and send READY. N9b part 2: nothing now; your next merge is the integration head that contains N7 part 2, which will contain this commit too.
> Also for the record of both lanes: the pull request run on f848a4dcd2 (44018308235) failed goat-test on a different known class, a vi.mock factory that could not fetch its module (apps/web/src/components/chat/TurnThreadCards.browser.test.tsx, "Failed to fetch dynamically imported module", the class of goat#928 and goat#1719): filed as goat#3646; it is not caused by #3519.

N9b part 2 takes no action for this: 19a0127f5b is under the narrow fresh review (goat-nextN9b2-final-19a0127f), and the next merge is the integration head that contains N7 part 2.

