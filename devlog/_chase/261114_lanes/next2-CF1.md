# CF1 clients (lane record)

Lane branch: `chase/t3-261114-next2-cf1-clients`, head `fdfda95783cd5e3b61a1eed50b6224574b967a1f`, cut from the integration branch `chase/t3-261114-next2` at `ed4268897e3183341694f27e488232572d5c5151` (draft PR #3660). Host pen-macmini. Plain push, no force. One commit per row.

## Rows and commits

| row | class | GOAT commit | proof |
| --- | --- | --- | --- |
| goat#3513 (web Office: CJK fonts against the worker call limit) | C2 | `7a18414c62250319a72d3e5ecb220a6e904f3dee` | failing tests first (below); real-client open of a Japanese and Korean docx |
| goat#3514 (web Word: SVG decode unbounded) | C2 | `adf39bb67c9948e5bab55fdfea4dca7d24e74821` | failing tests first (below) |
| goat#3658 (web and mobile: missing-worktree banner) | C4 | `76bbeb82f9d9d1a5dacb8f298ad7cda9a2b49e55` | failing server tests first; web before/after captures; phone captures owed |
| goat#3652 (mobile Usage dimming) | C2, visual | `2fb3043722475043c4e67b7425383fadacacc294` | visual: phone before/after captures owed, no UI test |
| goat#3557 (mobile Create worktree during a turn) | C4 | `b325b38538b52b0e3f662dfd669badeed742c2d7` | failing tests first (below); phone capture owed |
| goat#3654 (mobile failed Git action hidden under the sheet) | C2 | `fdfda95783cd5e3b61a1eed50b6224574b967a1f` | failing test first (below); phone captures owed |

## Coordinator answers (verbatim)

> Coordinator to lane coordinator, 2026-11-17 08:53:31 UTC, for CF1 (quote verbatim in next2-pr-plan.md under "Coordinator answers" and in CF1's record).
> goat#3658, the C4 plan: YES, with these conditions.
> 1. The field as planned: ThreadWorkspaceStatus.recreatable, Schema.optionalKey(Schema.Boolean), set by ThreadWorkspaceService.status from the same isManagedWorktreePath the restore and the send check use, on "missing" and "cleaned" only; absent means "as today". No other contract change.
> 2. "cleaned": show that recreatable=false there matches what the server refuses. Name with path:line what Restore (the snapshot path) does for a cleaned worktree outside the worktrees folder, and whether such a state can exist at all (cleanup of an unmanaged worktree; a worktreesDirectory setting changed after the cleanup, which previousWorktreesDirectories should cover). If Restore would SUCCEED for a case where recreatable is false, the banner must not hide Restore for it: the rule is that the banner offers exactly what the server will do. One server test per state.
> 3. The sentence under "cleaned" and "missing" that says a send restores or recreates it ("Sending a message restores it too." / "Sending a message does the same.") is dropped when recreatable is false; when it is true or absent the text is today's, unchanged.
> 4. Agents: say whether any agent tool or thread read returns ThreadWorkspaceStatus (worktree.status, thread.read, the agent surface contracts). If it does, the field reaches agents too: update the tool's description only if it lists fields, run the agent surface audit and say whether its counts move. If no agent path returns it, say so in the record.
> 5. Wording for both clients, one helper in contracts as planned: title unchanged; body "GOAT can't recreate it: it is outside GOAT's worktrees folder. Put the folder back at <path>, or start in a new worktree." (for "cleaned", "restore" in place of "recreate" if case 2 keeps that state). No Recreate or Restore button; "Start in a new worktree" stays.
> 6. Tests as planned (server: outside false, inside true, present absent; the shared helper: false, true, absent). Captures: web before and after from the real client; the phone captures are owed and listed. Docs: check docs/user for a sentence that promises Recreate or a send always rebuilds a missing worktree and correct it if there is one.
> 7. The review of CF1's head treats this row as C4: both directions of old and new client and server, as the plan states them.
> Carry on with the other rows meanwhile; goat#3557 stays C4 with negative cases as you said.

## goat#3513

Fix. A font download no longer runs on the 30-second per-call deadline. The worker tells the window when the running call waits on font bytes (`waitOutsideDeadline`, apps/web/src/components/files/office/worker-rpc.ts), and the window pauses the deadline of every pending call while any such wait is open, then gives each a fresh 30 seconds (corrected in the fix round, CF1-P2-2: the first version paused only the running call). Each face has its own bound instead: 30 seconds plus its size at 256 kbit/s (fonts.ts `loadFace`; Simplified serif 11.6 MB gets about 6.6 minutes). When it expires, the load rejects with "The fonts this document needs did not finish downloading. Check the connection, then open it again.", but no viewer shows that message: every caller falls back to substitute fonts without a notice (corrected in the fix round, CF1-P3-1; goat#3665). A stalled download used to hang forever inside a paused call; now it is bounded. Because the deadline no longer kills the worker mid-download, a completed face lands in the browser's HTTP cache for the next open. Slides and spreadsheets already ignore a failed face and draw with the fallback (slide-fonts.ts:56, sheet-fonts.ts:33). The OpenXML viewer's own 30-second timer (OpenXmlOfficeViewer.tsx:65) stops when its preparation worker answers, before any engine loads fonts, so it does not cover downloads.

Tests, fail-first on ed42688:
- worker-rpc.test.ts "does not run while the worker waits on font downloads, which have their own bound": `expected { failed: 'This document took too long to preview. Open it in another app.' } to deeply equal { value: 'opened' }`.
- worker-rpc.test.ts "gives the call 30 seconds again once the wait ends": passed before and after (it guards that the deadline still exists).
- fonts.test.ts "fails a font download that outlasts its own bound with a message about the fonts": `Test timed out in 15000ms` (the download had no bound, so the promise never settled).
After the fix: `vp test run` of worker-rpc.test.ts, fonts.test.ts, fonts.browser.test.ts, word-document.browser.test.ts and slide-fonts.browser.test.ts: 5 files, 11 tests passed.

Real client (web, this worktree's dev server): a docx with Calibri, MS Mincho and Malgun Gothic runs opens through the real document worker with Japanese and Korean drawn in the bundled faces.

![cf1-3513-web-cjk-docx-opens](https://raw.githubusercontent.com/goat-si/goat/1d43857b433e143b143f4f995f877cf24b2c5f5d/3660/cf1-3513-web-cjk-docx-opens.png)

Limits. A link slower than 256 kbit/s per face still fails, now with the fonts message. Faces downloading at once share the link, so the Chinese example (two faces, 20 MB) needs about 512 kbit/s. Thresholds are computed from sizes, not measured on a throttled link.

## goat#3514

Fix (vector-pictures.ts). An SVG picture above 2 MB keeps the engine's placeholder without being decoded. The window stops waiting for a decode after 3 seconds, clears the image's source, and keeps the placeholder. Workers have no image element and `createImageBitmap` does not take SVG, so the decode stays in the window; a decode the browser already started cannot be preempted, only abandoned.

Tests, vector-pictures.browser.test.ts, fail-first on ed42688:
- "leaves an SVG picture above the size limit to the engine's placeholder without decoding it": `expected [ ImageBitmap{}, 1 ] to deeply equal [ undefined, +0 ]`.
- "stops waiting for an SVG picture whose decode outlasts its time budget": `Test timed out in 15000ms`.
- "draws a small SVG picture at its own size": passed before and after.
After the fix, with word-images.browser.test.ts: 2 files, 4 tests passed.

## goat#3658 (C4)

Contract. `ThreadWorkspaceStatus.recreatable: Schema.optionalKey(Schema.Boolean)` (packages/contracts/src/worktreeRetention.ts). No other contract change.

Server. `ThreadWorkspaceService.status` sets `recreatable: yield* isManagedWorktreePath(worktreePath)` on the "missing" and "cleaned" answers only (ThreadWorkspaceService.ts, the final return of `status`). The same function decides `restoreInPlace` (ThreadWorkspaceService.ts:137-141), the send check (WorktreeSendCheckLive.ts:32) and turn start (prepareTurnWorkspace.ts:51).

Clients. One helper, `describeThreadWorkspaceRecovery` (worktreeRetention.ts), gives the body and whether to offer Restore or Recreate; both banners keep their own titles (web ThreadWorkspaceBanner.tsx, mobile features/threads/ThreadWorkspaceBanner.tsx). With `recreatable: false` (wording of the fix round, CF1-P3-3): "GOAT can't recreate it here. Put the folder back at <path>, or start in a new worktree." ("restore" for "cleaned"), no Recreate or Restore button, and "Start in a new worktree" stays. True or absent: today's text and buttons, unchanged.

Condition 2, "cleaned" outside the folder. Restore for "cleaned" and "missing" both go through `restoreInPlace` (ThreadWorkspaceService.ts:313-317, mode "restore"), which refuses any path outside the managed folders with "GOAT only restores worktrees in its worktrees folder." (:137-141; :135 at ed42688) before the snapshot path runs; a send skips recreation there too (prepareTurnWorkspace.ts:51). So recreatable=false hides only what the server refuses, in both states; no case has Restore succeed with recreatable false. Can the state exist (corrected in the fix round, CF1-P3-3): yes, two ways. Cleanup removes a linked worktree at any depth under a managed root (storageCleanup.ts:238-246, :705-706), while Restore accepts only <root>/<repository>/<name> (worktreesDirectory.ts:219-227), so a worktree at <root>/<name> or <root>/a/b/c can be cleaned and then read "cleaned" with recreatable false (goat#3664, N4's row). It also arises because `status` takes the thread's latest snapshot by thread id (ThreadWorkspaceService.ts:115), not by path: a thread cleaned up in GOAT's folder and later moved to an outside folder that went missing reads "cleaned". A changed worktreesDirectory setting does not produce it: `isManagedWorktreePath` checks the current setting, every previousWorktreesDirectories entry and the default root (worktreesDirectory.ts:152-168, :189-215).

Condition 4, agents. No agent tool or thread read returns ThreadWorkspaceStatus. `ThreadWorkspaceService` is used only by the WebSocket handlers (apps/server/src/storage/storageRpc.ts:35-37, `thread.getWorkspaceStatus` and `thread.restoreWorkspace`); `goat_worktree_status` (packages/contracts/src/agentSurface/entries/worktree.ts:126) reads the binding, not this status. Checked with `rg -n 'ThreadWorkspaceService|threadGetWorkspaceStatus' apps/server/src packages/contracts/src`. The agent surface audit passed inside check:changed; no description changed.

Condition 6, docs. No user guide promises that a missing worktree is always recreated. docs/user/project-settings.md:342-347 says Restore and a send bring back a worktree cleanup removed, and cleanup only removes worktrees inside GOAT's folder (storageCleanup.ts:705-706), so it stays true. No docs change.

Tests, fail-first on ed42688:
- ThreadWorkspaceService.test.ts "says a $state worktree in $place is recreatable only where restoring it would not be refused" (missing/cleaned × GOAT's worktrees folder/another folder): all four failed with `expected { threadId: 'thread-1', …(4) } to have deep property 'recreatable'`. The two outside cases also assert that `restore` with mode "restore" is refused with the server's detail.
- "leaves recreatable out for a worktree that is present, wherever it is": passed before and after.
- packages/contracts/src/worktreeRetention.test.ts, the helper for missing with recreatable absent, true and false, and cleaned with absent and false: new helper, so it could not import before; 5 passed after.
After: ThreadWorkspaceService.test.ts 15 passed; worktreeRetention.test.ts 5 passed.

Older and newer, both ways (condition 7):
- Older client, newer server: `Schema.Struct` decoding drops the unknown key; checked from packages/contracts: `decodeUnknownSync` and `toCodecJson` of today's ThreadWorkspaceStatus with `recreatable: false` return the object without it, so the older banner behaves as today (Recreate offered; pressing it shows the server's refusal).
- Newer client, older server: the key is absent and the helper treats absent as recreatable, so the banner is today's (helper test, the "absent" cases).

Web captures (this worktree's dev server, a thread bound to a removed worktree at /private/tmp/cf1-fixture/outside-feature, and one bound to a missing path in the dev server's worktrees folder):

Before, and Recreate pressed under the old banner (the server's refusal under the promise):

![cf1-3658-web-before](https://raw.githubusercontent.com/goat-si/goat/1d43857b433e143b143f4f995f877cf24b2c5f5d/3660/cf1-3658-web-before.png)
![cf1-3658-web-before-recreate-refused](https://raw.githubusercontent.com/goat-si/goat/1d43857b433e143b143f4f995f877cf24b2c5f5d/3660/cf1-3658-web-before-recreate-refused.png)

After, outside the folder, and inside it (unchanged):

![cf1-3658-web-after-outside](https://raw.githubusercontent.com/goat-si/goat/1d43857b433e143b143f4f995f877cf24b2c5f5d/3660/cf1-3658-web-after-outside.png)
![cf1-3658-web-after-managed-unchanged](https://raw.githubusercontent.com/goat-si/goat/1d43857b433e143b143f4f995f877cf24b2c5f5d/3660/cf1-3658-web-after-managed-unchanged.png)

Phone captures owed (iOS and Android, juns-MacBook-Pro): the banner of a thread whose worktree outside GOAT's folder is missing, before and after (new body, no Recreate, Start in a new worktree kept); the same for a thread in GOAT's folder (unchanged).

## goat#3652

Decision: the phone marks saved figures the way the web does, reading the rule the web already reads from client-runtime (`usageLoadingState`, packages/client-runtime/src/state/usageProgress.ts:73, covered by usageProgress.test.ts:113). The chart, totals and cost sections dim while any provider updates; each provider row and model row dims while its own provider updates (apps/mobile/src/features/usage/UsageRouteScreen.tsx, `UsageDim`). `usageProgress().dimmed` and its tests are unchanged (rule 3: usageProgress.test.ts:76-87 pin `dimmed: false` for a partway answer), and it no longer drives the phone's dimming; its label still does.

Visual change, so no UI test. Phone captures owed (iOS and Android): the Usage page opened cold with "Updating N providers…", before (saved figures at full strength) and after (dimmed), and the exact figures after the providers answer.

## goat#3557 (C4)

Fix: the phone checks the thread's run state before creating the worktree, with the web's rule (running or waiting, or an interruptible active run; web BranchToolbar.logic.ts:270 via session-logic.ts:1028), and shows the server's own refusal text (apps/server/src/orchestration-v2/goat/ActiveTurnRefusals.ts:7) without creating anything (apps/mobile/src/state/use-selected-thread-git-actions.ts, `turnBlocksWorktreeMove`). Nothing is deleted, so no destructive path was added.

Tests, use-selected-thread-git-actions.test.ts, fail-first on ed42688: "refuses Create worktree while a turn is running / waiting on a question / starting, before creating a folder or branch" all three failed with `expected [ { worktree: { …(2) } }, …(3) ] to deeply equal [ null, [], [], [ { …(3) } ] ]` (the worktree was created). Negative case "creates the worktree once the turn has ended" passed before and after, as do the existing permission cases. After: 18 passed.

Both ways: server unchanged. An older phone still creates first and the server still refuses the bind. A newer phone against an older server checks the same run state the shell already carries. Residual: a turn that starts between the check and the bind is still refused by the server and can leave a folder, as before; storage cleanup reports such orphans.

Phone capture owed: Create worktree from the Git sheet during a running Replay turn, showing the refusal in the sheet, and `git worktree list` before and after showing no new folder.

## goat#3654

Decision: keep a failure until the person dismisses it, and show it inside the open Git sheet. Each sheet (Branches, Commit, Confirm, Overview) renders `GitActionFailure` (gitSheetComponents.tsx) at the top of its content with a Dismiss; the same result still shows in the thread screen's banner after the sheet closes. Why: the person is looking at the sheet, and closing it on failure would throw away what they typed (a branch name, a commit message). Successes still clear after 5 seconds. A new action clears the previous result (use-selected-thread-git-actions.ts, `runSelectedThreadGitMutation`).

Test, apps/mobile/src/state/use-vcs-action-state.test.ts, fail-first on ed42688: "keeps a failed Git action's message until the person dismisses it, and clears a success after 5 seconds": `expected [ null, null, 'success', null ] to deeply equal [ 'error', null, 'success', null ]`. After, with the Git sheet tests and the hook tests: 4 files, 24 passed. GitBranchesSheet.test.tsx and GitBranchesSheet.occupancy.test.tsx gained `GitActionFailure: () => null` in their `./gitSheetComponents` mocks (mock setup, no expectation changed).

Phone captures owed (iOS and Android): a refused Create worktree with the Git sheet open, the failure in the sheet after more than 5 seconds, Dismiss clearing it, and the banner after closing the sheet without dismissing.

## Checks on the head

- `vp run check:changed origin/chase/t3-261114-next2` on fdfda95783 (pen-macmini): pass format, lint, knip 1/2, knip 2/2, graphql (apps/server), agent surface audit, agent context budget, typecheck (38 packages), test (22 files).
- `cd apps/mobile && vp run typecheck`: exit 0.
- The focused runs listed under each row.
- Rule 3: no expectation in an existing test changed. Budgets: no changed file has an entry in oxlint-plugin-goat/code-budgets.json; UsageRouteScreen.tsx is 939 lines. No test file moved or renamed.

NOT RUN: every phone capture listed above (owed until juns-MacBook-Pro is free); goat#3513 on a throttled link (thresholds computed from sizes); a pathological SVG in the real client for goat#3514 (covered by the browser tests); full CI (ci:full); an independent review (the coordinator runs one per READY).

## Coordinator answers, 09:22 (verbatim)

> Coordinator to lane coordinator, 2026-11-17 09:22:05 UTC (quote verbatim in next2-pr-plan.md under "Coordinator answers" and in each lane's record).
> 1. CF1 READY at fdfda95783: checked on origin (six commits on ed4268897e, 24 files +636/-91). The fresh review is running (Opus 5.5 xhigh, read-only, task goat-next2-CF1-final-fdfda957; goat#3658 and goat#3557 as C4: the recreatable field against what the server really does, compatibility both ways, agents; the mobile Create worktree check against the server's refusal and the residual race). CF1 stands by; no push until I send the verdict. One thing for CF1 to answer now, in its record, because the reviewer will ask: it touched two EXISTING mobile test files (GitBranchesSheet.occupancy.test.tsx, +5/-... and GitBranchesSheet.test.tsx, +1): the exact lines before and after and whether each is an import, a provide or prop line, or a harness or expectation change; a harness change needs my rule 3 line before the merge. THE PHONE CAPTURES CF1 owes (goat#3658 banner, goat#3652 Usage dimming, goat#3557 refusal, goat#3654 the message inside the Git sheet): N15b takes them on its own simulator and emulator after CF1 is merged into chase/t3-261114-next2 and N15b has merged that head; they are uploaded to #3660 and listed in CF1's record.

## Existing test files changed (answer to item 1)

Four existing test files changed between ed4268897e and fdfda95783, the two named above and two more listed here so the review sees them all. Every change is a harness change: a mock factory, hoisted mock state, a `beforeEach` reset, or a test layer. None is an import, provide or prop line, and no expectation (`expect`/`assert` argument or title of an existing case) changed. All four need the coordinator's rule 3 line. Fresh runs at fdfda95783: the three mobile files 23 passed; ThreadWorkspaceService.test.ts 15 passed.

1. apps/mobile/src/features/threads/git/GitBranchesSheet.occupancy.test.tsx:32, harness (vi.mock factory). Reason: GitBranchesSheet now imports `GitActionFailure` from ./gitSheetComponents, and a vi.mock factory without that export fails the import.
   - Before (ed4268897e:32): `vi.mock("./gitSheetComponents", () => ({ SheetActionButton: () => null }));`
   - After (fdfda95783:32-35), formatter split it over four lines: `vi.mock("./gitSheetComponents", () => ({` / `  GitActionFailure: () => null,` / `  SheetActionButton: () => null,` / `}));`
2. apps/mobile/src/features/threads/git/GitBranchesSheet.test.tsx:77, harness (vi.mock factory), the same reason. One line added inside the existing factory at :76; the `SheetActionButton` stub that records actions is unchanged.
   - Before (ed4268897e:76-77): `vi.mock("./gitSheetComponents", () => ({` / `  SheetActionButton: (props: ActionProps) => {`
   - After (fdfda95783:76-78): `vi.mock("./gitSheetComponents", () => ({` / `  GitActionFailure: () => null,` / `  SheetActionButton: (props: ActionProps) => {`
3. apps/mobile/src/state/use-selected-thread-git-actions.test.ts, harness, three lines; the rest are two new cases (:169-193 "refuses Create worktree while a turn is %s, before creating a folder or branch", :195-204 "creates the worktree once the turn has ended").
   - :18 added to the hoisted `state.thread` after `worktreePath: null as string | null,` (ed4268897e:17): `runtime: null as { status: string; activeRunId: string | null } | null,`. Reason: the hook now reads `thread.runtime`; null is "no runtime", what every existing case had.
   - :65 added to the `./use-vcs-action-state` mock after `state.results.push(result),` (ed4268897e:63): `dismissGitActionResult: () => {},`. Reason: the hook now calls it when an action starts.
   - :139 added to `beforeEach` after `state.thread.worktreePath = null;` (ed4268897e:136): `state.thread.runtime = null;`.
4. apps/server/src/orchestration-v2/goat/ThreadWorkspaceService.test.ts, harness, three places; the rest are new cases (:238-264 the four recreatable cases, :266-276 the present case).
   - :39-40 added to `HarnessOptions` after `readonly duringSetup?: …` (ed4268897e:38): `/** The thread has a cleanup snapshot, so a missing folder reads as cleaned. */` / `readonly snapshot?: boolean;`.
   - Before (ed4268897e:110): `latestForThread: () => Effect.succeed(null),`. After (fdfda95783:112-126): `latestForThread` returns a fixed WorktreeSnapshot when `options.snapshot === true`, else `null`, so every existing case still gets `null`.
   - Before (ed4268897e:142): `ServerSettings.ServerSettingsService.layerTest(),`. After (fdfda95783:159-161): `ServerSettings.ServerSettingsService.layerTest({` / `  worktreesDirectory: NodePath.join(root, "managed"),` / `}),`. This one reaches every case in the file: the managed worktrees folder becomes <fixture root>/managed instead of the default. None of the existing cases has a path there, and none asserts `recreatable`, so they read what they read before; all 15 pass.

Proposed rule 3 wording, for the coordinator to accept or change: "rule 3, CF1: the four harness changes listed in next2-CF1.md under 'Existing test files changed' (mock factories gain the new export or a no-op, hoisted state and beforeEach gain runtime: null, the ThreadWorkspaceService harness gains a snapshot option and a managed worktrees folder under its fixture root); no expectation changes."

## Phone captures (owed, assigned by the coordinator)

N15b takes these on its own simulator and emulator once CF1 is merged into chase/t3-261114-next2 and N15b has merged that head; they are uploaded to #3660 and listed here when they exist: goat#3658 the banner (outside GOAT's folder before and after; inside unchanged), goat#3652 Usage dimming (cold open before and after), goat#3557 the refusal with no new folder, goat#3654 the failure inside the Git sheet past 5 seconds and Dismiss.

## Coordinator answers, rule 3 (verbatim)

> B. CF1, RULE 3 for the four existing test files: AUTHORISED for 1, 2 and 3 as listed in next2-CF1.md "Existing test files changed" (two vi.mock factories gain a GitActionFailure stub the new import requires; the hoisted state gains runtime: null and the mock gains dismissGitActionResult, both defaulted to the old behaviour). File 4, ThreadWorkspaceService.test.ts (HarnessOptions gains snapshot; latestForThread returns a snapshot only when asked; ServerSettings layerTest() becomes layerTest({ worktreesDirectory: NodePath.join(root, "managed") }) for EVERY case): AUTHORISED ON ONE CONDITION that CF1 proves in its record now and the running review checks: for each of the ten pre-existing cases in that file, the path it uses and why its outcome cannot depend on worktreesDirectory (none lies under <root>/managed and none read the default root before), with the file's ten titles passing on the base harness and on the new one. "Coordinator authorisation, 2026-11-17, rule 3, CF1: the four harness changes listed in next2-CF1.md under 'Existing test files changed' may stand; no expectation changes; file 4's settings change stands only with the per-case proof."

## File 4: per-case proof (ThreadWorkspaceService.test.ts)

Where worktreesDirectory is read. Under this test's layers the only reader of the setting is `isManagedWorktreePath`, which reads it on each call (apps/server/src/worktreesDirectory.ts:189-215, `getSettings` at :197). Building the checker at ThreadWorkspaceService.ts:55 reads no setting. Every other service the layer needs is a harness fake (ProjectionStore, ProjectService, GitWorkflowService, ThreadManagement, WorktreeSnapshotStore, ProjectSetupScriptRunner), or GitVcsDriver on its own ServerConfig layer, which has no ServerSettings use (`rg -n 'ServerSettings|getSettings' apps/server/src/vcs/GitVcsDriver.ts apps/server/src/workspace/workspaceLease.ts` finds nothing). At the head, ThreadWorkspaceService.ts calls the checker at exactly two places: `:123`, the new `recreatable` on the missing/cleaned return of `status` (:115-124), and `:137`, Restore with mode "restore" (`restoreInPlace`). At ed4268897e only the second existed, and no pre-existing case uses mode "restore". So at base, no case read the settings or the default root. At the head, only case 5 reaches a read, for a field it does not assert.

Paths. root is the fixture's mkdtemp folder; the new harness's managed folder is <root>/managed. A managed location is exactly <managed root>/<repository>/<name> (worktreesDirectory.ts:219-228).

| # | case (title) | thread worktreePath / folders it touches | code path | why the outcome cannot depend on worktreesDirectory |
| --- | --- | --- | --- | --- |
| 1 | starts a fresh worktree from the thread's branch, keeping its commits | `/worktrees/feature` (`idle`, :171); new worktree <root>/fresh (createWorktree fake, :53, :87) | restore mode "fresh": `startFresh` :170-185, `replace` :187-310 | neither function calls the checker; asserts headSha and startedFrom |
| 2 | starts a fresh worktree from the project base when the branch is gone | same | same | same; asserts headSha and startedFrom |
| 3 | reports a restore stopped … (untouched since) | <root>/restored | `status`: folder present and verified, returns at :106-114 | returns before :123; asserts state "present", setupIncomplete true |
| 4 | reports a restore stopped … (with a commit made since) | <root>/restored | same | same |
| 5 | reports a restore stopped … (on another history) | <root>/restored | `status`: verification fails, falls to :115-124 | state ("missing") and the absent setupIncomplete are fixed at :115-118 before the checker runs at :123. The checker answers false on both harnesses (<root>/restored is one level under root, never <managed root>/<repo>/<name>), and the case asserts neither `recreatable` nor anything derived from it |
| 6 | will not replace the worktree of a thread that is running | `/worktrees/feature` | mode "fresh": `replace` refuses at :197-207 before createWorktree | no checker call; asserts reason "busy" and nothing created |
| 7 | rebinds only if the thread still uses the worktree it replaced | `/worktrees/feature`; <root>/fresh | mode "fresh" | no checker call; asserts the rebind command |
| 8 | removes the new worktree when another change won the rebinding | same | mode "fresh", dispatch fails | no checker call; asserts reason and removal of <root>/fresh |
| 9 | keeps the new worktree leased through setup, and a failed setup never rebinds | same | mode "fresh", setup exits 1 | no checker call; asserts reason, lease, no rebind, removal |
| 10 | refuses a fresh worktree that setup moved off its branch | same | mode "fresh", verify fails | no checker call; asserts reason, no rebind, removal |

None of these paths lies under <root>/managed: `/worktrees/feature` is outside root, and <root>/fresh and <root>/restored are siblings of <root>/managed.

Runs at fdfda95783 (pen-macmini), against the head code:
- New harness: `cd apps/server && vp test run --reporter verbose src/orchestration-v2/goat/ThreadWorkspaceService.test.ts`: 15 passed, the ten titles above among them.
- Base harness: ed4268897e's ThreadWorkspaceService.test.ts copied beside it as an untracked ThreadWorkspaceService.baseharness.test.ts, run the same way: 10 passed, the same ten titles. The copy was then deleted; `git status --short` was empty before and after.

## Coordinator answers, 09:38 (verbatim)

> Coordinator to lane coordinator, 2026-11-17 09:38:12 UTC (quote verbatim in CF1's and N4's records and in next2-pr-plan.md under "Coordinator answers").
>
> A. CF1: THE FRESH REVIEW at fdfda95783cd5e3b61a1eed50b6224574b967a1f IS A BLOCK for two P2 (Opus 5.5 xhigh, read-only). The two C4 rows HOLD: goat#3658 (the banner and the server agree in every case the reviewer could build; old and new clients and servers mix; no agent path returns the status) and goat#3557 (the client check equals the web's; the server stays the authority; the leftover after a race is the same as before). Report /Users/jun/handoff-in/chase/next2-CF1-review-fdfda957.md: relay it in full to CF1.
> FIX ROUND for CF1, on top of fdfda95783, test first, one commit per finding:
> CF1-P2-1 (goat#3654): the Git action result is one value for the whole app (use-vcs-action-state.ts:23-26) and a failure no longer clears itself (:38), so a failure from thread A shows on thread B's banner and in every Git sheet of B until someone dismisses it. Fix: runSelectedThreadGitMutation attaches environmentId and threadId to the result; GitActionFailure and useGitActionProgress show it only for that thread (do not clear it on a thread change: the person should still find it on A). One cross-thread case in use-vcs-action-state.test.ts that fails first.
> CF1-P2-2 (goat#3513): only the call the worker is running has its 30 s deadline paused during a font download (worker-rpc.ts:164-166, :197); every call queued behind it (a cell click, a sheet switch, a jump, a resize, a second frame, other slides' paints) still times out at 30 s from when it was SENT (:135), terminates the worker (:81-85) and loses the download: the original symptom, for spreadsheets and slides. Fix: the worker runs one call at a time, so while any wait is open every pending call's deadline is paused and all restart on waiting: false; also the case where a paint is aborted mid-download and a later paint waits on the same face through the loads cache (the wait must not stay under the aborted call's id). A worker-rpc.test.ts case with a second call queued during the wait, failing first.
> CF1-P3-5 (goat#3654): render GitActionFailure on the iPhone review screen (useReviewHeaderPresentation.tsx:43-51, ReviewSheet) so a failed Pull, commit, push or pull request from its Git menu shows there; if that is more than a few lines, list the gap in the record and tell me.
> RECORD ONLY, in the same round: CF1-P3-1: no viewer shows the fonts message; say what a person sees (the loading state for up to 30 s plus the face's size at 32 kB/s, about 6.5 minutes for the 11.6 MB face, twice for one family in Word because the last-resort loader at fonts.ts:25-26 always runs; then fallback fonts with no notice) and correct the commit-message claim in the record; file ONE issue for a visible notice when a face failed and for the double wait, number to me. CF1-P3-2: the 3 s budget covers decoding, not drawing (createImageBitmap on the main thread): a known limit in the record and in #3660's body. CF1-P3-4: add to the residual risks that the server also refuses while background agents or commands still run after the turn ended (Orchestrator.ts:3092-3106) and the phone does not check that, so the folder and branch are left behind there, as on the base and as on the web.
> CF1-P3-3 (goat#3658): the banner's sentence "it is outside GOAT's worktrees folder" is false for one case: a worktree INSIDE the folder at another depth that cleanup removed (see part B). In this round: the helper's text for recreatable false must not claim a location it cannot know: reword to what is true in every case, for example "GOAT can't recreate it here. Put the folder back at <path>, or start in a new worktree." (and "restore" for cleaned); update the helper test's expected strings (your own new tests) and both banners follow; correct the record's sentence "cleanup never removes an unmanaged worktree".
> The rule 3 line for the four harness files stands as sent at 09:26:34 (the reviewer confirms: no assertion removed or changed; all four are harness changes), with file 4's per-case proof in the record.
> Then check:changed and READY; a NEW reviewer reads the fix round with this report in its brief.
>
> B. N4, A NEW ROW (C4: it decides what Storage Cleanup deletes): https://github.com/goat-si/goat/issues/3664. Cleanup removes a worktree anywhere under a managed root at any depth (storageCleanup.ts:238-246, :705-706), but restore accepts only exactly <root>/<repository>/<name> (worktreesDirectory.ts:219-227; ThreadWorkspaceService.ts:137-141), so a worktree at another depth can be cleaned and then never restored in place. N4 takes it after its current rows: cleanup keeps any worktree that isManagedWorktreeLocation rejects (the keep reason says why), with failing tests first for <root>/<name> and <root>/a/b/c, and unchanged behaviour for <root>/<repo>/<name>; and it says in its record what a person with an ALREADY cleaned worktree at such a path can do (where the snapshot is, whether anything in the product can apply it); if that needs a product decision, it comes to me. docs/user/project-settings.md:342 is checked against the result.

The review report is /Users/jun/handoff-in/chase/next2-CF1-review-fdfda957.md (relayed in full to this lane).

## Fix round (head 43f14b9a9cbb3bf62aa07e59725866b4852bff27, on fdfda95783)

| finding | GOAT commit | proof |
| --- | --- | --- |
| CF1-P2-1 (goat#3654) | `790b441234107f13696e8092fb2f1bc23461d12e` | cross-thread test failed first |
| CF1-P2-2 (goat#3513) | `bebae8a6f4514d5721409f049bb895d1685f6cd4` | two queued/aborted cases failed first |
| CF1-P3-5 (goat#3654) | `ecb68160e3ded84b523b6fa9cfe4503e27d47afd` | visual placement; phone capture owed |
| CF1-P3-3 (goat#3658) | `43f14b9a9cbb3bf62aa07e59725866b4852bff27` | helper test (own new test) failed first on the new wording; web capture retaken |

CF1-P2-1. The result keeps the thread it ran for: `showGitActionResult(result, thread)` (use-vcs-action-state.ts), passed by every caller in use-selected-thread-git-actions.ts. `useGitActionResultNotification(thread)` returns it only for that thread. `GitActionFailure` (the selected thread, or the thread it is given) and `useGitActionProgress` (the selected thread, read inside the hook so ThreadRouteScreen.tsx, at its 1124-line budget entry, is untouched) show it only there. A thread change clears nothing, so A's failure is still on A. A new action clears only its own thread's earlier result (`dismissGitActionResult(thread)`). The thread is a second argument, not a field of the result, so dev's existing "reports lookup failure" expectation in use-selected-thread-git-actions.test.ts, which compares the result object, is unchanged. Limit: there is still one result for the app, so when thread B's own action later finishes, B's result replaces A's unseen failure. The fail-first case in use-vcs-action-state.test.ts, "shows a thread's failure only on that thread, which another thread's new action leaves in place", failed on fdfda95783 with `expected [ 'error', null, null ] to deeply equal [ null, 'error', null ]`. The test file mocks ./use-thread-selection, which the hook now imports; that file is this lane's own. After: `vp test run src/state src/features/threads/git` in apps/mobile: 44 files, 338 tests passed; mobile typecheck exit 0.

CF1-P2-2. The window keeps the set of calls whose downloads are open (worker-rpc.ts, `ClientState.waits`). While it is not empty, every pending call's deadline is paused, and a call sent meanwhile starts paused. When the last wait ends, every pending call gets a fresh 30 seconds. A wait opened under a call that was later aborted stays in the set until the worker reports it ended, so a later paint waiting on the same face through the loads cache stays paused. The worker side and the message shape are unchanged. Fail-first on fdfda95783, worker-rpc.test.ts:
- "does not run for a call queued behind a font download, which gets 30 seconds once it ends": both calls `failed: "This document took too long to preview. Open it in another app."` (the queued call's deadline killed the worker).
- "keeps a later call paused while a download that an aborted call started is still open": the later call `failed: "This document took too long to preview. …"`.
After: `vp test run src/components/files/office` in apps/web: 11 files, 42 tests passed.

CF1-P3-5. The review screen (ReviewSheet.tsx) overlays `<GitActionFailure thread={{ environmentId, threadId }} />` at the top of its content, keyed to the reviewed thread. Its Git menu exists only when that thread is the selected one (useReviewHeaderPresentation.tsx:42-43), and the menu's failures are stored under it. That is nine lines; the file is 924 lines and has no budget entry.

CF1-P3-3. The helper now says "GOAT can't recreate it here. Put the folder back at <path>, or start in a new worktree." ("restore" for "cleaned"), true in every case where `recreatable` is false. The helper test's two strings changed with it. They are this lane's own new test; both failed on the old helper, then passed (5 passed). The server's send refusal on dev still says "it is outside GOAT's worktrees folder" (apps/server/src/orchestration-v2/goat/WorktreeSendCheck.ts:38) and is false in the same depth case. It is left as dev wrote it, for goat#3664 (N4).

Web capture after the rewording (this worktree's dev server, the same fixture):

![cf1-3658-web-after-outside-v2](https://raw.githubusercontent.com/goat-si/goat/940e6576a5f5a562ec01b0c4789e656a9f3f4819/3660/cf1-3658-web-after-outside-v2.png)

The earlier "after" capture above shows the first wording and is superseded by this one.

CF1-P3-1 (record only). No viewer shows the fonts message. What a person sees while a face downloads is the loading state for up to 30 seconds plus the face's size at 32 kB/s, about 6.5 minutes for the 11.6 MB face. In Word a family can wait twice that, because the last-resort loader (fonts.ts:25-26) always runs after the primary face. After that the preview opens with fallback fonts and no notice: every caller swallows the failure (slide-fonts.ts:56, sheet-fonts.ts:33, word-document.ts:374-377, and @betteroffice/docx 0.5.1's registry). Commit 7a18414c62's message and this record's goat#3513 section said the call fails with the fonts message; that is wrong, and the goat#3513 section above is corrected. Issue filed for a visible notice and the double wait: goat#3665 (https://github.com/goat-si/goat/issues/3665).

CF1-P3-2 (record only), known limit, also in #3660's body under "Known limits": the 3-second budget for an SVG picture covers decoding only. `createImageBitmap` draws on the window's main thread with no bound, and the timer cannot fire while a decode or draw holds the thread, so an SVG under 2 MB that is slow to draw can still freeze the window.

CF1-P3-4 (record only), residual risk for goat#3557: the server also refuses the bind while the live session still runs background agents, commands or monitors after the turn ended (apps/server/src/orchestration-v2/Orchestrator.ts:3092-3106, "The current session is still running background agents or commands…"). The phone does not check that, so in that case it creates the folder and branch and leaves them behind when the bind is refused, as on the base and as on the web.

## Checks on the fix-round head

- `vp run check:changed origin/chase/t3-261114-next2` on 43f14b9a9c (pen-macmini), exit 0: pass format, lint, knip 1/2, knip 2/2, graphql (apps/server), agent surface audit, agent context budget, typecheck (38 packages), test (22 files).
- The focused runs above; mobile typecheck exit 0.
- No existing dev expectation changed in the fix round. The test files it touched are this lane's own (use-vcs-action-state.test.ts, worker-rpc.test.ts, worktreeRetention.test.ts). Budgets: ThreadRouteScreen.tsx untouched; ReviewSheet.tsx 924 lines, no entry.

## Phone captures (owed, N15b after the merge), updated

goat#3658 the banner with the new wording (a missing folder outside GOAT's folder; one inside, unchanged); goat#3652 Usage dimming (cold open, before and after); goat#3557 the refusal with no new folder; goat#3654 the failure inside the Git sheet past 5 seconds and Dismiss, the same failure absent on another thread and still present on its own thread after switching back (CF1-P2-1), and the failure on the review screen after a failed Pull or push from its Git menu (CF1-P3-5).

NOT RUN (fix round): the phone captures above; goat#3513 on a throttled link; full CI (ci:full); the new review (the coordinator's).

## Coordinator answers, 10:07 (verbatim)

> Coordinator to lane coordinator, 2026-11-17 10:07:04 UTC (quote each part verbatim in the lane's record and in next2-pr-plan.md under "Coordinator answers").
>
> E. CF1: the fix round at 43f14b9a9c is checked on origin and its NEW review is running (Opus 5.5 xhigh, task goat-next2-CF1-fix-43f14b9a, with the first report in its brief). CF1 stands by. Its note on dev's send refusal text at WorktreeSendCheck.ts:38 ("outside GOAT's worktrees folder", false for the deeper-worktree case): YES, add it to N4's goat#3664 row: once cleanup keeps such worktrees the sentence is true again for new cases; N4 says in its record whether any already-cleaned case can still meet it and rewords it if so (its own rule 3 request if an existing test pins the text).
>
> F. goat#3665 (a notice when a font face fails; the double wait): noted, goes into the plan's CF1 follow-ups.

CF1 stands by at 43f14b9a9cbb3bf62aa07e59725866b4852bff27 for the new review's verdict; nothing pushed to the lane branch since.
