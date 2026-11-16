# Lane N9b, provider adapters (L11 retry 2), next PR

Lane branch `chase/t3-261114-n9b-providers`, based on origin/dev `bcb2a18ac8`. Contains the integration head `44d7d60d20` (merge `9b92d2e71f`) and origin/dev `cbe919c652` (merge `750d243cdb`). Not merged into `chase/t3-261114-next` (frozen until N3).

## Rows

| Row | Upstream | Commit(s) | State |
| --- | --- | --- | --- |
| 4e0b52806b Cursor shell commands stream while they run (owner-named, C4 patched dependency) | 4e0b52806b | 76adb119ae8bdea39ec2bc8e8884af61db09ae79 | ported |
| ACP /compact per-session map (card item, #3332 review, plan row 118) | ac7c7f66d9 follow-up | 912c1318d6a15c2ac7b05b34d3113652c4d4d083, MAX_SESSIONS unexport 7fe3d68aa5db89e1ad0bd7f60c0a2e4aeec07456 | ported |
| L383 jsonc-parser into provider-cursor (C4 new dependency) | cc97303381 | 49bcd979ee8201d0bea79e0e4236b24f7e03de7a (move-out), 8550f8ea2f9fc22213ffa6d2632ff616001ace8f | ported; needs ci:full (not dispatched by the lane) |
| L406 Pi prompt ACK tracking | f255158370 | 14edd1cc219bec2f2063190b1ec0032be2b6b5f6 (move-out), 886de17bba371fc08117d9965d4cc3a02af6b450, a868b9c9b236a646c96b29f4604369a4659e5634 | ported |
| L408 supportsTextGeneration (C4 contract) | 817b92f13a | none | not started (context) |
| O23 / L407 Cursor team usage (C4) | 497aac20f7 | none | not started; needs a live Cursor check (owner told 2026-11-16 15:25 UTC) |
| a3cde98425 remainder, ACP mock agent bundled once per file | a3cde98425 | none | not started (context) |
| goat#3491 Cursor declined steer after Stop | (2248ca8db9 gap) | none | not started (context) |

## Decisions and adaptations

- 4e0b52806b: upstream's patch file taken byte-identical; upstream's adapter.test.ts case moved to the new packages/provider-cursor/src/server/adapter.shellOutput.test.ts (adapter.test.ts at its 1891 entry; upstream extends an existing test there), plus a GOAT case for an older SDK event without toolCallId.
- /compact: `AdvertisedCommands.BySession` map, cap 8, oldest out, re-announce moves a session to newest. Names held per session are bounded by one announcement's list (each announce replaces that session's set, as upstream), so retention is at most 8 announcement lists.
- cc97303381: GOAT always sends a turn-time mcpServers set and rebuilds it on active-run recovery (prepareMessage); the workspace servers join both, GOAT's server last. Upstream's case is in packages/provider-cursor/src/server/workspaceMcpServers.test.ts with `settings` added for GOAT's adapter options.
- f255158370: upstream's adapter hunks with GOAT's `driver` for PI_PROVIDER in the moved start block. Prompt ids are `goat-prompt-N` instead of upstream's `t3-prompt-N` (goat-rename --check flags the T3 spelling), and the testkit's ADAPTER_REQUEST_ID is `/^(?:t3|goat-prompt)-\d+$/u` instead of upstream's `/^t3-(?:prompt-)?\d+$/u`; withRequestId is upstream's text. The 64-prompt bound on held plus pending prompts stays.

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
(c) What ends the hold when the ACK never comes: Stop and caller cancellation, and the session closing or the Pi process ending. The new table "settles an ACK-blocked start on $end cancellation at $boundary admission" covers all three ends at both admission points: `session` closes the runtime scope, `transport` ends Pi's stdout (the process going away), `caller` interrupts the start; session and transport rows assert the blocked start fails with a ProviderAdapterProtocolError (the adapter fails the ACK wait on session close and on transport close, and a woken start refuses a closed session) and a later start fails too; no start stays pending, and the start error reaches the user as a failed turn start. No extra case was needed.
(d) Owed to #3519's integrated pass, per surface (not checked by the lane): web, desktop and mobile should show the held turn as starting until Pi acknowledges the earlier prompt, and a failed turn start once Pi exits or the session closes.

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
- `vp run check:changed`: GATE_EXIT 1. Passed: goat-rename, unused patches, format, graphql (2), lint, agent context budget, agent surface audit (no change to docs/internals/agent-surface-audit.md), knip 1/2, typecheck (42 packages). knip 2/2 failed on `MAX_SESSIONS` (unused export), fixed in 7fe3d68aa5; `vp run knip:check:exports` then exit 0. vp test (1228 files): 2 failed, 1222 passed, 4 skipped (19620 tests passed). Both failures are packages/ssh files with no diff against origin/dev, failing because this Mac has no node in a system directory (no /usr/local/bin/node, /usr/bin/node, /opt/homebrew/bin/node): packages/ssh/src/tunnel.client-session.test.ts "passes quoted values unchanged through the real runner and shell" (goat#3418) and packages/ssh/src/runtimeFactsScripts.test.ts "reads a built runner in one call and parses only the lines before its end line" ("expected +0 to equal 1", same cause as goat#3418; reproduced alone).
- After 7fe3d68aa5: advertisedCommands.test.ts 5 passed. The full check:changed was not repeated after that one-line unexport.

## Known limits

- The Cursor shell listener is removed when run.wait ends (as upstream); a run whose wait never runs keeps one listener that only matches its own agent id.
- L383 needs a full CI run (ci:full); the lane did not dispatch it.

## NOT RUN

- L408, O23, a3cde98425 remainder, goat#3491 (not started).
- Full CI (ci:full) for L383; real-client pass; live Cursor check.
