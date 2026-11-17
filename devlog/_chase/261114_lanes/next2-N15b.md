# N15b mobile parity (lane record)

Lane branch: `chase/t3-261114-next2-n15b-mobile`. Head at this record: `d8dd40a1663`, cut from the integration branch `chase/t3-261114-next2` at `ed4268897e3183341694f27e488232572d5c5151` (draft PR #3660). Host juns-MacBook-Pro (shared). C4 rows: O12 (L184, lockfile importer) and L420 (new server setting). Plain push, no force.

## Rows and commits

| row | GOAT commit | result |
| --- | --- | --- |
| L193 `65c0195b46` (O13 B) | `52e3efb966c` | startup hold (steady shells) and splash wait for cached shells; a disconnected environment is never held |
| L431 `5ceabb3fe8` | `1f80924db48` | a cold launch keeps the splash until Home's list has laid out the cached rows (same 1.5 s limit) |
| L184 `524a53183d` (O12 A, C4) | `ddeb0ede2ab` | unbash highlighting moves to client-runtime (`work-log/embedded-scripts`); mobile colors tool-call commands and their embedded scripts |
| L142 (`cb810db0cb`, mobile half) | `5be9913afb5` | the mobile commit sheet stays open and keeps the typed message until the commit succeeds |
| L143 (#3192 renderers) | `add0a467460` | MCP App initial color scheme and Claude insight callouts on mobile; ordered-list numbers and html_render galleries are follow-ups (below) |
| move-out | `a034638f180` | `useCompactComposerEditor` leaves ThreadComposer.tsx verbatim (budget room for L144) |
| L144 (#3177 check) | `f1626b1e2eb` | Stop pending state and repeat-tap guard on mobile; the other two #3177 items do not apply (below) |
| move-out | `b55563154a0` | verbatim moves out of CommandPalette.tsx, GitActionsControl.tsx, AddProjectScreen.tsx (budget room for L420) |
| L420 `dc032d7c8f` (C4) | `c30e93e4ab8` | offered source-control hosts: every host offered unless switched off; switches on web and mobile; docs/user |
| O5: L32 `55a94e2029`, `91a76cf5a6`; L413 `17a6a01d84` | none | skipped by the coordinator's ruling D (below); goat#3667 filed |
| goat#3495 | none | classified: separate issue (below) |
| goat#3496 | none | its own i18n fix, cause found (below) |
| A1 (Android commit sheet after a failure) | `cde4c238e5b` | the Android commit sheet keeps fixed detents, so its buttons stay on screen with the failure card and after Dismiss |
| L420 follow-up | `661675656f7` | the web Git actions control renders when the server config has no settings |

## Coordinator answers (verbatim)

> Coordinator to lane coordinator, 2026-11-17 10:07:04 UTC (quote each part verbatim in the lane's record and in next2-pr-plan.md under "Coordinator answers").
>
> D. N15b, O5: OPTION A. Skip the three upstream voice commits (55a94e2029, 91a76cf5a6, 17a6a01d84) with the reasons as found: no GOAT surface for the web Settings > Voice page and the voice dictionary; the mobile behaviour already equals upstream's with cloud declined. The record and the #3176 row say so with path:line for the GOAT equivalents (VoiceEnvironmentSettings.tsx:40-77, the composer voice button and VoiceModelDialog from #2562). This departs from the owner's "O5 B" on the facts; I tell the owner, and if he wants the reduced port it comes back as its own lane. N15b files ONE issue, "web: choose the microphone for dictation (upstream 55a94e2029's microphone order)", number to me.

> Coordinator (relayed by the lane coordinator, 2026-11-17): "THE PHONE CAPTURES CF1 owes (goat#3658 banner, goat#3652 Usage dimming, goat#3557 refusal, goat#3654 the message inside the Git sheet): N15b takes them on its own simulator and emulator after CF1 is merged into chase/t3-261114-next2 and N15b has merged that head; they are uploaded to #3660 and listed in CF1's record."

Filed: goat#3667, https://github.com/goat-si/goat/issues/3667.

## Rule 3

No expectation and no setup of an existing dev test changed. Where upstream added assertions to existing tests or changed their mocks, the lane carried them as new tests:

- useThreadListActions.test.ts: the two live-row undo cases (`it.each`), and "guards the live row when the list holds one from before the run started" (new). The upstream `holdingRows` mock state and its assertion inside "pinned thread operation permissions" were not taken; GOAT's `moveThread` already plans from the live rows.
- threadCommands.test.ts: "counts a row action for its own environment only" (new) instead of two lines inside "isolates environments and does not restore a remotely removed thread".
- useDecisionInbox.test.tsx renders HomeScreen without `visible`: the prop is optional (absent means on screen). The test file is unchanged.
- Tests moved verbatim with their file in L184 (embeddedScripts.test.ts from apps/web/src/lib, withEmbeddedScripts cases from HighlightedTokens.test.ts): only their imports changed. No moved title names "T3", so scripts/lib/goat-rename TEST_TITLES is unchanged.

## Budgets

Entries are at real length (countLines) after each commit, and none is above dev's entry: ThreadComposer.tsx 1269 -> 1144 -> 1150; CommandPalette.tsx 3058 -> 3040 -> 3048; GitActionsControl.tsx 2069 -> 1940 -> 1954; AddProjectScreen.tsx 1252 -> 1109 -> 1119. thread-work-log.tsx stays at its 1555 entry (L184 imports from the existing ReplCodeText line). The embeddedScripts non-null entry (10) moves with the file. Effect budgets follow the moved effects (ThreadComposer 6 -> 5, GitActionsControl 4 -> 3, CommandPalette 5 -> 4, plus new entries of 1 each for the three new files). contracts/settings.ts (entry 2052) is unchanged: the L420 field is in GOAT's own goatSettingsFields module.

## L193 and L431 (O13 B)

Reading of "take only the startup hold and shell caches (no rows for disconnected environments)": port upstream's steady shells (packages/client-runtime/src/state/steadyShells.ts), whose hold ends when the environment's server snapshot arrives, it is live, or it disconnects; and the splash wait (shellCachesReadAtom, apps/mobile/src/state/shell.ts). A disconnected environment is never held: its rows are its cached snapshot, as before. Mobile lists (Home, the sidebar through useNavigationThreadShells, the arrangement sheet) read the steady list; point reads keep the live snapshot.

GOAT differences: moveThread and the pending order already planned from the live thread list (useThreadListActions.ts, thread-order.ts), so no hold guard is added there; the arrangement sheet still disables moves while rows wait. Row actions look up the live row (liveThread). threadInbox's STALE_EXIT_MS (a run that ended long ago gets no return grace) comes with the row as part of the startup reshuffle.

Fail-first (implementation reverted, tests kept): 5 failed / 92 passed across steadyShells (suite missing), threadInbox "moves a thread whose run ended long ago at once, as after a reconnect", the two live-row undo cases, the live-row archive guard; and threadCommands "counts a row action..." failed with `h.commands.rowActionsAtom is not a function`. After: the five files pass (119 tests); every mobile test file that mocks state/threads or state/entities (53 files, 730 tests) passes.

L431 fail-first: home-launch-splash.test.ts could not load the module; after: 7 passed. The settle runs in GOAT's inline onReady/onStateChange (App.tsx).

## L184 (O12 A, C4)

The lockfile change is the importer only: `unbash: ^5.0.0` (5.0.0) moves from apps/web to packages/client-runtime, no new package or version. `vp i --frozen-lockfile` passed (manifests and lockfile agree). No wire, schema or server change, so older and newer clients and servers are unaffected; the only runtime difference is where web and mobile import the parser from.

Mobile: highlightCommand (apps/mobile/src/lib/highlights.ts) colors a command through GOAT's native highlighter and each embedded script with its own grammar; a missing grammar keeps the shell colors. The command block lives with ReplCodeText (GOAT split the REPL block out of thread-work-log earlier); its tokens use plain RN Text so they inherit the mono font, and iOS mono is "ui-monospace" (global.css). Fail-first: highlights.test.ts "colors a command's embedded script..." failed with `highlightCommand is not a function`; after: 13 passed; embeddedScripts and HighlightedTokens tests pass (60).

## L142

GitCommitSheet.tsx closed itself before the commit ran. Now it awaits the action and goes back only on success and only if it is still the focused screen. CF1's goat#3654 (GitActionFailure inside the sheet) is on another line of the same file and merges cleanly in a read of both diffs. Test GitCommitSheet.test.tsx (added to the mobile react test list): two of three failed before the fix ("keeps the sheet and the typed commit message when the commit fails", "leaves navigation alone when the person left the sheet before the commit finished"), all pass after.

## L143, decided per renderer

- MCP App initial color scheme (upstream ccc7b2d96f on web): mobile loads the app from mcpAppFrameUrl (packages/shared/src/mcpApp.ts), which carries goat-color-scheme the injected bootstrap reads before ui/initialize. String-built because React Native's URL cannot set params. Fail-first: `mcpAppFrameUrl is not a function`; after: passes.
- Claude insight callouts (upstream 2c74ea6915 on web): assistant replies show a "★ Insight ───" block as a quote headed "**★ Insight**" (apps/mobile/src/lib/markdownAssistantInsights.ts, applied in AssistantMarkdownBlocks.tsx). Detection is the shared plugin's, moved into rewriteAssistantInsights (packages/shared/src/markdownAssistantInsights.ts) so web and mobile use one rule; web's insight tests still pass (69). The native renderer labels GitHub alerts by type only ("Tip"), so a labelled quote is the closest match to web's "Insight" callout without a native change. Fail-first: module missing; after: 3 passed.
- Written ordered-list numbers in sent messages (d6d1763d41): not here. react-native-enriched-markdown numbers a list from its first marker; per-item numbers need a native renderer change (an N15a-class native build).
- html_render image gallery (415e1cabe6): not here. Mobile's HtmlRenderWebView has no image-open bridge at all (it loads the page top-level, so the bootstrap's iframe-only image click never posts); tapping an image opens nothing today, so there is no viewer to give a gallery.

## L144, the #3177 check on mobile

- Stop pending state and repeat-tap guard (cbc68c9dc1, 442b1db161): applies. ThreadComposer shows Resume in Stop's place the moment a run stops, so a double tap on Stop resumed it. useComposerStopGuard mirrors web's useComposerStopState: "Stopping agent" and no taps until the run stops (or 10 s, to allow a retry), and Resume ignores taps for 500 ms after the stop lands. Test useComposerStopGuard.test.tsx (fake timers): failed before (module missing), 2 passed after.
- Question answers past send blockers (d835e430db): already true. Mobile answers go through PendingUserInputCard's own Submit, disabled only by the response capability, an answer in progress and the operate scope (PendingUserInputCard.tsx:226); no turn-send blocker reaches it.
- Duplicate send after Undo (4cfcfaf2fd): does not apply. Mobile never moves a displaced typed answer into the thread draft (no counterpart of carryDisplacedCustomAnswerIntoPrompt).

## L420 (C4)

Coordinator decision 2026-11-15 (from the 10.025 card): every host offered unless its entry is false; a missing key or a server without the setting means every host offered and the switch disabled; SETTINGS_ACCESS agent; switches under Settings > Source control on web and mobile; docs/user.

- Contract: offeredSourceControlProviders, `Record<string, boolean>`, default `{}` (packages/contracts/src/offeredSourceControlProviders.ts, spread through goatSettingsFields.ts); patch is optionalKey and merges per host through deepMerge (test serverSettings.offeredSourceControlProviders.test.ts). Capability `offeredSourceControlProviders` (environment.ts), set by ServerEnvironment.ts.
- SETTINGS_ACCESS: `offeredSourceControlProviders: agent` (agent-surface tests pass).
- isSourceControlProviderOffered (packages/client-runtime/src/operations/projects.ts): `offered?.[kind] ?? true`; sortAddProjectProviderSources and getNewProjectPublishTargets filter by it.
- Pickers: web command palette Add Project and New project publish, web Publish Repository (a host turned off while the dialog is open is not kept selected), mobile Add Project and New project.
- Switches: web Settings > Source control, one per host row; mobile Source control > Project sources. Disabled without the write permission or without the server capability.
- Negative cases: an older server has no capability, so clients list every host and disable the switches (that server would drop the patch); an older client against a newer server ignores the field and lists every host, so a host hidden on the server still shows there (old behavior); a person without settings write permission sees the switches disabled, and the server refuses the patch for missing scope as for every settings write.
- Fail-first: projects.test "offers every host until one is turned off, also against a server without the setting" and the contracts decode test failed before; after, 52 tests pass with settings-access.
- Device: iOS, Settings > Source control > Project sources lists every host on; turning GitLab and Bitbucket off saved `{"gitlab": false, "bitbucket": false}` in the dev server's settings.json.

## goat#3495, goat#3496

- goat#3495 (held photo fails after reconnect): separate issue, stays open. The upload queue drops a request when its environment disconnects and re-adds it on reconnect; the first attempt after reconnect fails and a failed state is never retried by itself (apps/mobile/src/lib/composerAttachmentUploadQueue.ts:147, :169). Why that first attempt fails (an environment marked connected before its HTTP session is usable, or a transport error) needs a reproduction with a server restart and the failure reason; the fix (a bounded retry after reconnect, test first) is a state change of its own and is not an upstream parity row.
- goat#3496 (iOS Settings title English in Korean): its own i18n fix, not here (ruling 3). Reproduced on the lane head. The header iOS shows is the workspace root's: apps/mobile/src/features/workspace/WorkspaceRootScreen.tsx:60 and :157 set "Settings" as a fixed string, the other tab titles come from WORKSPACE_TAB_LABELS, and Stack.tsx:270 does the same for the stack. SettingsRouteScreen sets its title through SettingsScreen only on Android (SettingsRouteScreen.tsx:90); setting the stack title there changed nothing on screen (tried, reverted, no commit). Finding commented on goat#3496.

> Coordinator to lane coordinator, 2026-11-17 10:59:31 UTC (quote verbatim in CF1's and N15b's records).
> 1. CF1-P3-5 on the phone (the review screen's failure card is not reached after Push or Commit & push, because confirming returns to the thread screen, where the banner shows the failure): no person loses the message, so this does not reopen the lane. But code nobody can reach must not ship. CF1 (idle on pen-macmini, light work beside W1) answers from the code which Git actions of the review screen's menu KEEP the review screen open when they fail (Pull, Commit alone, create pull request, any other). If at least one does: keep the card, the record names those actions and says the others show on the thread banner; one Known limits line for #3660. If NONE does: remove the card in a small follow-up commit on a new branch from the integration head a6992a0f36 (the nine lines of ecb68160e3 and nothing else; its capture owed is then dropped from the list), with check:changed against the integration head. Either way the answer comes to me with path:line; I read a removal's diff myself and merge it.
> 2. N15b's captures: noted. The NOT captured ones stay owed with their reasons as written (goat#3658's outside-folder banner needs a seeded database; goat#3652 was not uploaded because the screens show real spend; VoiceOver has no Simulator). For goat#3652: a capture from the Replay provider's usage or with figures blurred is fine if N15b can stage a provider update; otherwise it stays owed to the next pass. N15b's hand-resolved hunk in apps/mobile/vite.config.ts (the jsdom list, both sides' lines kept) goes into its record with both sides and the result, as you asked.
> 3. goat#3496 (the iOS workspace root header hard-codes "Settings" at WorkspaceRootScreen.tsx:60 and :157, and Stack.tsx:270): agreed that it is its own i18n fix across every tab title. N15b adds its finding (the cause with path:line and the capture) to goat#3496 as a comment; the row stays in the plan for a later lane. goat#3495: N15b says where it stands in its next report.
> 4. The token order on juns-MacBook-Pro (N12's merge and check:changed, then N15b's Android emulator) is fine.

## Merges of the integration head

- `945c64df0f`: merge of bd3901fca9 (CF1). No conflict. Both-sides file GitCommitSheet.tsx: the merged sheet awaits the commit and closes only on success (GitCommitSheet.tsx:63, :69) and renders GitActionFailure (:108). Follow-up `8e4b30cdec` makes the L142 test also assert that the open sheet renders GitActionFailure (focused run: 3 passed).
- `d7a52a7a2b`: merge of b531d2511c (CF1F2-P3-1), with one hand resolution in apps/mobile/vite.config.ts, in the jsdom react test list after `"src/features/threads/git/GitBranchesSheet.test.tsx",`:
  - ours (lane): `"src/features/threads/git/GitCommitSheet.test.tsx",` and `"src/features/threads/useComposerStopGuard.test.tsx",`
  - theirs (integration): `"src/features/threads/GitActionProgressOverlay.test.tsx",`
  - base: neither line
  - result: all three lines, ours first, then theirs. GitActionProgressOverlay.test.tsx: 3 passed after the merge.
- `7eda32fd03`: merge of a6992a0f36 (S4). No conflict.
- `efba1f8cac`: merge of e9e20d52be (S4 follow-ups). No conflict; no mobile file in it.

## Device pass, iOS (N15b iPhone 17, 001CF105-B867-4FBB-A09A-E2B40C92D019, under the token)

Dev server on this worktree's .goat (empty database: the source is over 500 MiB), Replay (dev) provider, demo repository /private/tmp/n15b-demo with a refusing pre-commit hook. The Showcase transcript was edited locally for the captures only (an embedded python heredoc and an insight block), reverted afterwards, never committed. Captures, prefix https://raw.githubusercontent.com/goat-si/goat/9e180ae24af9b8a29a371b90259c861676298046/3660/ :

- L431: ios-l431-cold-launch.png (the cached row on the first screen after a cold launch).
- L420: ios-l420-project-sources.png (GitLab and Bitbucket off; the server saved `{"gitlab": false, "bitbucket": false}`); ios-l420-add-project.png (Add project lists neither).
- L184: ios-l184-command.png (python heredoc in its own colors, monospaced).
- L143: ios-l143-insight.png (quote headed "★ Insight"). The MCP App color scheme has no capture (needs an MCP App; tested in mcpApp.test.ts).
- L142: ios-l142-before-commit.png; ios-l142-cf1-3654-sheet-failure.png (refused commit: sheet open, typed message kept, failure inside the sheet).
- L144: ios-l144-after-stop-resume.png. The Replay interrupt lands in under a second, so the "Stopping agent" state was not caught; useComposerStopGuard.test.tsx proves the guard.

CF1's phone captures (iPhone):

- goat#3654: ios-cf1-3654-thread-banner.png, ios-cf1-3654-thread-banner-after-6s.png (still shown after 6 s), ios-cf1-3654-thread-banner-dismissed.png (the close button clears it); ios-l142-cf1-3654-sheet-failure.png (in the Git sheet), ios-cf1-3654-sheet-dismissed.png (Dismiss clears it); ios-cf1-3654-overview-sheet.png (in the Git overview sheet).
- goat#3557: ios-cf1-3557-refusal.png (Create worktree during a running Replay turn; the refusal shows in the sheet). `git worktree list` before and after: only `/private/tmp/n15b-demo bd05e43 [main]`; `git branch --list 'feature/*'` after: empty.
- CF1-P3-5 finding: confirming Push (or Commit & push) from the review screen's Git menu returns to the thread screen, so the failure shows on the thread banner and the review screen's failure card is never seen: ios-cf1-p3-5-review-push-returns-to-thread.png. Ruling 1 above.
- Owed (ruling 2): goat#3658 outside-folder banner (needs a seeded database); goat#3652 dimming (no provider update in flight on open or pull to refresh; the screens show real spend and were not uploaded); the VoiceOver escape (no VoiceOver in the Simulator).

goat#3496: ios-3496-before-settings-ko.png (Korean: rows translated, title "Settings").

## Coordinator answers, A1 (verbatim)

> Coordinator to lane coordinator, 2026-11-17 12:26:21 UTC (date -u), for N15b (quote verbatim in its record).
> FINDING A1 (Android: the commit sheet ends up shorter than its content after a failure card appears and is dismissed; buttons cut off): OPTION (a), fixed in this lane, as its own commit. It is #3660's own regression (L142 keeps the sheet open, CF1 puts the card in it), so it does not ship as a known limit.
> - Time box: 45 minutes of work including ONE emulator session, which starts after N12's 46-file run gives the token back; read the code and prepare the change meanwhile (light).
> - Where to look first, in this order: the sheet sizes itself once with fitToContents and is not told that its content grew; so (1) move the failure card out of the ScrollView into the sheet's fixed part, or (2) make the sheet measure again when the card appears and when it goes (the same thing the other Git sheets do, if one of them already grows correctly with its card on Android: say which do and which do not, all four sheets carry the card since CF1), or (3) a detent that does not depend on content for this sheet on Android. Take the smallest that shows right on the emulator; do not restyle the shared sheet component for one screen.
> - Proof: a visual bug, so before and after captures on Android are the proof (the two finding captures are the before; after: the card shown with every button visible, and after Dismiss every button visible, twice in a row), plus one iOS capture of the same sheet with the card to show iOS did not change. No UI test for it. Check the other three Git sheets on Android for the same shrinkage and capture any that has it; the same fix or a line in the record saying they are fine, with a capture.
> - FALLBACK if no fix shows right inside the box: on Android only, the commit sheet closes on a failed commit as it did before L142, so the failure shows on the thread screen's banner (which has its close button since bd3901fca9) and the typed message is kept if L142's draft keeping can do that without the sheet; say exactly what a person loses, and file one issue for the real fix. The cut-off buttons do not ship either way.
> - The Android half of CF1-P3-5 is closed as "no Git menu on the Android review screen" (useReviewHeaderPresentation.android.ts:10), so only the iOS capture is owed; say so in CF1's list.
> Then: merge e9e20d52be, check:changed against origin/chase/t3-261114-next2 (if its test step selects more than about 300 files, the 12:07:55 rule applies), the record, READY. The O5 departure (option A against the owner's recorded B) is with the owner; no answer yet, so READY states it as open.

## Device pass, Android (AVD n15b-pixel7, emulator-5554, Metro 8095, under the token)

Same dev server, Replay provider and demo repository as the iOS pass; the Showcase transcript edit was restored after the pass (worktree clean). Captures, prefix https://raw.githubusercontent.com/goat-si/goat/76dde4c4cf8709c247cb874612453cc2249eb880/3660/ (18 files, each HTTP 200):

- L431: android-l431-cold-launch.png (cached rows under "Reconnecting to jun's Mac" on a cold launch).
- L420: android-l420-project-sources.png (GitLab, GitCafe and Bitbucket off; the server's settings.json then held `offeredSourceControlProviders: {gitlab: false, bitbucket: false, gitcafe: false}`); android-l420-add-project.png (Add project lists none of the three).
- L184: android-l184-command.png. L143: android-l143-insight.png.
- L142: android-l142-before-commit.png; android-l142-cf1-3654-sheet-failure.png (refused commit: sheet open, typed message kept, failure in the sheet and in the overview behind it).
- L144: android-l144-after-stop-resume.png (the stopping state was not caught, as on iOS).

CF1's phone captures (Android):

- goat#3654: android-cf1-3654-thread-banner.png, android-cf1-3654-thread-banner-after-6s.png, android-cf1-3654-thread-banner-dismissed.png (the close button clears it); android-cf1-3654-sheet-dismissed.png; android-cf1-3654-overview-sheet.png.
- goat#3557: android-cf1-3557-refusal.png (Create worktree during a held Replay Question turn; the refusal shows in the sheet). `git worktree list` before and after: the same two entries (`/private/tmp/n15b-demo ffe2bc6 [main]`, `/private/tmp/n15b-outside-wt ffe2bc6 [n15b-outside]`); `git branch --list 'feature/*'` after: empty.
- goat#3652: android-cf1-3652-usage-settled-blurred.png, android-cf1-3652-usage-updating-blurred.png (the cost card dims under "Updating…" during pull to refresh; dollar figures blurred).
- CF1-P3-5, Android half: closed by the coordinator as "no Git menu on the Android review screen" (apps/mobile/src/features/review/useReviewHeaderPresentation.android.ts:10 returns `gitMenu: null`). Only the iOS capture (the card after a failed Pull or Commit alone off the default branch) is owed.
- Still owed: goat#3658 (needs a seeded database); the VoiceOver escape (iOS only; Android has no accessibilityEscape).

### Finding A1 (Android, visible; ruling above: option (a), fixed in this lane)

The commit sheet is a "fitToContents" sheet on Android (apps/mobile/src/features/threads/git/GitCommitSheet.tsx:90-93) and renders GitActionFailure inside its ScrollView (:108); L142 keeps the sheet open after a failed commit (:62-71), so the failure card appears while the sheet is open. The native sheet grows only about 48dp when the card appears and shrinks by the card's full height when it is dismissed, so each failure leaves the sheet shorter than its content: after one failure and Dismiss, "Commit changes" is half below the screen and "Commit on a new branch" is gone. iOS is unaffected. A one-line experiment (the ScrollView at shrink-0) changed nothing and was reverted. Before captures: android-finding-a1-sheet-failure-grows-short.png, android-finding-a1-after-dismiss-buttons-cut.png.

### A1 fixed: `cde4c238e5` (device session under the token, 12:33 to 13:00 UTC)

The Android commit sheet keeps its route's fixed detents (Stack.tsx formSheetDetents(0.8), so 0.8 and 0.92) and its ScrollView fills the sheet; the sheet no longer sets "fitToContents" (GitCommitSheet.tsx). iOS classes unchanged. Focused test GitCommitSheet.test.tsx: 3 passed. Proof (visual; no UI test, as ruled), prefix https://raw.githubusercontent.com/goat-si/goat/2847808d7aa7376c128d3a574f27501e1997bf94/3660/ :

- Before: android-finding-a1-sheet-failure-grows-short.png, android-finding-a1-after-dismiss-buttons-cut.png (prefix 76dde4c4cf above).
- After, twice in a row: android-a1-after-before-commit.png, android-a1-after-failure-1.png, android-a1-after-dismiss-1.png, android-a1-after-failure-2.png, android-a1-after-dismiss-2.png. Both buttons are visible with the card and after each Dismiss; the typed message stays.
- iOS unchanged: ios-a1-commit-sheet-card-unchanged.png (the commit sheet with the failure card, both buttons visible).

The other three Git sheets on Android:

- GitOverview: fixed detents (Stack.tsx GitOverview, formSheetDetents(0.55)); the card shows and every row stays reachable: android-cf1-3654-overview-sheet.png (prefix 76dde4c4cf).
- GitConfirm: replaces itself with the thread screen before it runs the action (GitConfirmSheet.tsx:70, :88), so no card appears while it is open; nothing to capture.
- GitBranches: fitToContents. With the card it grows to the maximum height and after Dismiss it returns to its natural height, so it does not have A1's shrinkage (android-branches-card-open.png, android-branches-dismissed.png, prefix f937e119d8bcb1cb1e2f1717926c451ffde17f83). Finding A2, not caused by this lane: its list does not scroll to the last branch on Android, with or without the card (adb swipes and agent-device scroll left the view where it was; the accessibility tree lists the branches below the screen). With the card showing, only the current branch is visible. Applying A1's fixed detents to it (tried, reverted, no commit) did not make it scroll. It needs its own issue; not filed yet (the coordinator's call).

CF1-P3-5, iOS capture (owed): a failed Commit alone, started from the review screen's Git menu (More > Commit) on feature/eat-half (not the default branch), stays on the review screen and shows the failure card there: ios-cf1-p3-5-review-commit-sheet-failure.png (the sheet after the refused commit), ios-cf1-p3-5-review-screen-card.png (the review screen's card after closing the sheet).

### GitActionsControl render fix: `661675656f`

The test files beside the lane's changed files (23 files) found that GitActionsControl.browser.test.tsx failed 3 of 3 on the lane head: "Cannot read properties of undefined (reading 'offeredSourceControlProviders')" at GitActionsControl.tsx:1905, from L420 (c30e93e4ab) reading serverConfig.settings without a guard while that test's config has no settings. Fix: `serverConfig?.settings?.offeredSourceControlProviders`. No test changed. After: 3 passed; the 23 files: 299 passed.

### Checks on `661675656f`

- check:changed against origin/chase/t3-261114-next2 would select 385 test files (70 changed files; the lockfile and package manifests from O12 select everything), so the 12:07:55 rule applied: the static half ran locally, the beside tests ran locally, and one goat-ci run carries the wide selection.
- Static half, the same commands check:changed runs: format (67 files) exit 0; lint (59 files) exit 0, one warning (packages/shared/src/markdownAssistantInsights.ts:86, no-this-in-exported-function); knip files and exports exit 0; agent surface audit and context budget exit 0; typecheck of the 42 affected packages: 42/42 successful (suggestions only).
- Tests beside the changed files: 23 files, 299 passed.
- goat-ci (workflow_dispatch, lane all) on 661675656f: https://github.com/goat-si/goat/actions/runs/44089104165 (queued when recorded).
- Merge `24f9c28fba`: merge of 308b3d11b8 (X1, N9a and their follow-ups). No conflict.

## Coordinator answers, 13:06:41 UTC (verbatim)

> Coordinator to lane coordinator, 2026-11-17 13:06:41 UTC (date -u), for N15b (quote verbatim in its record).
> 1. A1 (cde4c238e5): accepted as fixed on the captures you list (the card shown and dismissed twice with both buttons visible, the typed message kept; iOS unchanged). The CF1-P3-5 iOS capture is taken; CF1's owed list drops it.
> 2. FINDING A2 (Android: the Branches sheet's list does not scroll to its last branch): YES, N15b files ONE issue (body through --body-file) and sends the number; it is not fixed in this lane and becomes a row of next3's mobile follow-up. The issue says how "not caused by #3660" was established: reproduced on a build of dev or of the last nightly, or, if that was not checked, the words "not checked on dev" and the reasoning (the sheet's files unchanged by the lane: name them). Both captures in it.
> 3. 661675656f (GitActionsControl.tsx:1905, serverConfig?.settings?.offeredSourceControlProviders): one question before READY, because L420 is the C4 setting row: what does the control show WHILE serverConfig is undefined (before the config has loaded, or in an environment that has none)? If it then offers every provider, a person who turned GitLab or Bitbucket off sees them flash or can pick them until the config arrives. State what it shows with path:line; the safe side is to offer nothing that the setting could hide until the config is known, or to show exactly what it showed before L420 if that is provably the same thing. Add the one test that pins it (the undefined-config state), since the browser test only failed by accident of its harness. If the web has the same read elsewhere (Add project, project sources, mobile's equivalents), the same answer for each.
> 4. Checks as you ran them are accepted under the 12:07:55 rule; READY with run 44089104165's result, the answer to 3, and the O5 line stated as open (the owner has not answered).

- A2: goat#3680 (https://github.com/goat-si/goat/issues/3680), "not checked on dev", with the reasoning and both captures.
- 3: at 661675656f an unknown config offered every host in all six places, because `isSourceControlProviderOffered(undefined, kind)` returned true (projects.ts:155). Fixed in `d8dd40a166`: the pickers pass the server's settings (`SourceControlOfferSettings`), unknown settings offer nothing, and known settings offer every host unless switched off (an older server decodes the field as {}). The places: CommandPalette.tsx:997-999, :1057, :2002; GitActionsControl.tsx:277, :296, :1905; SourceControlSettings.tsx:552, :669; AddProjectScreen.tsx:145, :381, :648; SettingsServerControlsRouteScreen.tsx:589. While settings are unknown, Publish has no host and cannot submit (GitActionsControl.tsx:279, :325), and Add project lists only "Repository URL". Test first: "offers no host while the server's settings are not known, so a host turned off never shows" (projects.test.ts) failed before the fix ("expected true to be false") and passes after. The lane's own L420 test case changed with it (added by c30e93e4ab, not on dev); no dev test changed. CommandPalette.composition.browser.test.tsx (dev, unchanged) passes. The budgeted files stay at their entries. Focused tests: 4 files, 54 passed.
- Head `d8dd40a1663`. Pending under the token: typecheck, the beside tests rerun, and one goat-ci run on d8dd40a166 (run 44089104165 is on 661675656f and does not cover the shared helper change).
