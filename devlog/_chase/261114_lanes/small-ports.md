# Small ports (lane record)

Lane branch: `chase/t3-261114-small-ports`, based on origin/chase/t3-261114-all at `e943ef0c5f`, merged with the tip at 417eaf7fdb, 1275f975dd and 50b8ca19dd (lane head 077313a6c1). Bundle (b) of cycle 261114: five rows, one GOAT commit each, plus one budget refactor. Integration PR #3397 is the coordinator's.

Merged into #3397 at e87890ecf9 (2026-11-16): lane head 077313a6c1. Merged into #3397 at 1e67a275fc (2026-11-16): review follow-up, lane head b3d3c918ec.

## Rows

| card | upstream | decision | GOAT commit | summary |
| ---- | -------- | -------- | ----------- | ------- |
| #679 | `1d218d1525` | adapt | `9b068f4fd2` | feat(web): screen reader window title leads with the thread's status and name |
| #1016 | `6237824a2c` | adapt | `b824d48049` | fix(server): goat_thread_read results fit MCP clients' output limit |
| #301 | `c58f472a35` | adapt | `c41626ebb2` | fix(server): report failed preview navigation URLs |
| #377 (mobile) | `c7618f6c10` follow-up | adapt | `96cba8ddaf` | fix(mobile): a reply a steer cut off shows an interrupted badge |
| #862 | `c60aa1aaf9` remainder | adapt | `d97d14bfda` | fix(server): closing an unclaimed tab is reported as never sent |

`a1f14d2ce3` refactor(server): ServerBrowser reads load errors through one namespace import. It frees the lines row 5 needs in apps/server/src/preview/ServerBrowser.ts, which sits at its code budget.

## Decisions

