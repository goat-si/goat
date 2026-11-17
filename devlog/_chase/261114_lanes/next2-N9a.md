# N9a Claude adapter (lane record)

Lane branch: `chase/t3-261114-next2-n9a-claude`, head `27f57b9b3d9631615b96260dc75c720fa3e28549` (verified with git ls-remote; READY first reported at bd106c6a52, then the budget entries were lowered), cut from the integration branch `chase/t3-261114-next2` at `e9e20d52bec41be15682d29ad6069242a4cc7f3f` (draft PR #3660); the integration head has not moved since, so no merge. Host pen-macbookpro2. Rows: C14 (L148 b9381c257d), C15 (L177 e77384bf00), L181 1a5d3737b7 rest, L179 d4b77d2448 (C4). Plain pushes, no force. Reviewers read C14 and L179 as C4 (coordinator 11:47:25, A.2; 11:35:21).

Placement: host.status with placement, run by the lane at 11:32 UTC: one candidate, this machine, eligible, score 55, pressure ok, load 0.2 per core, 1 thread running (this lane). The lane coordinator's run at 11:28 ranked the pen-cc cloud machines first (excluded by the plan), then macbookpro2 (18) and pen-macbookpro2 (26).

## Rows and commits

| row | GOAT commits | result |
| --- | --- | --- |
| C14 b9381c257d | `71afe0f935` fix, `26221ac634` and `5bc5728dbe` negative cases, `bd106c6a52` test typing | Claude Plan mode runs goat_background_wait without asking. GOAT decides in its permission callback (`goatMcpToolNames.ts` `claudeGoatToolDecision`) instead of upstream's Tool.Readonly, because GOAT derives readOnlyHint from the registry's effect and background.wait writes. |
| C15 e77384bf00 | `240f3f32c2` move-out, `584c43ad70` fix, `1bd7a8a2d9` test (rule 3 harness lines) | A `context: fork` skill records the model its transcript says it ran on (`ClaudeForkedSkillModel.ts`). `subagentModel` is optional in GOAT's runner shape, required upstream; the live runner satisfies `Required<ClaudeAgentSdkQueryRunnerShape>`. |
| L181 1a5d3737b7 rest | `19c1b97e04` fix, `06fc9eb4f0` tests | A long reply line streams every 50 ms (Effect clock, judged on each text delta) before it ends. |
| L179 d4b77d2448 (C4) | `ff1c02dca7` contracts move-out, `29ea1e4228` fix, `d4b9feea14` rule 3 expectations and test move, `430abf7286` web live-run filter | `PendingBackgroundTask.nativeItemId` (optional), filled by the Claude adapter with `command` and `startedAt` from the remembered tool call. Issue goat#3675 for the shared dedupe site. |
| fork delta | `655e019e76` | new area `claude-adapter` (C15 condition (ii)) |
| budgets | `27f57b9b3d` | update-code-budgets.ts lowers the three entries this lane shrank: ClaudeAdapterV2.ts 10941 to 10933, ClaudeAdapterV2.test.ts 16510 to 16500, orchestrationV2.ts 4463 to 4438; no other entry moves |

## What a person sees, and the surfaces

- C14: in Plan mode, and in read-only sandboxes under Supervised or auto-accept-edits, Claude calls goat_background_wait without an approval prompt, on web, desktop and mobile alike (the prompt was a server-side approval request). The read-only case was found by the C4 review (N9a-P3-1) and accepted as upstream has it. Surfaces: agents through MCP (Claude only; the registry, the tool listing and the agent surface counts are unchanged). No settings, no contract change.
- C15: a subagent row for a forked skill shows the model it ran on instead of none, on web, desktop and mobile (each renders the subagent's model from the same event). Surfaces: provider adapter only; no contract change.
- L181: a long Claude reply line appears while it streams instead of all at once when it ends, on web, desktop and mobile (each renders streamed assistant items). Surfaces: Claude adapter only.
- L179: web and desktop Details (BackgroundWorkDetails) show "Started <time>" and the command for a Claude command that moved to the background or that a roster lists after its task_started; on a thread with an earlier finished run, a command the live Claude turn sent to the background no longer shows in the web background banner during the turn (it did, unlike Codex and Muse). Mobile: no visible change (its background sheet shows no start time, and the server's pending list is empty while a run is live, packages/shared/src/orchestrationV2PendingBackgroundWork.ts:262). Surfaces: contract (one optional wire field); agents: none, threadListView.ts:202 copies named fields only, agent-surface:check and agent-surface:context-budget-check exit 0 unchanged; no settings.

## Real Claude turns

None. NOT RUN: a real-client capture of any row. The Replay (dev) provider is an ACP registry agent (`driver: acpRegistry`, apps/server/src/provider/ProviderInstanceRegistryHydration.ts:153-156): its turns go through the ACP adapter and never reach ClaudeAdapterV2, so no Replay fixture can show a Claude roster entry, a forked skill or Claude's streaming. Each row is proven by the adapter's own replay harness instead. The web capture of L179 (coordinator 11:35:21, condition 3) JOINS P1's PASS for that reason; it needs a Claude turn whose Bash command moves to the background (Claude moves a command after its own foreground timeout or on Ctrl-B), which Replay cannot produce.

## C14 b9381c257d

Fix: `if (target === CLAUDE_BACKGROUND_WAIT) return "allow";` after the memory checks in `claudeGoatToolDecision` (apps/server/src/orchestration-v2/Adapters/goatMcpToolNames.ts). In Plan mode Claude routes every MCP write to GOAT's callback (ClaudeAdapterV2.ts `permissionMode === "plan"` sets `installPermissionCallback: true`), which asked a person.

Fail-first (goatMcpToolNames.test.ts, "runs goat_background_wait without asking, directly or through goat_call, in any sandbox"): `AssertionError: true: expected 'ask' to be 'allow'`. After: 7/7.

What the callback inspects: the PATH only. `goatCallTarget` resolves path, name or tool; names that disagree resolve to no target, which asks. The args are decoded by the server against the wait's own schema `{taskIds, waiting}`. Waiting needs no approval because it reads nothing new and changes only the awaited flag on the caller's own tasks.

Negative cases, as tests:
- every other registry tool still asks in Plan mode, directly and through goat_call, with every memory grant on (goatMcpToolNames.test.ts, "still asks in Plan mode before every other GOAT tool, directly or through goat_call");
- a goat_call is waved through only when every name it carries is the background wait: `{path: "background.wait", name: "thread.send"}` and `{path: "background.wait", tool: "goat_task_create"}` ask (same file);
- an outside client never reaches the wait: it is declared `actsAsCaller` (toolkits/orchestrator/handlers.ts:132), so `requireThreadCaller` refuses read-only, approval-required and full-access clients with `thread_credential_required`, before McpToolAccess.ts:110 (McpToolAccess.test.ts, "refuses a tool that acts as its calling thread to an outside client");
- a wait writes only on its own thread's roster: in default and Plan mode, a wait whose provider thread does not hold the task, or naming a task no roster holds, matches nothing and leaves the task unmarked, with a positive control showing the check sees a mark (ClaudeBackgroundDetails.test.ts, "a %s-mode wait sets nothing on a task its thread's roster does not hold"). The adapter matches only the caller's native thread roster (ClaudeAdapterV2.ts `awaitBackgroundTasks`, under `sdkMessageLock`); the handler passes the caller's own thread (handlers.ts:137); the service refuses a wait that matched nothing (ThreadManagementService.ts:2023, `reason: "unmatched"`).

## C15 e77384bf00

Move-out `240f3f32c2`: `claudeMcpProxyBypassEnvironment` to the new `claudeMcpProxyBypass.ts` (still exported from ClaudeAdapterV2.ts) and `appendClaudeUserText` to `ClaudeUserMessage.ts`. Verbatim EXCEPT the proxy comment, cut from 6 lines to 4 because goat/no-low-value-comments is an error in a new file. Before:

    // Claude Code sends HTTP MCP traffic through any configured HTTPS_PROXY, including
    // one set in the user's Claude settings.json, and it does so even for loopback URLs.
    // Proxies cannot reach this server's local endpoint (an intercepting CONNECT proxy
    // answers 405), so the goat server would silently fail to attach. Exempting the
    // endpoint host keeps the user's proxy for everything else. A NO_PROXY set in
    // Claude's own settings env still wins over the process environment.

After:

    // Claude Code sends HTTP MCP traffic, even to loopback, through any HTTPS_PROXY (also one in
    // Claude's settings.json); a proxy cannot reach this server (CONNECT answers 405), so the goat
    // server would silently fail to attach. Exempting the endpoint host keeps the proxy for the
    // rest; a NO_PROXY in Claude's own settings env still wins over the process environment.

ClaudeAdapterV2.ts goes from 10941 to 10910, and ends the lane at 10933 (entry 10941, not raised).

Fix `584c43ad70`: at turn end the adapter asks the runner for each finished fork's transcript model (`ClaudeForkedSkillModel.ts` `claudeForkedSkillModels`, `lastClaudeTranscriptModel`; the runner's `subagentModel` reads `getSubagentMessages`). Condition (i): the live runner is built `satisfies Required<ClaudeAgentSdkQueryRunnerShape>`; with `subagentModel` removed from it, the server typecheck fails:

    src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts(980,7): error TS2741: Property 'subagentModel' is missing in type '{ allocateSessionId: Effect.Effect<string, ClaudeAgentSdkQueryRunnerError, never>; open: (input: ClaudeAgentSdkQueryOpenInput) => ...; forkSession: ...; subagentLaunchToolUseId: ...; assertComplete: Effect.Effect<...>; }' but required in type 'Required<ClaudeAgentSdkQueryRunnerShape>'.

The shape's doc says "Optional only for test fakes." Condition (ii): fork delta area `claude-adapter` (`655e019e76`) names the difference, so an upstream test that passes `subagentModel` to a fake applies as is.

Test `1bd7a8a2d9` (ClaudeForkedSkillModel.test.ts): present, the model is `claude-haiku-4-5`; absent, it stays null. Fail-first for "present": `AssertionError: expected null to equal 'claude-haiku-4-5'`. After: 2/2. Rule 3 (authorised 11:47:25, A.1): ClaudeWakeHarness.testkit.ts:37 adds `readonly subagentModel?: string;` and :170 adds `subagentModel: () => Effect.succeed(options?.subagentModel ?? null),`; no expectation changes.

## L181 1a5d3737b7, the rest

GOAT ported the line updates as 72afd34617 and the steer cut-off as c7618f6c10. The rest was upstream's timed updates inside a line. GOAT's projector (`ClaudeAssistantText.ts`) now takes the Effect clock's `currentTimeMillis` on each stream event (one line in ClaudeAdapterV2.ts) and publishes a still-streaming line once 50 ms have passed since its block last published; a line break still publishes at once. No timer fiber: the update stays in the serialized SDK message loop, and ClaudeEventQueue still coalesces partial updates.

Tests (ClaudeStreamedLine.test.ts, it.effect with TestClock.adjust only):
- "streams a long line every 50 ms before it ends": nothing at 49 ms; at 50 ms the partial text, streaming; the completed reply at the end. Fail-first: `expected [] to deeply equal [ [ 'A long line keeps going without a break', true ] ]` (Received `[]`).
- "publishes a line that ends within 50 ms once, complete": `[["Short reply.", false]]` only.
- "keeps the text that arrived after the last partial publish when the block ends": `[["Part one two", true], ["Part one two three", false]]`.
After: 3/3, and ClaudeAssistantText.test.ts unchanged and passing.

## L179 d4b77d2448 (C4)

The plan (parts 1 and 2, reports 11:32) and the coordinator's answer (11:35:21, Option A) are below. Contract move-out `ff1c02dca7`: `OrchestrationV2StopHeldTurnInput`, `OrchestrationV2StopHeldTurnResult` and `OrchestrationV2StopHeldTurnError` move unchanged to `orchestrationV2HeldTurn.ts`, re-exported from orchestrationV2.ts; orchestrationV2.ts goes from 4463 to 4436 and ends at 4438.

Fix `29ea1e4228`:
- contract: `nativeItemId: Schema.optional(TrimmedNonEmptyString)` in `PendingBackgroundTaskFields`;
- adapter: `makeClaudeTaskLaunches()` (ClaudeBackgroundTasks.ts) remembers each `task_started`'s tool call with its command and start time, foreground ones too, at most 64 with the oldest dropped first, and forgets it on `task_notification`. A `task_started` (backgrounded) and a roster entry spread the remembered launch; a task already on the roster keeps the fields through `mergeClaudeBackgroundTasks` after the memory drops it. `startedAt` is the tool call's start time.

Where the memory lives (condition 2): created once per openSession at ClaudeAdapterV2.ts:3240 (my rule 3 report said :3244, before the final edits), beside `lastKnownOpaqueTasks`, so it ends with the session. It is not reset when a session's process is replaced (accepted, condition (b)): task ids are Claude's and not reused, a roster entry with no remembered launch reads as today, and the bound of 64 holds across replacements, so a session that replaces its process many times cannot grow it.

Tests, each failing first:
- contract (packages/contracts/src/orchestrationV2.pendingBackgroundTask.test.ts): with the field; without it; a blank id refused; an older reader drops it. Fail-first: 2 of 4 failed (`expected { taskId: 'b1', kind: 'command' } to deeply equal { taskId: 'b1', kind: 'command', …(1) }`; `expected [Function] to throw an error`).
- stored row (apps/server/src/orchestration-v2/ProjectionStore.pendingBackgroundTask.test.ts): a provider-thread.updated payload written through the store with the field reads back with it; one without reads as before. Fail-first: `"nativeItemId": "toolu_new"` missing from the stored task.
- adapter (ClaudeBackgroundDetails.test.ts): "keeps the tool call, command and call time of a command that moves to the background" (the clock moves 5 s after the call and 5 s after task_started; `startedAt` equals the call's time) and "names no tool call it was not given, has forgotten, or evicted for a newer one" (no tool_use_id, a blank one, forgotten after the notification, the oldest evicted, a live roster task keeps its id). Fail-first: `expected { taskId: 'task-moved', …(2) } to deeply equal { taskId: 'task-moved', …(5) }` and `expected undefined to equal 'toolu_fg_63'`.

Rule 3 (authorised 11:55:36): each old expectation was right and gains the one new key, as upstream extends the same three.

- ClaudeAdapterV2.test.ts:6999 ("keeps a running Claude monitor typed after many newer monitors end"). Before: `{ taskId: longRunning.taskId, kind: "monitor", description: "Monitor 0" }`. After: the same plus `nativeItemId: "toolu_monitor_0"`.
- ClaudeAdapterV2.test.ts:7636 ("clears the replaced sibling native thread roster when openQuery switches processes"). Before: `{ taskId: taskA, description: "work on A", kind: "command" }`. After: the same plus `nativeItemId: "toolu-roster-a"`.
- testkit/fixtures/claude_background_monitor_wake/output.ts:42 adds `nativeItemId: "toolu_019b4EUbhEcYP4TS7vZn27N1"` to the deepEqual at :39. That is the recorded transcript's own Monitor tool_use id, claude_transcript.ndjson line 61.
- Test move (budget): "preapproves the six granted reads and never any memory write on read-only policy", formerly ClaudeAdapterV2.test.ts:16366-16385 in describe "Claude WP4 memory delivery", moves into ClaudeAdapterV2.allowedTools.test.ts with one type import (`McpProviderSession`). Its old describe block has no beforeEach, afterEach or shared layer; the block's other variables are local to the neighbouring test, and this test is a synchronous call. Body check, prints BODY-IDENTICAL:

    diff <(git show 29ea1e4228:apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts | sed -n '16366,16385p' | sed 's/^  //') <(git show d4b9feea14:apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.allowedTools.test.ts | sed -n '/^it("preapproves the six granted reads/,/^});/p') && echo BODY-IDENTICAL

  (29ea1e4228 is the last commit with the test in its old place; d4b9feea14 moves it.) ClaudeAdapterV2.test.ts ends at 16500 (entry 16510, not raised).
- Not ported (accepted, condition (c)): upstream's extension of the incremental roster fallback test (GOAT :6673-6747). It passes unchanged in GOAT, and ClaudeBackgroundDetails.test.ts pins the moved command and the tool call's time.

Condition 4, the client sites:
- apps/web/src/components/chat/threadPendingBackgroundTasks.ts:40 changes (`430abf7286`). Failing test first (threadPendingBackgroundTasks.test.ts, "does not list a command the live Claude run sent to the background as background"): `expected [ { taskId: 'b9x2k', …(2) } ] to deeply equal []`. A person saw it: on a thread with an earlier finished run, the web background banner listed the live Claude turn's own backgrounded command during the turn. Codex and Muse entries were already filtered by task id. Fix: `!foregroundTaskIds.has(task.nativeItemId ?? task.taskId)`. After: 7/7.
- packages/shared/src/orchestrationV2PendingBackgroundWork.ts:281/:297 are unchanged. No test can show a wrong result: Claude answers a backgrounded call at once ("Command running in background with ID: …", claude_background_task_wake/claude_transcript.ndjson lines 75-76), so the launch item is already completed and the merge never sees it as active. Filed as goat#3675.

C4 both ways: an older client or server drops the key (an Effect Struct ignores unknown keys on decode, checked; nothing decodes this type with `onExcessProperty: "error"`); stored threads without it read as before (stored-row test); the unknown-kind fallback (orchestrationV2.ts `kindUnionWithFallback`) drops it.

## Checks on bd106c6a52

- `vp run check:changed origin/chase/t3-261114-next2`: exit 0. format, lint, knip 1/2 and 2/2, graphql, agent surface audit, agent context budget and typecheck (42 packages) pass; test 73 files, 2833 passed. The first run, on 655e019e76, failed typecheck on two of this lane's new tests (ClaudeBackgroundDetails.test.ts:337, goatMcpToolNames.test.ts:78); bd106c6a52 types them, with no assertion changes.
- `node scripts/goat-rename.ts --check`: exit 0, "0 lines with T3 residue in 0 files, 0 dropped paths".
- Focused files of every row, one run: 14 files, 501 passed (goatMcpToolNames, ClaudeAdapterV2.allowedTools, McpToolAccess, ClaudeForkedSkillModel, ClaudeStreamedLine, ClaudeAssistantText, orchestrationV2.pendingBackgroundTask, orchestrationV2, ProjectionStore.pendingBackgroundTask, ClaudeBackgroundDetails, ClaudeAdapterV2, ClaudeReplayFixtures.integration, ClaudeAutomaticDelivery.integration, web threadPendingBackgroundTasks).
- All Claude adapter test files plus the replay fixtures and goatMcpToolNames before the rule 3 edits: 720 tests, 717 passed and the 3 expected failures named above.
- `agent-surface:check` and `agent-surface:context-budget-check`: exit 0, every harness within budget, unchanged.
- `devlog/_chase/scan.sh --delta`: the same findings before and after the new area (pre-existing unreachable hashes), 41 areas.

NOT RUN: a real-client pass and the L179 web capture (joins P1's pass; Replay cannot reach the Claude adapter, see above). NOT RUN: a real Claude turn for any row (none needed one beyond what the replay harness shows; the Plan-mode routing of C14 rests on GOAT's existing adapter behaviour, ClaudeAdapterV2.ts `permissionMode === "plan"` → `installPermissionCallback: true`, not on a live turn). NOT RUN: goat-ci (the lane opens no pull request; the cycle's CI runs on #3660). NOT RUN: Windows and mobile device runs.

## Follow-ups (branch chase/t3-261114-next2-n9ab-followups, cut from ef8e62ad8c)

Head `538a7d6aeabd08748977576b76f972c559e8a651` (git ls-remote matches).

- N9a-P3-1, `a36d9bf43a` test and `538a7d6aea` fork delta wording. In Plan mode, and in read-only sandboxes under Supervised or auto-accept-edits, Claude no longer asks before goat_background_wait (accepted as upstream has it, coordinator 12:41:08). New ClaudeBackgroundWaitApproval.test.ts opens a turn under a read-only sandbox in approval-required and in auto-accept-edits, takes the permission callback Claude would get, and races the wait's decision against any approval request: "allow" comes first. With the allow line removed from goatMcpToolNames.ts it fails at once in both modes (`expected 'asked' to equal 'allow'`). A first draft awaited the decision directly; with the line removed that draft waited for a person until the 120 s project timeout, so it was rebuilt as the race before commit.
- N9a-P3-2, `78b3e29c5d`: ClaudeForkedSkillModel.test.ts gains "looks up nothing when the runner cannot read transcripts", a direct call with no lookup and a qualifying finished fork that returns `[]`, beside the same task with a lookup returning the model. A mutation of the absent branch (returning an update) fails it; with the code restored, 3/3 pass. The harness case is retitled "leaves a forked skill's model unset when the lookup finds no model", body unchanged.
- N9a-P3-3, `c6efecb264`: `claudeForkedSkillModels` is `Effect.fn("ClaudeForkedSkillModel.models")`.
- Record only: the launch memory holds command strings, bounded by count (64), not by bytes. ClaudeAgentSdkQueryRunner.ts is at 996 of 1000 lines after the integration merge; the next change there moves code out first.

Checks on 538a7d6aea: `vp run check:changed origin/chase/t3-261114-next2` (the integration head was e80f5132e7 by then, X1's follow-ups): exit 0; format, lint, knip 1/2 and 2/2, graphql, agent surface audit, agent context budget and typecheck (42 packages) pass; test 2 files, 5 passed. `git merge-tree --write-tree` of 538a7d6aea with e80f5132e7: clean; X1's follow-ups touch no file of this branch. Server typecheck exit 0; ClaudeBackgroundWaitApproval, ClaudeForkedSkillModel and goatMcpToolNames: 14 passed. No budget entry changes (no listed file grew). Nothing left running: the hung first-draft run had ended before the check, and no vitest process for this worktree remains.

#3660 behaviour line: "In Plan mode and in read-only sandboxes under Supervised or auto-accept-edits, Claude no longer asks before goat_background_wait (as upstream; the wait only marks the calling thread's own background tasks as awaited)."

## Coordinator messages (verbatim)

> Cycle coordinator, 2026-11-17 11:26:34 UTC, part 2 (as relayed in the brief):
> 2. NEXT LANE ON pen-macbookpro2 (free since S4): START N9a, the plan's lane for that host: C14 (L148 b9381c257d), C15 (L177 e77384bf00), the rest of L181 1a5d3737b7, L179 d4b77d2448. Run host.status with placement first and say what it showed. A GOAT-managed worktree, branch chase/t3-261114-next2-n9a-claude cut from origin/chase/t3-261114-next2 = e9e20d52be. The brief carries the cycle's rules as the other lanes' briefs do (fresh-command claims and NOT RUN; a failing test first for logic; rule 3: any change to an existing dev test or harness comes to me as file:line before and after; budgets, no entry raised; plain pushes to its own branch; no merge of dev; check:changed against the integration head; sub-agents on gpt-6.1-terra). Specific orders: L179 is C4 (nativeItemId): BEFORE any code it sends me a plan saying whether a stored id, a persisted event or a wire field changes, what an older server or client and already stored threads see, and the negative cases; it carries on with C14 and C15 meanwhile. A real Claude turn only where a row depends on Claude's own behaviour, on the cheapest model, each one named in the record with why Replay could not show it. Every row says what a person sees per client (web, desktop, mobile) or "no visible change".

> Cycle coordinator, 2026-11-17 11:27:54 UTC (as relayed in the brief):
> THE CUT OF #3660 (the owner asked on 11-17 to wrap up, merge, and line up the next one, so this pull request does not wait for the whole plan): it merges when the lanes now cut from it (X1, N4, N12, N15b, N9a; S4 and CF1 are in) are reviewed and merged into the integration branch and P1's integrated pass on that head is done. N10, N14, N15a, SF1 to SF3 and TF1 still start as their hosts free up, in the plan's order, but a lane that is not READY at the cut moves to next3 with its branch as it is (cut from the same line, so nothing is lost). Tell each new lane this in its brief.

> Lane coordinator, 11:31 UTC: a correction to your brief: card 10.027 is at devlog/_chase/10.027_t3_chase_cycle_261114_next2.md on origin/chase/t3-261114-next-records (not under _fin/10/). The plan is devlog/_chase/261114_lanes/next2-pr-plan.md as written. Nothing else changes.

> Coordinator to lane coordinator, 2026-11-17 11:35:21 UTC, for N9a (quote verbatim in its record and in next2-pr-plan.md under "Coordinator answers").
> L179 (d4b77d2448, nativeItemId): OPTION A, the field as upstream has it. The plan answers what I asked: the change only adds an optional key, no existing id moves, no migration, and every reader that does not know the key drops it. Conditions:
> 1. Contract tests as listed: with the field; without it; an old-shape Struct given the new payload drops it. Add one through a STORED row: a provider-thread projection payload written with the field is read back by the current decoder with it, and a payload written without it reads as today.
> 2. The adapter's memory: at most 64 ids per session as upstream, dropped on task_notification, and gone when the session ends or is cut (say where; a test or the path:line). The negative cases as listed (no tool_use_id, a blank one, forgotten after the notification, the oldest evicted while a live roster task keeps its id).
> 3. What a person sees: command and startedAt filled for a roster-only entry and for a command that moves to the background. startedAt is the time of the remembered tool call, not the time the roster entry arrived: pin that in the test. Web and desktop Details show it (one web capture, before and after, through test-goat-app with Replay if a fixture can produce a moved command; otherwise say so and it joins P1's pass); mobile: "no visible change" in the record.
> 4. threadPendingBackgroundTasks.ts:29/:40 and orchestrationV2PendingBackgroundWork.ts:281/:297 change ONLY with a failing test first that shows a wrong result a person can see for Claude. If no such test can be written, leave both sites and file one issue saying the comparison never matches for Claude and what that costs, if anything.
> 5. Agents: threadListView.ts:202 stays as it is (no new field in any agent output); the agent surface audit and context budget pass unchanged. If either moves, stop and tell me.
> 6. Rule 3: nothing is authorised yet. Send the exact file:line before and after for ClaudeAdapterV2.test.ts (:6673-6747 and the two roster deepEquals) and testkit/fixtures/claude_background_monitor_wake/output.ts when you reach them; say for each whether the old expectation was wrong, or right and now extended by one key.
> C15 (e77384bf00), subagentModel OPTIONAL in GOAT's runner shape: ACCEPTED, with two conditions. (i) Optional must not hide a production miss: every production runner supplies it, proven by the compiler (the live runner's own type has it required, or it is built with satisfies against a required shape) or by one test on the real runner; "absent = no lookup" is for fakes only, and the code comment says so in one line. (ii) The record and the fork delta entry for the Claude adapter name the difference from upstream (optional here, required there) so the next port of an upstream test that passes it is known to apply as is. The new test covers absent and present.
> Go ahead with A; C14, C15 and L181's rest as planned.
> (Lane coordinator: relayed verbatim. Note on C15 (ii): the fork delta file is devlog/_chase/010_fork_delta.md in the code branch; edit the Claude adapter's entry there in your lane, in its own small commit. Issues go through --body-file.)

> Lane coordinator, 11:48 UTC: a rule from the coordinator (11:34:08 UTC, item 4) for every lane: "PR bodies, issue bodies and comments go through a file and --body-file, never through a quoted argument." (A lane's draft body command put backticks inside double quotes and the shell ran them; no harm, but write every body or comment to a file first, from a quoted heredoc, and pass --body-file.) Your L179 plan (parts 1 and 2) is with the coordinator now; keep L179 code unstarted until the answer and carry on with C14 and C15.

> Coordinator to lane coordinator, 2026-11-17 11:47:25 UTC (quote each part verbatim in that lane's record and in next2-pr-plan.md under "Coordinator answers").
> PART A, for N9a.
> 1. RULE 3, C15, AUTHORISED: apps/server/src/orchestration-v2/Adapters/ClaudeWakeHarness.testkit.ts, exactly the two added lines (line 37 "readonly subagentModel?: string;" and line 170 "subagentModel: () => Effect.succeed(options?.subagentModel ?? null),"); an optional harness option that defaults to the old behaviour; no expectation changes. Condition (i) of C15 is met by the satisfies Required<...> on the live runner; keep the TS2741 output in the record.
> 2. C14 (71afe0f935) is a PERMISSION change, so it is C4 in the review and the record must show the negative cases as tests, not as prose: goat_call with any other path still asks in Plan mode; a goat_call whose path is the background wait but which carries anything that makes it more than a wait is not waved through (say what the callback inspects: the path only, or the arguments too); every other GOAT tool's decision in Plan mode is unchanged (one table-driven case over the registry's names is enough); a read-only outside client is still refused at McpToolAccess.ts:110. State in one line why waiting needs no approval (it reads nothing new and changes nothing).
> 3. The move-out 240f3f32c2 is not verbatim (a comment cut from 6 to 4 lines): fine, the record says "verbatim except that comment" and quotes both versions, so the reviewer can check the rest by script.
> 4. L181's rest: the 50 ms rule is tested with TestClock.adjust only (it.effect), no wall clock; one case shows a block that completes before 50 ms still publishes its full text once, and one that the last partial line is not lost when the block ends between two publishes.
> (Lane coordinator: relayed verbatim; part A is yours. The two harness lines may now be committed with ClaudeForkedSkillModel.test.ts.)

> Lane coordinator, 11:55 UTC: N9a, received (C14 71afe0f935, move-out 240f3f32c2, C15 584c43ad70; condition (i) proven by TS2741). Your ClaudeWakeHarness.testkit.ts rule 3 request (lines 37 and 170) is with the coordinator; keep those two lines and ClaudeForkedSkillModel.test.ts uncommitted until the line comes back. Carry on with L181's rest. Note for your record: 240f3f32c2 is not byte-verbatim (the proxy comment went from 6 to 4 lines); say so there so the reviewer checks only that comment differs.

> Coordinator to lane coordinator, 2026-11-17 11:55:36 UTC, for N9a (quote verbatim in its record and in next2-pr-plan.md under "Coordinator answers").
> RULE 3, L179, AUTHORISED, exactly these and nothing else:
> 1. apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts:6999 ("keeps a running Claude monitor typed after many newer monitors end"): the expected roster entry { taskId: longRunning.taskId, kind: "monitor", description: "Monitor 0" } gains nativeItemId: "toolu_monitor_0".
> 2. The same file :7636 ("clears the replaced sibling native thread roster when openQuery switches processes"): { taskId: taskA, description: "work on A", kind: "command" } gains nativeItemId: "toolu-roster-a".
> 3. apps/server/src/orchestration-v2/testkit/fixtures/claude_background_monitor_wake/output.ts:42: the deepEqual at :39 gains nativeItemId: "toolu_019b4EUbhEcYP4TS7vZn27N1" (the recorded transcript's own tool_use id; the record names the ndjson line).
> Reason: each old expectation was right and is extended by the one new optional key, as upstream extends the same three; no other key, value, row or title changes.
> 4. The move of "preapproves the six granted reads and never any memory write on read-only policy" from ClaudeAdapterV2.test.ts (:16366-16385) into ClaudeAdapterV2.allowedTools.test.ts, unchanged apart from the dedent and one type import: AUTHORISED as a move between GOAT's own test files; the record gives the script or diff that shows the body is identical, and says what setup the test relied on in its old describe block ("Claude WP4 memory delivery": any beforeEach, shared layer or helper) and that the new file gives it the same.
> Conditions:
> (a) C14: my "changes nothing" was wrong and your sentence is the one for the record: the wait changes only the awaited flag on the caller's own tasks. Because it does write, add the negative case if it is not there: a wait that names another thread's task id sets nothing on that task and is refused or ignored as the service does today (path:line of the check), in Plan mode and outside it. The reviewer confirms it.
> (b) The launch memory outliving a process replacement inside one session: accepted as argued; the record states the bound (64) holds across replacements too, so a session that replaces its process many times cannot grow it.
> (c) Not porting upstream's extension of the incremental roster fallback test: accepted, since GOAT's own test passes unchanged and ClaudeBackgroundDetails.test.ts pins the moved command and the tool call's time.
> Commit them, then check:changed against the integration head; READY when L181's rest and the web capture question of my 11:35 condition 3 are answered (a capture, or "joins P1's pass" with why).
> (Lane coordinator: relayed verbatim. You may now commit the four held edits and push your lane branch.)

> Lane coordinator, 12:09 UTC, from the coordinator's 12:07:55 order: THE LIDGE RUNNER POOL HAS STOPPED HANDING OUT RUNNERS (jobs queued since 11:48Z; only lidge-goat-02 registered). Until it is solved, DO NOT DISPATCH new goat-ci runs (no gh workflow run, no reruns); pushes themselves are fine, but expect any push's goat-ci to sit queued. I tell you when the pool works again.

> Lane coordinator, 12:10 UTC: N9a, received; your L179 rule 3 request (items 1-4) is with the coordinator. Keep those edits uncommitted until the line comes back; meanwhile push nothing that would leave 29ea1e4228's three failures on origin (either hold 29ea1e4228 locally too, or push only up to 06fc9eb4f0 / ff1c02dca7).
> (Done: origin held 06fc9eb4f0 until d4b9feea14 was committed; bd106c6a52 is the first push past 29ea1e4228.)

> Lane coordinator, 12:11 UTC: the goat-ci hold is LIFTED (coordinator 12:09:26: runners register again; the pool handed out nothing between about 11:40Z and 12:08Z, cause under investigation, not the network). Dispatch goat-ci as your round needs, one run each.

> Lane coordinator, 12:14 UTC, a CI rule from the coordinator (12:13:04, item 3): goat#3676: a pull request run that sits with only goat-scope queued for more than a few minutes while lidge slots are idle is the runner scaler's known blind spot; report it to me, do NOT push again to shake it loose. (N9a: READY received; head on origin is now 27f57b9b3d (your budget-lowering commit after bd106c6a52); I pass it to the coordinator with that head.)

> Coordinator to lane coordinator, 2026-11-17 12:14:49 UTC (date -u; quote in N9a's record).
> N9a READY at 27f57b9b3d: checked here (git ls-remote = 27f57b9b3d9631615b96260dc75c720fa3e28549; e9e20d52be is its ancestor; 15 commits, 25 files +907/-121). A FRESH C4 REVIEW IS RUNNING on that exact head: task goat-next2-N9a-final-27f57b9b (Opus 5.5 xhigh): the Plan-mode wait as a permission relaxation (every way a goat_call could carry more than the wait), the nativeItemId field's compatibility both ways and its memory bound, the web filter for providers without the field, the 50 ms rule, rule 3 against your two authorised sets, the budgets at the last commit. N9a pushes nothing until the verdict. Two things N9a does meanwhile, light: (1) run check:changed against origin/chase/t3-261114-next2 on 27f57b9b3d itself (the budget commit was not checked; the code-budget lint reads that file) and report the exit; (2) nothing else: no new rows. pen-macbookpro2 is otherwise free after that; the next lane for it waits for my word (I want the verdict first, since a fix round would need the Mac).
> (Lane coordinator: relayed verbatim. Run check:changed on 27f57b9b3d, report the exit, then stand by; no push.)

> Lane coordinator, 12:19 UTC: N9a, received (check:changed exit 0 on 27f57b9b3d). "Pushes nothing until the verdict" means your LANE branch only; records-branch pushes (your own file, plain fast-forward) are fine as always: quote the 12:14:49 message in next2-N9a.md and push the records. Then stand by.

Check on 27f57b9b3d itself (12:16 UTC): vp run check:changed origin/chase/t3-261114-next2 exit 0; format, lint (goat/code-budget reads the lowered entries), knip 1/2 and 2/2, graphql, agent surface audit, agent context budget, typecheck (42 packages) pass; test 73 files, 2833 passed.

> Lane coordinator, 12:35 UTC: the integration head is now f8c3a1897b (X1 merged; it touches only CI files and structure/ci.md). N9a: do NOT merge or push while your review runs; after the verdict.

> Coordinator to lane coordinator, 2026-11-17 12:41:08 UTC (date -u; quote verbatim in N9a's record and the card row).
> THE FRESH C4 REVIEW of N9a at 27f57b9b3d9631615b96260dc75c720fa3e28549 IS "APPROVE WITH NITS" (Opus 5.5 xhigh; nothing at P0 to P2). By its own runs: 14 focused files pass on an exact archive of the head (88 + 326 + 45 + 40 + 7 tests); a 22-input probe of the Plan-mode callback allows only the wait in its two names and asks for every variant (case, suffix, disagreeing keys, nested surface calls, goat_eval); the base commit's real decoder drops nativeItemId for every kind; mutations of C14, L181, L179 (adapter and web) fail their tests; rule 3 only the authorised lines; budgets equal the files' lengths.
> N9a IS MERGED INTO THE INTEGRATION BRANCH: chase/t3-261114-next2 = ef8e62ad8c65da0afb5d1741aaf17f511e4fe65f, a merge with parents f8c3a1897b (X1) and 27f57b9b3d, tree bc3db2db83 = git merge-tree's own result (no file changed on both sides); a plain push. #3660's head is ef8e62ad8c (S4, CF1, X1, N9a in).
> FOLLOW-UPS, one small branch chase/t3-261114-next2-n9ab-followups cut from ef8e62ad8c:
> - N9a-P3-1: the wait also stops asking in a READ-ONLY sandbox outside Plan mode (goatMcpToolNames.ts:148 sits before the read-only branch at :149; the callback is installed for approval-required, auto-accept-edits, any approvalPolicy other than never, and a downgraded bypass, ClaudeAdapterV2.ts:1612-1617). MY RULING: ACCEPTED AS UPSTREAM HAS IT (upstream b9381c257d put the wait on its read-only preapproved list; the wait writes only the awaited flag on the caller's own tasks). So no code change, but the words must be true: the record's C14 "what a person sees", the fork delta item (devlog/_chase/010_fork_delta.md:51) and one Known limits or behaviour line for #3660 say "in Plan mode and in read-only sandboxes under Supervised or auto-accept-edits, Claude no longer asks before goat_background_wait". Add one test row for the read-only, not-Plan case so the widening is pinned on purpose.
> - N9a-P3-2: the C15 "absent" test never reaches the absent branch (the wake harness always supplies subagentModel; the reviewer's mutation of that branch still passed). Add one direct case: claudeForkedSkillModels with lookup undefined and a qualifying registered task returns []; no harness change. Retitle the existing one to what it shows ("a lookup that finds no model").
> - N9a-P3-3: ClaudeForkedSkillModel.ts:24 is an exported reusable function on Effect.fnUntraced without a reason; it runs once per turn result: Effect.fn("ClaudeForkedSkillModel.models") (or the name the file's neighbours would use).
> - Record only: the launch memory holds command strings, bounded by count (64), not bytes; ClaudeAgentSdkQueryRunner.ts is at 996 of 1000 lines (the next change there moves code out first).
> Then check:changed against origin/chase/t3-261114-next2, a plain push, report the head; I read it and merge it.
> THE OTHER LANES: the integration head is ef8e62ad8c. N4, N12, N15b merge it at their READY points (N9a and N12 both touched code-budgets.json: the reviewer's merge-tree with n12-preview d919ffe7c0 was clean and the entries still equal the file lengths; say if that changes).
> 
> (Lane coordinator: relayed verbatim (the whole message; the last paragraph is for the other lanes). Cut chase/t3-261114-next2-n9ab-followups from ef8e62ad8c; the #3660 behaviour line goes in your READY report for the coordinator to put in the body. After you push, pen-macbookpro2 gets the next lane (SF1), so finish cleanly: nothing left running.)

> Coordinator to lane coordinator, 2026-11-17 12:52:33 UTC (date -u; quote in N9a's record and card row).
> N9a's FOLLOW-UPS 538a7d6aea: READ BY ME (git diff ef8e62ad8c 538a7d6aea: the new ClaudeBackgroundWaitApproval.test.ts races the approval request against the decision for approval-required and auto-accept-edits in a read-only sandbox and expects allow; the direct no-lookup case and the retitled lane test in ClaudeForkedSkillModel.test.ts; Effect.fn("ClaudeForkedSkillModel.models"); the fork delta sentence). MERGED INTO THE INTEGRATION BRANCH: chase/t3-261114-next2 = 308b3d11b8d34fef2b3e4b2657c4e11086da46ac (parents e80f5132e7 and 538a7d6aea; tree e9aa94cd84 = git merge-tree's own; a plain push). #3660's head is 308b3d11b8 (S4, CF1, X1 and N9a with their follow-ups). N9a's behaviour line and the owed L179 capture are in #3660's body. Lane N9a is DONE for #3660: it records this and stops; its worktree can stay for a fix round if the integrated pass finds something.
> Every lane that merges the integration head at its READY point merges 308b3d11b8. Noted: SF1 started (mcp:12e57d0f-04c4-4f9f-af44-0d590372ce4e); X1 done and stopped.
> For your own shell work, since it bit me three times today: in zsh, "$C:refs/heads/x" applies the :r modifier to $C and mangles the refspec ("src refspec …acefs/heads/… does not match any"); write "${C}:refs/heads/x" or the literal sha. Pass it on to any lane that pushes a computed sha.
>
> (Lane coordinator: relayed verbatim. Record it in next2-N9a.md and the card row, then stop; keep the worktree for a possible fix round.)

Lane N9a stopped with this message; the worktree stays on chase/t3-261114-next2-n9ab-followups at 538a7d6aea for a possible fix round.