- **1d218d1525.** Upstream puts `resolveWindowTitleThreadStatus` in apps/web/src/components/Sidebar.logic.ts, which is exactly at its budget (1722). It lives beside `resolveThreadListStatus` in packages/client-runtime/src/state/threadListPriority.ts instead, so mobile could reuse it. GOAT's status has more states than upstream's: `request` (a guest waiting) is cleared as upstream does, `limited` and `failed` give no status, and a run held behind another Codex turn (`isRunStartHeld`, runtime `starting`) reads as `waiting` and gives no status, since its runtime is not `running`. The title code is in GOAT's apps/web/src/documentTitle.ts (upstream: appInit.tsx). The switch joins the existing Activity section in Settings → General next to Screen reader announcements; upstream splits a new "Screen reader" section in its Chat page, which GOAT does not have. User docs: docs/user/activity-log.md, with "GOAT" for "T3 Code". The client setting is local to the browser or device and needs no SETTINGS_ACCESS entry (server settings only).
- **6237824a2c.** The predecessor's character budget was present (`THREAD_READ_BUDGET_CHARS` at apps/server/src/mcp/OrchestratorMcpService.ts:186 on the tip, keep-loop at :3573), so the row was portable. The byte budget and the oversized-item trim (`timelineItemsWithinBudget`, `timelineItemWithin`, `longestFitting`) live in apps/server/src/mcp/threadReadItems.ts beside `timelineItem`. The envelope GOAT measures is `{ thread, recentRuns, nextPosition, hasMore, earlierPosition }`; GOAT's `cloudTask`, `summaryDigest` and `tailStartPosition` are small and stay outside it, as they stayed outside the character budget. `pageIncludesTerminalTaskResult` now reads the returned items (`!textTruncated`). Upstream's `readPastEnd` guard and its integration case `long` came in the review follow-up (``ab6482146b``, below); the `paginated` case it replaces never existed in GOAT. The existing budget test and the new test share one `threadReadLayer` helper so OrchestratorMcpService.activity.test.ts stays under 1000 lines (986).
- **c58f472a35.** Status, snapshot and the tab list name the page that failed (`loadError.url`) instead of `chrome-error://chromewebdata/`. A navigate (or an open that reuses a tab) whose page commits Chromium's error page fails with "Navigation to <url> failed: <reason>", the URL without credentials, query or fragment. GOAT adaptation for a new tab: upstream closes it; GOAT keeps it open and names it (the coordinator's ruling after review: keep it, same contract as unloadedOpen.ts; the agent keeps a tab id it owns and can navigate again or close it, the tab counts against the per-agent limit of 8 and the server limit of 32, hidden server tabs are swept after 30 idle minutes, and before this port the case returned success with the tab open, so no tab is added) (`openedTabId`, the broker's `unloadedTab`), the contract apps/server/src/preview/unloadedOpen.ts already uses for an open whose page never connected (#2220). The check runs after load and only for `readiness` other than `none`, which GOAT does not wait on. Placement: `assertNavigationSucceeded`, `assertOpenedPageLoaded` and `reportedTabUrl` in apps/server/src/preview/serverBrowserLoadError.ts, a callback parameter on `guardedNavigate` (ServerBrowserNavigate.ts), and the scenario bodies in apps/server/src/preview/LoadErrorAssertions.testkit.ts, so ServerBrowser.ts (2699 of 2702) and ServerBrowser.test.ts (2610 of 2614) stay within budget. Upstream's separate test "preview_open rejects a desktop navigation that failed before automation attached" is folded into the end of "reports why a page failed to load while the tab shows the error page"; the desktop open needs `session: "profile"` in GOAT (otherwise GOAT closes the copy an older desktop opened).
- **c7618f6c10 mobile.** `assistantReplyStatusBadge` in packages/client-runtime/src/state/threadWorkflows.ts holds the rule both clients use: an interrupted reply shows its status wherever it sits in the turn, any other unfinished reply only in the closing meta row. Web (TimelineAssistantRows.tsx) behaves as before; mobile ThreadFeed.tsx shows the same chip, in the meta row or on its own row. It reads `projectedItem.item.status`, which mobile feed messages already carry. No test: a visual change over a two-branch rule (testing policy); the capture is owed to the device pass.
- **c60aa1aaf9 remainder.** The coordinator's placement: `{ beforeInput: true }` on the unclaimed-tab refusal (ServerBrowser.ts close path), as resolveDialog does. Upstream's `unclaimedTab` control reason is not added.

## Fail-first

- Row 1 (client-runtime threadListPriority.test.ts, web branding.logic.test.ts): `TypeError: resolveWindowTitleThreadStatus is not a function`; `AssertionError: expected 'Project / Thread' to be 'Working: Thread - Project'`. After: 4 files, 81 tests pass.
- Row 2 (apps/server/src/mcp/OrchestratorMcpService.activity.test.ts, "readThread keeps an activity page within an MCP client's output limit and pages the rest"): `AssertionError: expected 183016 to be less than or equal to 50000` (the first page, held back by one 60,000-char CJK title). After: activity, stoppedChildRead, childWork, OrchestratorMcpService and HostThreadsMcpService tests, 147 pass.
- Row 3 (apps/server/src/preview/ServerBrowser.test.ts): both load-error tests fail on `- "url": "https://device.local/"  + "url": "chrome-error://chromewebdata/"`. With the URL check loosened for one run, the navigate resolved with a status and the desktop open resolved with a status (no failure). After: ServerBrowser, unloadedOpen, ServerBrowserNavigate, blockedNavigation and PreviewAutomationBroker tests, 173 pass.
- Row 5 (UnclaimedTabAssertions.testkit.ts through "enforces provider ownership and explicit targets when a session has multiple tabs"): `- "possibleCommit": false, "writeStatus": "rejected_before_commit"  + "possibleCommit": true, "writeStatus": "may_have_applied"`, classified as the preview handler does. After: ServerBrowser, actionOutcomeSafety and PreviewAutomationBroker tests, 126 pass.
- Row 4: no test (visual).

## Gate

- `4bc768363b` (lane head after merging the tip at 1275f975dd; pen-mac-studio, juns-Mac-Studio.local, macOS 26.6.2, 16 cores, Node 26.12.1, load 9-10 during): PASS after triage. `set -o pipefail; vp run check:changed` exited 1 only at tests. Every static step passed: goat-rename 0, unused patches, format, both graphql checks, lint, agent context budget, agent surface audit, knip 1/2 and 2/2, typecheck of 42 packages. The changed set includes the lockfile and package manifests, so it ran the full suite: 3121 of 3133 files and 40697 of 40759 tests passed, 2h16m. The 22 failures are in four files, none touched by this lane:
  - packages/ssh/src/launchListenerScripts.test.ts (1): goat#3403.
  - packages/ssh/src/runtimeFactsScripts.test.ts (1): goat#3363.
  - apps/server/src/cli/app.test.ts (4, the relative cwd/flag/env/bootstrap cases): goat#3238. Three `serverCwd.fixture.ts start relative-*` children sat idle (0% CPU) for 3 to 16 minutes; I stopped only those PIDs (57888, 79575, 86977) after confirming each descends from the gate shell through check-changed, vitest and worker 57522. 57888 ignored SIGTERM and took SIGKILL.
  - apps/server/src/textGeneration/GrokTextGeneration.test.ts (16): goat#3425.
- `077313a6c1`, the lane head (merges the tip at 50b8ca19dd, 11 files, none of them this lane's: GOAT Bot web, docs/user/goat-bot.md, scripts/lib/goat-rename/rules-meta.ts): `node scripts/goat-rename.ts --check` 0; `vp test run scripts/lib/goat-rename` 12 files, 355 tests pass; `vp run typecheck` 42 of 42 packages; the lane's tests pass (client-runtime threadListPriority, threadActivityAnnouncement, threadWorkflows, web branding.logic, settingsSearch, contracts settings: 196; server OrchestratorMcpService.activity, ServerBrowser, unloadedOpen, ServerBrowserNavigate, actionOutcomeSafety, PreviewAutomationBroker: 140). The full suite was not rerun on this head.
- Earlier attempts, none counted: on `e943ef0c5f` typecheck failed on LoadErrorAssertions.testkit.ts (an `unknown` error channel and `JSON.stringify`, Effect diagnostics); on the first 417eaf7fdb merge typecheck failed on `Schema.UnknownFromJsonString` (absent from effect 4.0.5's published types) and knip 2/2 on three `threadReadItems.ts` exports nothing else imports. Each fix is squashed into its row's commit (row 3: `fromJsonString(Schema.Unknown)` and a generic error channel; row 2: `turnItemText`, `textPageEnd` and `timelineItem` are module-private). The run on `fcf6c82c24` was stopped for the 1275f975dd tip. No run showed the WorkspaceRootScreen.android.test.tsx failure the 417eaf7fdb fix covers; every run with tests was on a head that already had it.
- The lane moved or renamed no test file (LoadErrorAssertions.testkit.ts is new), so the goat-rename TEST_TITLES rule has nothing to update.

## Review follow-up (SP-P3-1 to SP-P3-5)

The review of `077313a6c1` was APPROVE WITH NITS (P3 only). The follow-up is new commits on top of it, merged with the tip at 9253116afa (lane head `b3d3c918ec`):

- `ab6482146b` fix(server): reading a long child result to its end acknowledges it (SP-P3-1). With the byte budget, a child reply over the budget but within maxCharsPerItem (GOAT default 20,000) is cut on the first page, and GOAT acknowledged a child result only on a textOffset 0 read, so the follow-on pages never acknowledged it and the parent could be woken again for a result it had read. The guard is now upstream's readPastEnd: the page that reaches the end of the text acknowledges, and only a read past the end does not. Upstream's integration case long (46,500 characters) is added; the projection query tracer and a page reader move to apps/server/src/mcp/OrchestratorMcpToolkit.threadRead.testkit.ts, so OrchestratorMcpToolkit.integration.test.ts goes from 1326 to 1321 of its 1326 entry. Fail-first on 077313a6c1: FAIL reports long child results, AssertionError: expected 'claimed' to be 'acknowledged' after reading every page; the other three cases pass.
- `7fd0a7bcb9` docs(orchestration-v2): docs/orchestration-v2/orchestrator-mcp-server.md says the budget is about 30,000 bytes of JSON and that an oversized item is cut and marked with textTruncated and nextTextOffset (SP-P3-3).
- SP-P3-5: the Settings captures under Surfaces, uploaded to #3397's assets.
- SP-P3-2, SP-P3-4 and the row 3 ruling: Known limits and Decisions.

Checks on b3d3c918ec (pen-mac-studio): goat_thread_read tests (OrchestratorMcpToolkit.integration incl. long, OrchestratorMcpService.activity, stoppedChildRead, childWork, OrchestratorMcpService, HostThreadsMcpService, HostThreadsMcpService.watch) 7 files, 165 tests pass; node scripts/goat-rename.ts --check 0; vp fmt --check and vp lint on the changed files exit 0; vp run typecheck 42 of 42 packages, 0 errors; agent surface audit --check and context-budget --check pass (no listing text changed). git diff origin/chase/t3-261114-all -- oxlint-plugin-goat/code-budgets.json is empty; OrchestratorMcpService.ts is 3965 of 4090 (3 lines shorter). No full gate (coordinator's call).

## Code budgets

`git diff origin/chase/t3-261114-all -- oxlint-plugin-goat/code-budgets.json` is empty. Files at or near their entry: apps/server/src/preview/ServerBrowser.ts 2699 of 2702, ServerBrowser.test.ts 2610 of 2614, apps/web/src/components/Sidebar.logic.ts untouched at 1722, apps/server/src/mcp/OrchestratorMcpService.ts 3968 of 4090, OrchestratorMcpService.activity.test.ts 986 (no entry, under 1000), packages/contracts/src/settings.ts 2052 of 2053.

## Agent surface

`vp run agent-surface:audit` leaves docs/internals/agent-surface-audit.md unchanged, and `context-budget --check` passes (ACP instructions 6,143 of 6,144 B, unchanged). The thread read result and preview errors keep their schemas; only texts and values change.

## Surfaces

- Entry points: the window-title switch is reachable from Settings → General and settings search (`screen-reader-window-title`). The window title follows the open thread on web and desktop (Electron uses `document.title`).
- Clients: row 1 is web and desktop; mobile has no window title. Row 4 is mobile, with web sharing the rule. Rows 2, 3 and 5 are server and reach agents through goat_thread_read and the preview tools.
- Providers: none of these rows is provider-shaped. Row 4's marker appears for any provider that marks a reply interrupted; today only Claude's steer path (28c4865c8a) does.
- Settings: `screenReaderWindowTitle` is a client setting (ClientSettingsSchema and its patch), with reset and restore-defaults.
- Reverse states: the switch turns off; when a turn ends only the status leaves the title.
- Connection modes: nothing mode-specific.
- Docs: docs/user/activity-log.md gains the window-title paragraph. The other rows change no documented behavior.
- Captures: the new switch in Settings → General → Activity, off and on, light and dark (browser harness with the app stylesheet, rendering the Activity section's two rows): https://raw.githubusercontent.com/goat-si/goat/f10fdf314a4d1e912362cc3e7f88972f77538e00/3397/sr-window-title-off-light.png, …/sr-window-title-on-light.png, …/sr-window-title-off-dark.png, …/sr-window-title-on-dark.png. The window title itself is document.title, which a page render does not show; branding.logic.test.ts and threadListPriority.test.ts cover it. Row 4: the mobile badge capture is owed to the final device pass.

## Known limits

- A run held behind another Codex turn shows no status in the window title (sidebar shows it as waiting).
- Row 3: a navigate with `readiness: "none"` is not checked, since GOAT returns before the page loads.
- Row 2 (SP-P3-2): the byte budget measures { thread, recentRuns, nextPosition, hasMore, earlierPosition } only. GOAT's cloudTask and summaryDigest, and the run's ThreadResult and replicaStatus that local reads add after the budget (apps/server/src/mcp/HostThreadsMcpService.ts:531, :553), are outside it. A ThreadResult can reach a 4,000-character summary, 20 PR URLs and 100 commits, so the worst case is over 30,000 bytes, though these fields are a few KB in practice. A read forwarded to an older host uses that host's character budget.
- Row 3: a desktop error tab an agent ignores stays in the person's Browser panel until someone closes it, because closeIdle skips desktop tabs (apps/server/src/preview/ServerBrowserCapacity.ts:63), as with unloadedOpen today.
- Row 1 (SP-P3-4): the new Settings row, its search entry and the status words (Working, Needs approval, Needs your input) are English only, like the neighbouring Screen reader announcements row. Translating both Activity rows goes to the next PR's web lane.

## NOT RUN

- Mobile capture of the interrupted badge (row 4): owed to the final device pass.
- A real-client pass (test-goat-app) for the settings switch.
- OrchestratorMcpToolkit.integration.test.ts on its own (no hunk ported there).
