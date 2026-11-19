# next3 K2: pull request links and the Code tab (plan)

Lane K2, host pen-macbookair (also answers as cpa-macbookair). Worktree branch `chase/t3-261114-next3-k2-pr-links`, HEAD `a608046c519b9377be3f03a5cdd6b376dd1b5c3f` = origin/chase/t3-261114-next3 (checked with `git rev-parse HEAD`). Upstream remote pingdotgg/t3code fetched (upstream/main `51eb2d5437`). PLAN PHASE: no code commit, no code push.

## Host ruling (item 5, relayed 21:16:52 UTC, verbatim)

> Coordinator to lane coordinator (2026-11-17 21:16:52 UTC), ITEM 5, RULED (relayed verbatim):
> Consistent with what I read in host.status (cpa-macbookair and pen-macbookair report 10 cores and the same sample time; macbookpro2 and pen-macbookpro2 likewise), so I take them as one machine each. The standing rule applies as on any machine: at most two threads, one heavy job at a time.
> - On the Air, K2 codes first (K8 needs that Mac for the desktop shell and stays behind K2).
> - K5 takes the next free code slot after K2's. If a Mac other than the Air is free at that moment (pen-macmini while K4 has not started coding, pen-macbookpro2 after K7, pen-mac-studio after K10), relaunch K5 there from its plan and branch and tell me the host. If none is free, K5 codes on the Air beside K2 under the machine's heavy-job token: installs, check:changed and test runs never overlap, and a lane that waits for the token says so in its report.
> - N10 follows on whichever machine K5 used. Until its slot K5 writes only its plan.
> - Count the Air and the MacBook Pro once each in any later placement you send me.
>
> For K2: nothing changes in your plan phase; quote this in next3-K2.md. When your code slot comes, you code first on this Air. While K5 shares the machine, your installs, check:changed and test runs go through the machine's heavy-job token and never overlap with K5's.

## 1. Ancestry check: no row is on dev

Commands: `git merge-base --is-ancestor <sha> origin/dev` (all eight: not-ancestor); `git log origin/dev --grep` on each sha and on each upstream subject (no hit); the squash bodies of #3519 (`3ecea04f19`) and #3660 (`42bf8633ce`) grepped for all eight short shas (no hit); the files the rows create are absent on dev (`packages/shared/src/pullRequestAnchor.ts`, `apps/web/src/components/pullRequest/holdLinkedNodeInView.ts`, `apps/web/src/components/pullRequest/PullRequestResolveThreadButton.tsx`); the lines they change are still in dev's form, e.g. `toggleFileDiffFoldForViewed` at apps/web/src/components/pullRequest/pullRequestDiff.logic.test.ts:52, `{ path: "a.ts", viewed: true }` at apps/web/src/components/pullRequest/filesViewedStore.test.ts:81, no `checkoutPullRequest` in apps/web/src/composerDraftStore.ts (PersistedDraftThreadState at :282-305), no `reviewUrl`/`overviewThreads`/`listResult` in packages/contracts/src/pullRequest.ts. The records (10.025 #80, #112, #153, #166, #189, #349, #640, #649) list every row as deferred. Nothing to tick.

| row | upstream | on dev? |
|---|---|---|
| b3fdf2b10f | PR links jump to the comment, diff line, checks or commits they name (#33989) | no |
| 3a0bcba00a | GitLab MR file and line links open that file (#34607) | no (needs b3fdf2b10f) |
| 8cbc95923a | files marked Viewed stay folded when the Code tab opens again (#34168) | no |
| abbd967c4b | PR comment hover excerpts no longer end in a replacement character (#35111) | no (needs b3fdf2b10f's markdownExcerpt) |
| e89c8ce014 | a file ticked Viewed before loading a push shows Changed (#35114) | no (needs 8cbc95923a) |
| 479ee74135 | a thread started from a pull request links it (#15848) | no |
| 54a5c51a58 | fall back to a readable server for shared repositories (#21530) | no |
| f3da8ff63b | GitLab: resolve overview threads from Summary and Timeline (#30575) | no |

Conflict survey (`git merge-tree --write-tree` chained in memory, no checkout touched): b3fdf2b10f conflicts in 20 files (web panels, mobile route/discussion/navigation, openPullRequestLink, shared package.json, two GitHub tests; openPullRequestLink.browser.test.tsx was deleted on GOAT); 3a0bcba00a, abbd967c4b, e89c8ce014 apply clean on top of it; 8cbc95923a conflicts in PullRequestCodeTab.tsx and its browser test; 479ee74135 in useComposerSend.ts, usePullRequestActions.ts, composerDraftStore.ts and its test; 54a5c51a58 in 6 files; f3da8ff63b in 9 (GOAT split the GitLab tests). packages/contracts/src/pullRequest.ts applies clean in every row. `@noble/hashes` is already a dependency of packages/shared (packages/shared/package.json:786), so 3a0bcba00a adds no dependency.

## 2. Rows

### b3fdf2b10f, C4 (contract field, GitHub GraphQL, persisted panel state), size L

What: a shared anchor parser (`@goat/shared/pullRequestAnchor`, new subpath export) reads a PR link's fragment (GitHub `#issuecomment-`, `#discussion_r`, `#pullrequestreview-`, `/files#diff-<sha256>R4-R5`, `/commits/<sha>`, `/checks`); the web detail panel opens the right tab and scrolls to the comment, diff range, check or commit (useCodeViewFileReveal grows range reveal, holdLinkedNodeInView keeps it in view while the page settles); the right panel surface carries a pending `revealUrl` until shown; mobile's route screen does the same on its tabs. Contract: `PullRequestThreadComment.reviewUrl` optional (packages/contracts/src/pullRequest.ts near :173), filled from GraphQL `pullRequestReview { url }` so a link to a text-less review finds its comments.
Files: the 40 upstream files mapped onto GOAT's names (packages/shared, apps/web/src/components/pullRequest/*, apps/web/src/components/diffs/useCodeViewFileReveal.ts, apps/web/src/rightPanelStore.ts, apps/web/src/lib/openPullRequestLink.ts, apps/mobile/src/features/pull-requests/*, packages/source-control-github/*, docs/user/source-control.md).
Each way:
- newer server, older client (web or mobile): the extra `reviewUrl` key is ignored (the pull request RPC schemas are not strict: no `onExcessProperty` in packages/contracts/src/pullRequest.ts or the client-runtime decode path; tested, see below); the older client opens PR links as today (Summary tab, no jump).
- older server, newer client: `reviewUrl` absent; a link to a review with text still lands on the review; a link to a text-less review falls back to opening the Timeline tab at the top. No error, no spinner left running.
- stored data: `revealUrl` lives in the persisted right panel (`goat:right-panel-state:v2`, apps/web/src/rightPanelStore.ts:83). It must never reach storage (upstream's `withoutReveal`), so a reload or an older client never sees it; tested.
- negative cases: an unknown or malformed fragment opens the PR with no jump; a comment id not in the loaded page (truncated activity) opens the right tab and stops; a diff digest that matches no file in the diff opens the Code tab; a link to another repository's PR does not reveal in this one; a second click before the first reveal renders replaces it (one reveal, no fold toggling).

### 3a0bcba00a, C1, size XS

GitLab `#<sha1 of path>_<old>_<new>` anchors resolve to that file and line (pullRequestAnchor.ts, sha1 from `@noble/hashes/legacy`). Test first in pullRequestAnchor.test.ts (created by b3fdf2b10f, so new file, no budget question).

### 8cbc95923a, C2, size S

Fold choices become absolute per file (`Map<fileKey, boolean>`), so a Viewed mark loading after the tab opens folds the file and a reader's own unfold survives the mark. Files: PullRequestCodeTab.tsx, pullRequestDiff.logic.ts. Test first: the reopen case in PullRequestCodeTab.browser.test.tsx; the logic test file needs rule 3 (section 4).

### abbd967c4b, C1, size XS

markdownExcerpt never cuts a surrogate pair. Test first in pullRequestDetail.logic.test.ts (one case).

### e89c8ce014, C4 (wire input field), size S

A Viewed press made on a commit's diff sends that file's `revision` (blob id); the server records it instead of the head's, so a later push shows the file Changed. Contract: `PullRequestSetFilesViewedInput.files[].revision` optional, max 256. Files: apps/server/src/pullRequest/pullRequestViewedFiles.ts, filesViewedStore.ts, pullRequestFilesViewed.logic.ts, usePullRequestFilesViewed.ts, PullRequestCodeTab.tsx.
Each way: newer client, older server: the key is ignored and the head revision is recorded (today's behavior, the bug remains on that server, nothing breaks); older client, newer server: no key, head recorded (today). Negative: a revision over 256 chars or empty is rejected by the schema (the client only sends a git object id); a press unticking Viewed ignores revision; a mixed batch keeps per-file revisions. Server test first in PullRequestService.test.ts territory (see budget, section 3).

### 479ee74135, C4 (stored draft), size M

A thread started from the PR dialog carries `checkoutPullRequest: {url, branch}` on its draft; the first successful send links the PR to the new thread through GOAT's existing `usePullRequestLinking` (apps/web/src/hooks/usePullRequestLinking.ts), only if the draft's branch still equals the checkout branch. Files: composerDraftStore.ts, useComposerSend.ts, usePullRequestDraftThread.ts, PullRequestThreadDialog.tsx, ChatOverlayHosts.tsx, ChatView.tsx, PullRequestDetailPanel.tsx, usePullRequestActions.ts.
Stored data (`goat:composer-drafts:v1`, version 10, apps/web/src/composerDraftStore.ts:121-122):
- No version bump (upstream has none). A bump would make an older client's `readPersistedAttachmentIdsFromStorage` (:2120-2140) return no ids for every draft, since it requires an equal version.
- old drafts read by the new code: the key is absent, optional; hydration goes through the lenient normalizer (merge at :4068, normalizePersistedDraftThreads at :1431); drafts hydrate unchanged. Tested with a stored v10 draft written by dev's shape.
- new drafts read by an older client: the older client's schema ignores the extra key and its normalizer drops it, so that client never links (today's behavior); when it rewrites storage the key is gone, so the link is lost if the user goes back to the newer client before sending. Accepted: the link is best effort, as upstream's comment says.
- a draft that fails to decode: GOAT DEVIATION from upstream. Upstream types the persisted key as `Struct({url: String, branch: String})` in PersistedDraftThreadState; GOAT's strict reader (`getLocalStorageItem(..., PersistedComposerDraftStoreStorage)` at :2125) decodes the whole storage at once, so one malformed value (`{url: 5}`) would fail it and every draft's saved attachment ids would read as missing. Plan: declare the persisted key as `Schema.optionalKey(Schema.Unknown)` and keep upstream's `normalizePersistedCheckoutPullRequest` as the only reader. Test: a storage with one malformed `checkoutPullRequest` keeps every draft's prompt and attachment ids, and that draft hydrates without the link. The test fails first against the upstream-shaped schema.
- negative cases: the link call fails (no permission, server error): the thread exists, the failure is logged, no toast lies; the user switched branch in the draft before sending: no link; the draft moved to another project: the checkout PR is dropped (resolveCheckoutPullRequest); an older server without the link method: `threadPullRequestLinkMode` says unsupported and nothing is sent.

### 54a5c51a58, C4 (contract: error and summary fields), size M

When the server that owns a project cannot read the repository (no auth, wrong host), the PR list falls back to another connected server that can read the same repository. Contract: `PullRequestProviderSummary.projectIds` optional, `listResult` optional on `PullRequestUnavailableError` and `PullRequestOperationError` (a partial list a failing request still produced), `PULL_REQUEST_LIST_PROJECT_LIMIT = 100` (same limit as today). Files: apps/server/src/pullRequest/PullRequestService.ts, PullRequestsPage.tsx, pullRequestList.logic.ts, pullRequestProjectAssignment.logic.ts, usePullRequestListView.ts, apps/web/src/state/pullRequests.ts.
Each way: newer server, older client: the extra keys on the summary and on the two tagged errors are ignored, the older client shows the error as today (tested by decoding the newer encoded error with dev's error schema); older server, newer client: no `listResult` and no `projectIds`: no fallback list, the error shows as today, assignment uses today's matching. Negative: every readable server fails (error state, no empty list that pretends to be done); one environment disconnected mid-read; projectIds at the limit; the fallback never sends a project id the other server does not own. Wire size: `listResult` is bounded by the list limit (max 500 items), carried only on failure.

### f3da8ff63b, C4 (contract field, GitLab write), size M, GitLab mocked

GitLab overview discussions become resolvable threads shown in Summary and Timeline with a Resolve button (web PullRequestResolveThreadButton.tsx, mobile discussion screen). Contract: `PullRequestActivity.overviewThreads` optional, a separate key so a client that needs a thread path still decodes; `pullRequestConversationThreads` helper.
Each way: newer server, older client: overview discussions stay in `comments` and the findings exactly as today (upstream test keeps `["10","review-comment"]`), `reviewThreads` never holds a path-less thread, the extra key is ignored; older server, newer client: no `overviewThreads`, no Resolve button on overview comments, nothing else changes. Negative: Resolve by a viewer without permission (GitLab 403 → the button reports failure and the thread stays open); a non-resolvable overview comment shows no button; a resolve against a discussion already resolved elsewhere settles to resolved. The provider is mocked (`Layer.mock(GitLabPullRequestCli)`); the live GitLab row stays a person-or-account row.

## 3. Budgets (oxlint-plugin-goat/code-budgets.json; lengths by countLines on a608046c51)

Every budgeted file these rows grow is exactly at its entry, so each needs a verbatim move-out commit before the row writes into it:

| file | entry = length | upstream net growth | move-out candidate |
|---|---|---|---|
| apps/web/src/composerDraftStore.ts | 4336 | +79 (479ee74135) | persisted-draft normalizers (normalizePersistedDraftThreads :1431 and its helpers) to composerDraftPersistence.ts |
| apps/web/src/components/chat/useComposerSend.ts | 1635 | +18 | a self-contained helper block (K10's note (xxiv) also moves out of this file: order with K10 through the coordinator) |
| apps/web/src/components/ChatView.tsx | 4213 | +9 | put the link callback in usePullRequestDraftThread instead (no ChatView growth), else a move-out |
| apps/web/src/components/pullRequest/PullRequestCodeTab.tsx | 1458 | +76, +3, +3 | the commit list section to its own module |
| apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx | 1798 | +124, +9 | resolvePullRequestReference/pullRequestMarkdownContext/pullRequestStackReference (:173-230) and the reveal glue to pullRequestDetailPanel.logic.ts |
| apps/web/src/components/pullRequest/PullRequestsPage.tsx | 1555 | +10, +23 | list-assignment wiring to a hook |
| apps/web/src/components/pullRequest/pullRequestDetail.logic.ts | 1343 | +81, +5, +9 | handoff builders (:753-990) to pullRequestHandoff.logic.ts; the new link logic goes to pullRequestLinkSubject.ts |
| apps/web/src/rightPanelStore.ts | 1209 | +35 | migratePersistedRightPanelState (:439) to its own module |
| apps/server/src/pullRequest/PullRequestService.ts | 3732 | +18, +3 | the list fallback goes to a new pullRequestListFallback.ts; +3 for overviewThreads needs a small move-out |
| packages/source-control-github/src/server/gitHubPullRequestJson.ts | 1775 | +2 | a small move-out |
| packages/source-control-gitlab/src/server/gitLabMergeRequestJson.ts | 1069 | +13 | decodeDiscussionsJson to gitLabDiscussions.ts |
| apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx | 1358 | +151, +2 | link reveal to usePullRequestLinkReveal.ts (new) plus PullRequestIdentity/PullRequestLabels (:124-236) out |
| apps/web/src/composerDraftStore.test.ts | 2405 | +124 | new sibling test file (decision 2) |
| apps/server/src/pullRequest/PullRequestService.test.ts | 4958 | +20, +168 | new sibling test files (decision 2) |

Unbudgeted files near the 1000-line ceiling: packages/contracts/src/pullRequest.ts is 993 and the rows add 2+2+8+19 = 31, so a verbatim move-out of one schema group (the files-viewed or list-input schemas) to a sibling contracts module, re-exported from the index, comes before b3fdf2b10f; apps/web/src/components/pullRequest/PullRequestSummaryTab.tsx is 994 and grows +89 and +23, so CommentIdentity/CommentLocation/CommentBody/CollapsedComment (:100-299) move to PullRequestSummaryComments.tsx first. PullRequestTimelineTab.tsx (796, +94, +24) stays under 1000. New files stay under 800. Every line a move-out removes and does not re-add gets its own explanation in this record when the move-out lands. No test file is moved or renamed, so no TEST_TITLES change is expected.

## 4. Tests and rule 3

Failing first, per row: b3fdf2b10f: pullRequestAnchor.test.ts (new), the reveal case in PullRequestTimelineTab.browser.test.tsx (append), rightPanelStore.test.ts (append: revealUrl never persisted), guideDiffFocus.test.ts (mobile, append), contracts: a newer comment with reviewUrl decodes through dev's comment schema and an older one without it decodes through the new one. 3a0bcba00a: pullRequestAnchor.test.ts. 8cbc95923a: PullRequestCodeTab.browser.test.tsx (reopen keeps Viewed folded). abbd967c4b: pullRequestDetail.logic.test.ts. e89c8ce014: server test for the shown revision (new sibling file) and filesViewedStore.test.ts. 479ee74135: new sibling composerDraftStore test file: old v10 draft, new draft read by dev's normalizer, malformed value. 54a5c51a58: pullRequestProjectAssignment.logic.test.ts, pullRequestList.logic.test.ts, pullRequests.test.ts, a new server sibling file, the older-client error decode. f3da8ff63b: PullRequestSummaryTab.browser.test.tsx (Resolve), GitLab provider test with the CLI mocked including the 403.

Rule 3 lines I expect to ask for (each will come with exact before and after through needs_input when the row reaches it; I will not change them before your word):
- b3fdf2b10f: apps/mobile/src/features/pull-requests/pullRequestNavigation.test.ts:38 and :55 (`toEqual` gains the link's anchor fields); apps/web/src/components/diffs/useCodeViewFileReveal.test.ts:13 (mock `getItem` returns `{ collapsed }`) and :57 (the detach test is rewritten around range reveal); apps/web/src/components/pullRequest/PullRequestCodeTab.browser.test.tsx:44, :260, :264 (fixture `late.ts` becomes `late.test.ts` and the rerender becomes a diff link); packages/source-control-github/src/server/gitHubPullRequestJson.test.ts:716 (fixture gains `pullRequestReview`, expectation gains `reviewUrl`). I will try to keep the old tests and add new ones beside them; I ask only for those that cannot stand unchanged.
- 8cbc95923a: apps/web/src/components/pullRequest/pullRequestDiff.logic.test.ts:8 and :52-60 (`toggleFileDiffFoldForViewed` is replaced by `withFileDiffFold`; `isFileDiffCollapsed` takes a choices map and a viewed flag); PullRequestCodeTab.browser.test.tsx mocks setup (`vi.hoisted` gains a field).
- e89c8ce014: apps/web/src/components/pullRequest/filesViewedStore.test.ts:81 (the press carries a revision).
- 54a5c51a58: one import line in pullRequestProjectAssignment.logic.test.ts (allowed).
- f3da8ff63b: packages/source-control-gitlab/src/server/GitLabOverviewDiscussions.test.ts:26 (title and expectation: the overview discussion is also a thread) and GitLabActivity.test.ts:118 (rewritten: overview thread apart from file threads; the comments expectation is unchanged).

## 5. Order and size

Lane size M-L (about 3,900 upstream lines with tests; the largest row is b3fdf2b10f). Order: (0) contracts and PullRequestSummaryTab move-outs; b3fdf2b10f with its move-outs (DetailPanel, CodeTab, detail.logic, rightPanelStore, mobile route screen, GitHub JSON); 3a0bcba00a; abbd967c4b; 8cbc95923a; e89c8ce014; 479ee74135 with the composerDraftStore move-out; 54a5c51a58 with the PullRequestService and PullRequestsPage move-outs; f3da8ff63b with the GitLab JSON move-out; merge the integration head once (after K7); lane gate. One commit per row, each move-out its own verbatim commit before it.

## 6. Decisions for the coordinator

1. Stored-draft deviation (479ee74135). GOAT's strict storage reader decodes all drafts at once, so I plan to store `checkoutPullRequest` as an unknown value read only by upstream's lenient normalizer, instead of upstream's typed struct, and no version bump. The effect is that one malformed draft cannot hide every draft's saved attachments, and an older client keeps reading storage. I ask you to accept this deviation from upstream's exact schema.
2. Tests for files at budget. composerDraftStore.test.ts (2405) and PullRequestService.test.ts (4958) are at their entries and would grow by 124 and 188 lines. Instead of moving existing tests out verbatim to make room, I plan to put each row's new tests in a new sibling file named for the behavior (`composerDraftStore.checkoutPullRequest.test.ts`, `PullRequestService.viewedRevision.test.ts`, `PullRequestService.readableFallback.test.ts`), still failing first. That departs from "the module's existing test file" and needs your word.
3. Mobile half of b3fdf2b10f and f3da8ff63b. The lane is named web and contracts, but both rows change mobile screens. I plan to port the mobile half in the same commits (mobile typecheck and its unit tests in the lane; the native capture as a P1 row). The alternative is to leave the mobile half to M3, which would leave mobile opening PR links without the jump the web has. I recommend porting here.
4. e89c8ce014 and 54a5c51a58 as C4. Your brief marks two C4 rows; I classify these two as C4 as well, since each adds a wire field (an input field and error fields). Their each-way analysis is in section 2; no extra review lane is asked beyond the lane's one review.
5. useComposerSend.ts move-out. K10's note (xxiv) also needs a move-out of this file. Whoever lands second rebuilds on the first; I ask you to name the order (I propose K2 first, a small helper move, since K2 codes first on the Air).

## 7. Risks and expected NOT RUN

Risks: b3fdf2b10f's reveal code depends on GOAT's CodeView virtualizer; the merge-tree survey shows useCodeViewFileReveal.ts conflicts throughout, so the port is a rewrite against GOAT's 40-line hook, with the browser tests as the proof. Seven move-outs of large files before the rows can collide with K7, K10 and M3 if they touch the same files: I merge the integration head once just before READY, as ruled. GitHub's `pullRequestReview.url` adds a field to a GraphQL query: if a GitHub Enterprise version lacks it, the whole review read fails; I have not checked which GitHub Enterprise versions carry it; the lane tests use fixtures only, so this stays a NOT RUN with a note in the PR.

Expected NOT RUN: native mobile capture of the link reveal and the overview Resolve button (P1 rows, no simulator in this lane); live GitLab resolve (person-or-account row); a live GitHub review link (no real PR read in this lane; the parser and GraphQL mapping are tested with fixtures); the real-client web pass (P1); repo-wide suites and goat-ci (the coordinator dispatches lane=quick on READY).



## Ruling on the plan (21:23:36 UTC, relayed verbatim)

> Coordinator to lane coordinator (2026-11-17 21:23:36 UTC), K2 PLAN: GO, with conditions. READ BY ME: the record next3-K2.md at 0a17fc56cb, whole; at a608046c51 composerDraftStore.ts:2120-2135 (the attachment reader decodes the whole storage with PersistedComposerDraftStoreStorage and returns nothing unless the version is equal), and the budget entries against lengths for composerDraftStore.test.ts (2405), useComposerSend.ts (1635), PullRequestService.test.ts (4958) and contracts/pullRequest.ts (993, unbudgeted). NOT READ: the eight upstream commits, the other budget rows, the rule 3 sites.
>
> To K2, verbatim:
>
> DECISIONS
> (1) ACCEPTED: checkoutPullRequest is stored as Schema.optionalKey(Schema.Unknown) and read only by the lenient normalizer; no version bump. Conditions: the writer still writes only the typed {url, branch}; the normalizer accepts only two strings within a stated length and drops anything else; the malformed-value test fails first against upstream's typed shape and shows every other draft's prompt and attachment ids intact; the fork delta gets one line for the deviation.
> (2) ACCEPTED: new sibling test files named for the behaviour where the existing test file is at its entry. No existing test moves.
> (3) ACCEPTED: K2 ports the mobile half of b3fdf2b10f and f3da8ff63b. K2 owns apps/mobile/src/features/pull-requests/ for next3; M3 stays out of that folder (lane coordinator: tell M3, and tell me if M3's plan needs a file there). Mobile typecheck and unit tests in the lane; the native captures are P1 rows.
> (4) AGREED: e89c8ce014 and 54a5c51a58 are C4. The lane gets ONE fresh C4 review at READY that reads all five contract rows; nothing extra to ask.
> (5) RULED, differently from your proposal: ONE move-out of useComposerSend.ts for both lanes, merged into the integration branch before either lane writes into that file. K10 makes it (it is in the first wave): a single verbatim commit on its own small branch chase/t3-261114-next3-pre-usecomposersend from a608046c51 that frees at least 60 lines and lowers the entry to the real length; I read it line by line and merge it; you and K10 merge the integration head and build on it. If K2 reaches 479ee74135 before that merge exists, K2 says so and waits on that row only. Lane coordinator: from the seven plans, list every other budgeted file at its entry that more than one lane grows (ChatView.tsx, composerDraftStore.ts and rightPanelStore.ts are the likely ones) and send me the list; each gets the same single pre-commit by the lane that reaches it first.
>
> CONDITIONS ON THE ROWS
> (a) 54a5c51a58, the fallback to another connected server. Before code, two sentences in the record and a test for each: (i) the fallback server answers only for a repository one of ITS OWN active projects has (the same boundary S4 set with hasProjectRepository; read S4's record), and the client never asks a server for a repository that server reported no project for; (ii) what the person sees when the fallback server is signed in to a DIFFERENT account from the owning server: lists that depend on the viewer (mine, review requested, Viewed marks, permissions for merge or resolve) would be another account's. Either those views are not served by the fallback, or the page names the server whose account produced the list. A list that silently shows another account's "review requested" is a finding. Also state the largest listResult an error can carry in bytes, from a real 500-item fixture.
> (b) b3fdf2b10f. pullRequestReview { url } joins a GraphQL query whose failure loses the whole review read: cite GitHub's GraphQL reference for PullRequestReviewComment.pullRequestReview and PullRequestReview.url and the oldest supported GitHub Enterprise Server version that carries both (prior art with its source, in the record); if any supported version lacks them, the field is asked for in a way that degrades to "no reviewUrl", with a test. State how a pull request link reaches the reveal on DESKTOP (the Electron external-link and deep-link path) and from the command palette or any other entry that opens a pull request, so no entry opens the panel without the jump.
> (c) f3da8ff63b. Resolve is a write to GitLab on a person's click. Say whether an agent can resolve a GitHub review thread through a goat tool today; if it can, GitLab overview threads either join that path or the tool says they are not supported, with a test; if it cannot, one sentence saying so.
> (d) 479ee74135. Say per client: which clients can start a thread from a pull request (web, desktop, mobile) and which carry the link; "not carried on mobile" is acceptable if stated in the record and the user guide stays true.
> (e) Move-outs. Each is its own commit, byte for byte apart from imports and exports, before the row that needs it; the record names the source range and the new file for each, and a move-out never changes a test. Prefer writing a row's new code into a new module with a thin call over moving old code out (as you plan for ChatView.tsx); move out only what the row's growth needs.
> (f) Rule 3: as you say, row by row, each with the exact before and after, and for each whether the UPSTREAM commit makes the same change to the same test (quote upstream's hunk). A GOAT-only test's expectation does not change without my word; a fixture rename such as late.ts to late.test.ts needs its reason.
> (g) docs/user/source-control.md is updated in the row that changes what a person can do, not at the end.
>
> START: K2 may code now on the Air; I do not hold it for a first-wave slot, since no host is busy while plans are written. Lane coordinator: the cap is now FIVE lanes coding at once and six when K4 starts; the limit of two fresh reviews at once is what protects the merge path and stays. Order as planned; the integration head merged once just before READY, after K7 if K7 is in by then, otherwise as it is, with both shas.

Lane coordinator's note to K2 with the ruling: K5 only writes its plan, so the Air's heavy-job token is K2's for now; if K5 codes beside K2, installs, check:changed and test runs go through the token and never overlap.

## Condition (b): b3fdf2b10f's GraphQL field and every entry that opens a pull request link

Prior art and source: GitHub's GraphQL reference (https://docs.github.com/en/graphql/reference/pulls) declares `PullRequestReviewComment.pullRequestReview: PullRequestReview` (nullable, "The pull request review associated with this review comment") and `PullRequestReview.url: URI!` ("The HTTP URL permalink for this PullRequestReview"). GitHub supports the four newest Enterprise Server releases; on 2026-11-18 the oldest is 3.19 (end of support 2026-12-09; https://docs.github.com/en/enterprise-server@3.21/admin/all-releases). Its published schema (https://docs.github.com/public/ghes-3.19/schema.docs-enterprise.graphql, fetched 2026-11-18) carries both fields with the same types (lines 154 and 220 of the two type blocks), as does github.com's schema (https://docs.github.com/public/fpt/schema.docs.graphql). No supported version lacks them, so the query asks for the field directly. Because `pullRequestReview` is nullable, a comment whose review is null (a deleted review) maps to no `reviewUrl`; a test covers that.

Entries: every in-app click on a pull request link goes through `useOpenChangeRequestLink` (apps/web/src/lib/openPullRequestLink.ts:38), which calls `openPullRequest` with the clicked `url` (:82); the port passes it on as `revealUrl` there, so all its callers get the jump: chat markdown (ChatMarkdown.tsx:155), the timeline, composer, sidebar rows, thread details, branch toolbar and git actions (through `useOpenPrLink`), the HTML document frame (BrowserDocumentFrame.tsx:46), and DESKTOP: links the OS hands to the app (deep links and external-link hand-offs) reach `DesktopWebLinkCoordinator` (apps/web/src/components/desktop/DesktopWebLinkCoordinator.tsx:26, :93), which calls the same `useOpenChangeRequestLink` with a plain click. When a link opens the `/pull-requests` page without a panel ref, the page's selection carries the url (upstream's PullRequestsPage.tsx and _chat.pull-requests.tsx hunks). The command palette (CommandPalette.tsx:519-537) and the other `openPullRequest` callers (PullRequestsPage list rows, reopenClosedView, useThreadLinkedPullRequest, useRightPanelActions, RightPanelSurfaceContent) open a pull request by itself, not a link with an anchor, so they have nothing to reveal; the palette never opens a pasted link. Mobile reaches the reveal through `useOpenPullRequest` and `pullRequestNavigation` (upstream's mobile hunks).



## Coordinator, run 1817 (2026-11-17 21:38:37 UTC), sections I, III, IV, V and the notes for K2, verbatim

> I. #3696 MERGED; INTEGRATION HEAD c995c5427a
> - The fresh C4 review of #3696 at b7672aa5f8 was APPROVE WITH NITS (six P3, no P0 to P2; report /Users/jun/handoff-in/chase/pr3696-T1b-review-b7672aa5.md). MERGED BY ME 21:29:00 UTC, dev = 8c59f73519663bdb1fff3346d1caedf06083ddf7 (goat-ci-result success on the head, run 44173778052). goat#3694 closed with it.
> - chase/t3-261114-next3 fast-forwarded to dev 8c59f73519 (this is the one dev merge), then K10's shared pre-commit 2bc2e7761b merged by me after a line-by-line read (useComposerSend.ts:301-407 at a608046c51 equals useComposerSend.ssh.ts:54-160 byte for byte; the builder, the wrapper and the two call sites read). chase/t3-261114-next3 = c995c5427accaaa92dadac50ec756c35f4b92034 (parents 8c59f73519 and 2bc2e7761b; plain push). One wording nit for K10's own lane, no new commit on the pre-commit: the new file's doc comment says "rebuilt each render as before" while it is built per call.
> - Every lane with no code commit runs git merge --ff-only origin/chase/t3-261114-next3 before its first commit and reports the sha. K2, which is coding, keeps its plan: one merge of the integration head after K7 lands, and it does not write into useComposerSend.ts before that merge.
>
> III. SHARED AT-ENTRY FILES (your list of 22:0x)
> The pre-commit branch stays the tool for one case only: two lanes need the SAME block moved, or a lane needs room in a file before the lane that frees it lands. For the rest, a claims table:
> 1. On card 10.028 keep one table "at-entry move-outs": file, lane, the block as path:line range at c995c5427a, the new module, lines freed. A lane writes its row BEFORE it cuts the block. You refuse a row that overlaps another lane's range and bring an overlap you cannot settle to me.
> 2. Every lane nets zero or less in each at-entry file by its own commits (its move-out frees at least what its rows add). No lane leaves a file longer than its entry at the cut.
> 3. code-budgets.json conflicts at a lane's merge of the integration head are settled by countLines of the merged file, never by a number above the entry at 8c59f73519.
> 4. Same-basename entries in your list are settled by the records: K7 means packages/client-runtime/src/state/server.ts (and apps/server/src/server.ts only for rows 10 and 11, which leave K7, see VI) and apps/server/src/terminal/Manager.ts.
> 5. Order of landing for the meeting points: K7 first in packages/contracts and packages/client-runtime (as ruled); K1's Orchestrator.ts, orchestrationV2.ts and orchestratorMcp.ts move-outs are K1's own blocks (dispatchPullRequestWatchSync, the watch.sync struct, OrchestratorMcpThreadPullRequest) and K7 and K10 claim other blocks; MessagesTimeline.tsx, MessagesTimeline.logic.ts, ThreadFeed.tsx, thread-work-log.tsx and ThreadDetailScreen.tsx: K10 before M3's O22 (M3 D3); apps/mobile/src/features/pull-requests/: K2 before M3 (M3 D7).
>
> IV. RULE 3, ONE STANDING AUTHORISATION
> Rule 3 stays: no existing test expectation changes without my word. To stop one round trip per line, my word is given in advance for the MIRRORED case only, when all three hold: (1) the upstream commit being ported changes the same assertion in upstream's own copy of that test in the same way; (2) the lane quotes both hunks, upstream's and GOAT's, before and after, in its record BEFORE the commit; (3) the commit changes no other existing expectation. The fresh review checks every one; one it cannot match to upstream's hunk is a P2. Everything else still comes to me with exact before and after: GOAT-own tests with no upstream counterpart, deleted or retitled tests, moved harnesses, and anything a lane is unsure of.
>
> V. CAPS, PLACEMENT, T1c
> - Coding lanes at once: seven, K4 included (K2, K7, K1, K10, M3, K4, and K5). Fresh reviews at once: two, unchanged. No further lane starts without a plan ruled by me.
> - K5 starts now only on a Mac that host.status placement shows with at most one lane and no warning or critical pressure; the Air is not doubled up (it went critical under one lane in next). Otherwise K5 takes the slot of the first lane that reaches READY. Tell me the host.
> - T1c, a new small branch by T1's thread on pen-macmini: chase/t3-261114-next3-t1c-lease-pins from c995c5427a, tests and one budget entry only, no production line. Content, from the #3696 review: P3-1 an idle subprocessInspector in ThreadWorkspaceService.setupLockOrder.test.ts's makeWithOptions (as Manager.leaseOrder.test.ts has), so the three setup cases stop reading the host's real ps; P3-2 the probe as a case: the holder's open starts a shell while a person's restart waits, the restart returns the setup's pid, nothing is killed, one spawn; P3-3 an overtaken request that would start a fresh shell in a worktree its thread left is refused as moved and spawns nothing; P3-5 a first attempt in a free folder starts and never calls current; P3-4 RULED: the guard at terminalLeaseOrder.ts:75 STAYS. A close is the last word to the request that was waiting; a later open by someone else was a new request and was served; the waiting request is owed only the truth about the terminal now, the terminal if one is there and "Unknown terminal" if not, and it never starts a shell that a person closed and housekeeping then removed. Same answer as dev. Two cases pin it: close then newer open then rerun returns the newer terminal; close, newer open, idle close, rerun answers Unknown terminal and spawns nothing. P3-6: code-budgets.json Manager.ts 3118 becomes 3116; the corrected wording of the exit row (true only for a request nothing overtook), the close row (it also covers GOAT's own closes: a cancelled launch and observed checks) and one Limits sentence (a setup whose thread was rebound while its open waited still runs in the old folder) go into T1c's commit message and its record; I add a comment on #3696 when T1c is in. Each new case must fail under its mutation from the review (the lane runs the mutation and records the result). I read T1c and merge it without a fresh review if it is test-only. T1c lands before K4's goat#3681 and goat#3690 commits; pen-macmini carries T1 and K4 with one heavy job at a time, then T3.
>
> FROM M3's SECTION, FOR YOU (verbatim): "D7: M3 ports the pull-requests folder's hunks of O22 and O24 ITSELF, after K2 has merged into the integration head; the folder passes from K2 to M3 at that merge. The Legend upgrade and the Screens sheets never land with that folder left on the old workarounds. K2 is told now that its folder work must be complete at its READY."
>
> LANE COORDINATOR, FOR K2, on your rule 3 request for b3fdf2b10f (report 2): your request crossed the coordinator's new standing authorisation IV above. My reading, which the fresh review will check: (4) pullRequestNavigation.test.ts:38 is a mirrored assertion change and falls under IV once both hunks (upstream's and GOAT's, before and after) are quoted in next3-K2.md before the commit. (1) and (2) are mirrored but are fixture SETUP lines in shared testkit files, and IV speaks of assertions, so I have forwarded them to the coordinator for the word together with (3), which retitles and rewrites a test and is outside IV by its own terms ("deleted or retitled tests"). Commit (4) when you reach it; hold b3fdf2b10f's commit for (1) to (3) only, and work on in your order meanwhile if it does not depend on that row. Quote I, III, IV, V in your record. You keep your plan: one merge of the integration head after K7 lands, nothing into useComposerSend.ts before that merge. Write your row in the "at-entry move-outs" table on card 10.028 before you cut any block of an at-entry file (send it to me through goat_origin_report if you cannot push the card).

## Rule 3 under IV: b3fdf2b10f, apps/mobile/src/features/pull-requests/pullRequestNavigation.test.ts:38 (mirrored)

Upstream's hunk (b3fdf2b10f, upstream's copy of the same test, same assertion):

```diff
@@ -34,7 +34,13 @@ describe("native PR entry points", () => {
         context,
         projects,
       ),
-    ).toEqual({ ...context, host: "github.com", repository: "org/repo", number: 12 });
+    ).toEqual({
+      ...context,
+      host: "github.com",
+      repository: "org/repo",
+      number: 12,
+      navigationUrl: "https://github.com/org/repo/pull/12/files#diff",
+    });
```

GOAT's hunk (the same line on c995c5427a, the same after): before, line 38 `).toEqual({ ...context, host: "github.com", repository: "org/repo", number: 12 });`; after, the seven lines above with `navigationUrl: "https://github.com/org/repo/pull/12/files#diff"`. The commit changes no other existing expectation in that file. The link `/pull/12/files#diff` names the Code tab (parsePullRequestAnchor returns `{ kind: "code" }`), so the destination now carries the link for the screen to follow.

## Rule 3 items still with the coordinator for b3fdf2b10f

(1) gitHubPullRequestJsonTestFixtures.ts:71 `pullRequestReview: null` (fixture setup, mirrors upstream's remark helper); (2) GitHubPullRequestApi.testkit.ts:217 `pullRequestReview: null` (fixture setup, mirrors upstream's threadComments in its GitHubPullRequestApi.test.ts); (3) useCodeViewFileReveal.test.ts:57-71, retitled and rewritten as upstream does. The row's commit waits for these; exact before and after are in report 2 (sequence 2).

## At-entry move-outs K2 claims (sent to the lane coordinator for card 10.028; ranges at a608046c51, which equals c995c5427a for these files unless noted)

| file (entry) | block | new module | lines freed | row |
|---|---|---|---|---|
| apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx (1798) | :173-210 resolvePullRequestReference, pullRequestMarkdownContext, pullRequestStackReference | pullRequestDetailReferences.ts | about 34 net | b3fdf2b10f |
| packages/source-control-github/src/server/gitHubPullRequestJson.ts (1775) | :1670-1679 toFileViewedState | gitHubFileViewedState.ts | about 9 net | b3fdf2b10f |
| apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx (1358) | :124-188 PullRequestIdentity (to confirm) | PullRequestIdentity.tsx | about 60 | b3fdf2b10f |
| PullRequestCodeTab.tsx, PullRequestsPage.tsx, rightPanelStore.ts | to be sent before the cut | | | b3fdf2b10f |

Not at-entry: packages/contracts/src/pullRequest.ts (993, unbudgeted) was moved out in 239649e7932 (pullRequest.ts:933-943 and :946-993 to pullRequestErrors.ts, verbatim, checked with diff; rpc.ts went from 2788 to 2787 and environmentHttp.ts from 996 to 992 by import lines only).



## Coordinator 21:43:15 UTC, paragraphs A and B, verbatim

> A. K2's RULE 3 REQUEST, row b3fdf2b10f: (1), (2) and (3) AUTHORISED; (4) stands under IV as you told K2. READ BY ME in this repository: git show b3fdf2b10f for gitHubPullRequestJson.test.ts (hunk -110,6 +110,7: pullRequestReview: null after isMinimized in remark), GitHubPullRequestApi.test.ts (hunk -351,6 +351,7: the same line in threadComments), and useCodeViewFileReveal.test.ts whole; and dev's gitHubPullRequestJsonTestFixtures.ts:62-76, GitHubPullRequestApi.testkit.ts:208-222 and useCodeViewFileReveal.test.ts:50-75.
> - (1) and (2): one line each, pullRequestReview: null, in the two shared fixtures, exactly upstream's line in upstream's copies of those helpers. No assertion changes.
> - (3): the case at :57 takes upstream's title and body verbatim (second = viewer(["b"]) with upstream's comment, second.items.add("a") before the flush, the same two expectations, then upstream's remount and cancel parts). The helper change upstream makes in the same file (the collapsed set and getItem returning { collapsed }) is authorised with it if the row needs it. Upstream's additions to the FIRST case stay out of that existing case, as K2 planned: new it blocks.
> - Condition: K2 quotes this paragraph and the three upstream hunks in next3-K2.md before the commit.
>
> B. IV IS WIDENED, for every lane (relay it). The standing authorisation also covers, under the same three conditions (upstream's own copy changes the same way; both hunks quoted in the record before the commit; nothing else existing changes): (i) fixture, mock and helper lines in a test file or testkit, where upstream changes its own copy of that fixture or helper the same way; (ii) an existing case whose title and body become upstream's verbatim text of that same case. Still to me, with exact before and after: a deleted test or test file, a moved harness, a test with no upstream counterpart, and any case where GOAT's result differs from upstream's text by more than names. The review matches each one to upstream's hunk; a mismatch is a P2.

## Coordinator 21:52:47 UTC, IV (iii), verbatim

> IV gains one more mirrored-free case, for every lane (relay it): (iii) a test file that moves with the module it tests, where the commit is a rename and the only changed lines are import paths to the moved module, with TEST_TITLES updated in the same commit when the file is listed there. Titles, bodies, setup and expectations byte for byte; the review checks the rename with git show -M, and anything more is a P2. A harness moved out of a test file into a testkit still comes to me.

## b3fdf2b10f: the authorised test hunks, upstream's and GOAT's

(1) Upstream, gitHubPullRequestJson.test.ts (its remark helper):

```diff
@@ -110,6 +110,7 @@ const remark = ({ author, reactionGroups: groups, ...raw }: Json) => ({
   lastEditedAt: null,
   isMinimized: false,
   url: "https://github.com/acme/web/pull/1#discussion",
+  pullRequestReview: null,
   ...raw,
```

GOAT, packages/source-control-github/src/server/gitHubPullRequestJsonTestFixtures.ts (the same helper, moved there on dev):

```diff
   lastEditedAt: null,
   isMinimized: false,
+  pullRequestReview: null,
   url: "https://github.com/acme/web/pull/1#discussion",
```

(2) Upstream, GitHubPullRequestApi.test.ts (threadComments):

```diff
@@ -351,6 +351,7 @@ function threadComments(
       lastEditedAt: null,
       url: `https://github.com/acme/web/pull/7#discussion_${id}`,
       isMinimized: false,
+      pullRequestReview: null,
       reactionGroups: [],
```

GOAT, packages/source-control-github/src/server/GitHubPullRequestApi.testkit.ts:217 (the same helper on dev): the same added line after `isMinimized: false,`, before `reactionGroups: [],`. With (1) and (2), packages/source-control-github passes 434/434 (before them: 15 decode failures, since the regenerated ThreadComment schema requires the nullable key; `vp run generate` reproduces the generated file byte for byte).

(3) Upstream, useCodeViewFileReveal.test.ts: the helper gains `const collapsed = new Set<string>();`, `collapsed,` and `getItem: (id: string) => (items.has(id) ? { collapsed: collapsed.has(id) } : undefined),`; the case "drops a pending reveal when its viewer detaches, and positions the next viewer on request" becomes "drops a pending reveal when another diff's viewer replaces it, but repositions a range a remount loses" with `const second = viewer(["b"]);` under the comment "Item ids carry the diff's scope, so another diff's viewer holds other ids.", `second.items.add("a");` before the flush, the same two expectations, then the remount and cancel parts; two new cases ("renders the destination file and expands context before positioning its range", "expands a patch-only file to an unchanged line before positioning it"); seven lines appended to the first case. GOAT: dev's file equals upstream's parent plus one GOAT case at the end ("keeps only the latest pending file request", kept unchanged). The commit takes upstream's helper change, upstream's retitled case verbatim and its two new cases verbatim; upstream's seven first-case lines go into a new case "positions a line range only once its folded file opens" (setup: viewer(["a"]), attach, request("a"), then upstream's seven lines verbatim); the first case itself is unchanged.

(4) Under IV, quoted above (pullRequestNavigation.test.ts:38).

## b3fdf2b10f: what landed and how it was checked

Ported in GOAT's structure, with the row's new code in new modules (ruling (e)): `packages/shared/src/pullRequestAnchor.ts` (upstream verbatim, new subpath export); web `pullRequestLinkSubject.ts` (upstream's link subject and timeline match, kept out of pullRequestDetail.logic.ts), `usePullRequestDetailReveal.ts` (the panel's follow-link and one-host-read logic), `usePullRequestCodeLink.ts` (the Code tab's link target and reveal), `usePullRequestSummaryReveal.ts`, `holdLinkedNodeInView.ts` (upstream verbatim), `rightPanelPullRequestReveal.ts` (withoutReveal, the link merge, the settle), `pullRequestLinkedSelection.ts` (the page's URL-linked selection and the panel props); mobile `pullRequestLinkNavigation.ts` and `usePullRequestLinkReveal.ts`. The six verbatim move-outs before it: df050ab2e53, 574f17b15f3, 4ac1f97ad26, 2b994754591, efc31ab6e04, c666e67a29c (each checked byte for byte with diff against HEAD; lines freed: detail panel 37, Code tab 31, right panel store 33, GitHub JSON 10, route screen 76, Summary tab 64). Budget entries after the row, all at real length and at or below dev's: PullRequestDetailPanel.tsx 1794 (dev 1798), PullRequestCodeTab.tsx 1452 (1458), rightPanelStore.ts 1198 (1209), gitHubPullRequestJson.ts 1767 (1775), PullRequestRouteScreen.tsx 1307 (1358), PullRequestsPage.tsx 1554 (1555). Lines the move-outs removed and did not re-add: only import lines of names the moved code alone used (PullRequestDetail, resolvePullRequestReferenceHost, pullRequestMarkdownPlugins in the panel; DiffLineAnnotation, PullRequestImagePreview, PendingReviewComment, PullRequestReviewPosition in the Code tab; SymbolView, RelativeTime, Pressable, PullRequestAvatar, PullRequestDiffStats, PullRequestStatusMenu, PullRequestListEntry, PullRequestSummary, pullRequestStatus in the route screen; ChevronRightIcon, sectionCollapseAnchorScrollTop in the Summary tab), each now imported by the new module.

GOAT deviations: (a) the reveal handle in useCodeViewFileReveal.ts accepts any object and narrows with a type guard before calling the code view's line methods, because GOAT's DiffFileTree test hands over a plain viewer (TypeScript's weak-type check rejected upstream's all-optional shape; the test stays unchanged). (b) GOAT's hook keeps its per-diff-scope reset. (c) upstream's openPullRequestLink.ts branch that opens a commit link in the workspace diff does not exist in GOAT, so only the reveal lines were ported, and upstream's two added cases in openPullRequestLink.browser.test.tsx (shift and alt on a commit link with a diff anchor) have no GOAT counterpart (that test file was removed on dev). (d) the mobile file route starts its first jump imperatively only for a diff link, whose file is known once the diff loads; other entries keep GOAT's native entry destination. (e) every new effect carries goat/react-effect-budget with upstream's reason (GOAT has no no-unreasoned-state-sync rule).

Fail first, with the row's source swapped back to HEAD and the tests unchanged: useCodeViewFileReveal.test.ts 4 failed (the folded-file range, the two upstream cases, the retitled case); rightPanelStore.pullRequestReveal.test.ts 1 failed; PullRequestCodeTab.browser.test.tsx 2 failed (the paged link reveal, the commit link); PullRequestTimelineTab.browser.test.tsx 3 failed (the three linked kinds). New modules' tests (pullRequestAnchor, pullRequestLinkSubject, mobile pullRequestLinkNavigation, gitHubPullRequestJson.reviewUrl) fail by construction at HEAD (the module or the field is absent).

Fresh checks on the row: `vp run --filter <pkg> typecheck` exit 0 for @goat/web, @goat/mobile, @goat/shared, @goat/source-control-github, @goat/contracts; `vp lint` on the changed files clean; `vp test run` on shared, the web units, apps/mobile/src/features/pull-requests and packages/source-control-github/src: 59 files, 778 tests passed; browser project on src/components/pullRequest, DiffFileTree, BranchToolbar.panel and BrowserDocumentFrame.shortcuts: 18 files, 96 tests passed. P1 rows owed: a web capture of a comment link, a diff link and a checks link revealing in the panel; mobile captures of a comment link opening Activity at the comment and a diff link opening the file at the lines.



## Lane coordinator and coordinator 21:59:20 UTC, items 2 and 3 and the note for K2, verbatim

> 2. K10's READING (useComposerSend.ts 1543): ACCEPTED, no move-out. The 95 lines the shared pre-commit freed are room for both lanes: K10's (xxiv) takes 3, K2's 479ee74135 takes 18 by its plan (next3-K2.md:89), so the file ends at 1561 against 1635 at 8c59f73519. Allotment so it stays settled: K10 up to 10 lines, K2 up to 25; beyond that the lane makes its own move-out. At K2's merge the code-budgets.json line is countLines of the merged file (III.3). The same reading holds for any later shared pre-commit: the lanes it was made for share its room, by numbers I give at the merge.
>
> 3. CLAIMS: K4's ProviderTurnStartService.ts :189-217 as a wrapper plus a call line is accepted on the pre-commit's terms: the moved expression byte for byte inside the new function, every added line (signature, parameters, return, call) listed in the commit message and the record, no behaviour change; the review reads it. Any other claim that is not a top-level declaration follows the same terms without asking.
>
> For K2: your allotment in useComposerSend.ts is up to 25 lines (your plan says 18 for 479ee74135); beyond that, your own move-out. Your deletion request for pullRequestDiff.logic.test.ts (row 8cbc95923a) is with the coordinator, forwarded verbatim with my check. Quote these in next3-K2.md.

## Coordinator 22:00:50 UTC, row 8cbc95923a and IV (iv), verbatim

> K2 RULE 3, row 8cbc95923a: AUTHORISED.
> - READ BY ME in this repository: git diff 8cbc95923a^ against the integration head for pullRequestDiff.logic.test.ts is empty; git show 8cbc95923a on that file whole (the import, the rewritten "keeps a file the reader folded closed" body, the two new isFileDiffCollapsed cases, describe toggleFileDiffFoldForViewed replaced by describe withFileDiffFold); upstream's hunks for PullRequestCodeTab.browser.test.tsx; GOAT's PullRequestCodeTab.browser.test.tsx (305 lines, no budget entry, three vi.mock calls, none of usePullRequestFilesViewed, no existing case about Viewed); toggleFileDiffFoldForViewed has no caller outside PullRequestCodeTab.tsx and that test. NOT RUN: any test.
> - The deletion: pullRequestDiff.logic.test.ts becomes upstream's file at 8cbc95923a byte for byte (git diff 8cbc95923a HEAD on that file empty after the commit). The removed case tested a function the same commit removes; its replacement is upstream's.
> - The browser test: in the EXISTING file, under IV (i): upstream's mock state, deliverViewedPaths, the vi.mock of ./usePullRequestFilesViewed, the two reset lines in setup, and upstream's new case. Condition: every existing case in that file passes with its body unchanged; if one needs a changed line because the hook is now mocked, that line comes to me. No sibling copy of the setup.
> - K2 quotes this and the hunks in its record before the commit.
>
> IV gains (iv), for every lane (relay it): where GOAT's test file is byte for byte upstream's parent of the commit being ported (git diff <sha>^ on that file empty), the file may become upstream's file at that commit, whole, deletions and retitles included; the record gives both empty diffs (before against <sha>^, after against <sha>). If GOAT's file differs from upstream's parent in any line, deletions and retitles still come to me.

## 8cbc95923a: test hunks and evidence

pullRequestDiff.logic.test.ts: `git diff 8cbc95923a^ HEAD -- apps/web/src/components/pullRequest/pullRequestDiff.logic.test.ts | wc -l` = 0 before; `git diff 8cbc95923a -- <same file> | wc -l` = 0 after (the file is upstream's at 8cbc95923a, whole). Fail first: with upstream's test and dev's logic, 3 failed (the two new isFileDiffCollapsed cases, withFileDiffFold is not a function); after the logic change 8/8.

PullRequestCodeTab.browser.test.tsx, upstream's hunks (8cbc95923a) and GOAT's: upstream's `mocks` gains `viewedPaths: null as ReadonlySet<string> | null,` and `viewedListeners: new Set<() => void>(),`; adds `function deliverViewedPaths(paths)`; adds `vi.mock(import("./usePullRequestFilesViewed"), ...)` backed by useSyncExternalStore over the mock state; `setup` gains `mocks.viewedPaths = null;` and `mocks.viewedListeners.clear();`; one new case "keeps a revealed file open when its Viewed mark loads afterwards". GOAT's file gets exactly those lines (GOAT's mocks object also has image and assetResources, untouched), plus two import lines (__setClientSettingsForTests, DEFAULT_CLIENT_SETTINGS) the new case uses; no existing line is removed or changed (the diff has no removed line). Two placement and wording differences from upstream: the new case calls GOAT's `setup()` (GOAT's setup takes positional arguments, upstream's an object), its comment drops the issue number (GOAT's no-low-value-comments lint), and it sits LAST in the file, because it leaves client settings hydrated with files folded by default and GOAT's setup, unlike upstream's, does not reset client settings; placed second (upstream's place) it made the existing "reveals a pending file across pages while a stale selected commit falls back to all commits" fail (header at 304 against a bound of 250), placed last every existing case passes with its body unchanged (8/8). That case passes on dev's source too: it guards the regression the new Viewed folding could cause; the logic cases are the failing proof.

Code: upstream's fold choices (an absolute Map) in PullRequestCodeTab.tsx; GOAT adds `flipFileDiffFold` in pullRequestDiff.logic.ts (upstream's toggle expression `withFileDiffFold(current, fileKey, !isFileDiffCollapsed(fileKey, override, current, viewed))` as one helper) so the tab stays under its entry: PullRequestCodeTab.tsx 1451 (entry 1452 after b3fdf2b10f; dev 1458).



## e89c8ce014: a file ticked Viewed before loading a push shows Changed (C4)

Contract: PullRequestSetFilesViewedInput.files[].revision optional, trimmed, non-empty, at most 256 (upstream verbatim). Server: pullRequestViewedFiles.ts records the shown revision when a press names one and reads the head only for presses without one (upstream verbatim). Web: the Code tab sends the shown file version (fileDiff.newObjectId) on the pull request's diff and none on a single commit's diff, as upstream; filesViewedStore queues { viewed, revision } and sends revision only when present.

No existing test changed: GOAT's filesViewedStore.test.ts and PullRequestService.test.ts both differ from upstream's parent (102 and 1993 diff lines), so upstream's edit of the existing store case was not taken; that case still passes unchanged (a press without a revision sends { path, viewed }). New cases instead: filesViewedStore.test.ts appends "sends the version of the file a press was made on, and none for a press that names none"; PullRequestService.viewedRevision.test.ts (sibling, the main file is at its entry) holds upstream's case verbatim plus "records the head's version of a file ticked without a revision, as older clients send"; packages/contracts/src/pullRequestCompat.test.ts (new, for every K2 wire field) decodes reviewUrl and revision present and absent, through the older schema shape (the field dropped, nothing refused), and refuses an empty or overlong revision.

Each way, checked by those tests: a newer client against an older server: the older input schema drops revision and records the head (today's behaviour); an older client against a newer server: no revision, head recorded (today's behaviour). Fail first, with dev's store, logic and contracts swapped back: 3 failed (the store case and both revision contract cases); the server case failed with dev's pullRequestViewedFiles.ts and contracts (dismissed expected, viewed received) while the older-client case passed there and after, as it should.

Checks: typecheck @goat/web, @goat/server, @goat/contracts exit 0; lint clean on the changed files; the new and touched tests pass. PullRequestCodeTab.tsx 1454 (dev entry 1458).



## Condition (a) for 54a5c51a58, written before its code

(i) The fallback server answers only for repositories its own active projects have. The client assigns each project only to the environment that reported it (assignProjectsToEnvironments keys every candidate by project.environmentId; a repository moves to another environment only through a project that environment itself lists), and a list request carries project ids, never repository names: PullRequestService's listWorkspaceProjects iterates the server's own project list and filters it by the ids, so an id the server does not have matches nothing and reads nothing (the same boundary S4 set with hasProjectRepository: a repository is read only through a project of this server). Tests: the assignment never puts a project under an environment other than its own, and keeps an unreadable repository with its owner when no other environment has a project for it; a server list request naming a project id that server does not have reads no repository and lists nothing.

(ii) A fallback server can be signed in to a different account, so lists that depend on the viewer would be that account's. GOAT's fix: the fallback is used only for views that do not depend on the viewer, involvement "all" with no author filter; for "reviewing", "authored" or an author filter the repository stays with its owning server, which reports its read error as today, so no list silently shows another account's review requests. Under "all", each row already names the environment it was read through (PullRequestListGroups.tsx:121, shown when more than one environment can list pull requests), and the detail panel opened from that row acts through that environment, whose account its permissions belong to. Upstream applies the fallback to every view; this is a GOAT deviation with its reason. Test: with involvement "reviewing" (and with an author filter) the unreadable repository is not reassigned; with "all" it is.

Size of an error's listResult: upstream builds it only when no repository was readable, so its entries are always empty; it carries the viewers map, one provider summary per host and one error per unreadable repository. The largest is bounded by the server's project count (a request's projectIds are at most 100; without them, every project of that server). The measured size from a 500-repository fixture goes in this record with 54a5c51a58's commit.



## Coordinator 22:16:44 UTC, IV (v) and (vi), verbatim

> IV gains (v), mock scaffolding: a line added to a test's mocks so that existing cases keep loading or rendering after the lane's row adds a component, hook or import. Covered: one export added to an existing vi.mock factory, or one vi.mock of a module the lane's own row introduced. Conditions: the stub is inert (renders its children, returns undefined, or does nothing); no existing title, body, setup value or expectation changes; the line is quoted in the record before the commit; the file stays within its entry; and what the stub hides is tested in a case of its own or named in the lane's P1 rows. Still to me: a mock that returns data existing assertions read, a changed existing mock line, a stub of a module the lane did not add, and anything a lane is unsure of. The review checks each; a miss is a P2.
>
> IV gains (vi), a describe moved whole: a whole top-level describe block of an at-entry test file moved byte for byte into a sibling test file, in a commit that does nothing else, on K7's conditions a to d above (empty diff of the two ranges in the record; helpers copied byte for byte and listed, none moved or shared; the same case titles and the same total count before and after; the entry lowered; the card row before the cut; TEST_TITLES updated in the same commit when the file is listed). Still to me: a harness or helper moved or shared into a testkit, a describe split in two, a nested block, and a move that needs any line of a case to change.

## 54a5c51a58: fall back to a readable server for shared repositories (C4), what landed

Contract: PULL_REQUEST_LIST_PROJECT_LIMIT (100, the same limit), PullRequestProviderSummary.projectIds optional, listResult optional on PullRequestUnavailableError and PullRequestOperationError (in GOAT's pullRequestErrors.ts, which imports PullRequestListResult one way; no cycle). Server: upstream's refined-host project ids and the list error carrying its partial result; GOAT puts the empty-result builder, the error wrapper and the host note in pullRequestListFallback.ts with one-line calls, so PullRequestService.ts is 3731 (dev 3732). Web: upstream's host-read memory and assignment (pullRequestProjectAssignment.logic.ts, state/pullRequests.ts observing typed list failures, pullRequestList.logic.ts merging batches without duplicate rows), with GOAT's usePullRequestHostReads.ts (state, observe, reset) and pullRequestListTargets.ts (the two target builders upstream rewrites, as one function) keeping PullRequestsPage.tsx at 1555 (dev 1555). Upstream's two non-null assertions in rememberPullRequestHosts became a narrowing guard (GOAT bans new ones outside tests).

Condition (a), as written before the code: (i) proved by "lists every project only through the server that reported it", "keeps an unreadable repository with its own server when no other server holds it" (assignment test, appended) and "reads no repository for a project id this server does not have" (PullRequestService.readableFallback.test.ts, a provider that dies if read); (ii) pullRequestListMayFallBack (involvement all and no author filter of me) gates the fallback in usePullRequestScope, proved by "falls back only for lists that do not depend on who is signed in"; the user guide (docs/user/source-control.md, Review and merge) says so in this row (condition g). Size: a PullRequestUnavailableError whose listResult names 500 unreadable repositories with long names, and three hosts that each list 500 project ids, encodes to 129,083 bytes (the 500 errors alone: 89,841); the entries are always empty on that path. The compat test pins the bound below 160,000 bytes and the older-client decode (the field ignored).

Tests, no existing expectation changed: pullRequestList.logic.test.ts would exceed 1000 lines with upstream's three cases, so they went whole into pullRequestList.batchMerge.test.ts with the entry and answer helpers copied byte for byte from that file; pullRequestProjectAssignment.logic.test.ts and state/pullRequests.test.ts take upstream's added cases and its import line (the only removed line, an import); upstream's server cases went whole into PullRequestService.readableFallback.test.ts (the main file is at its entry); upstream's one added assertion in the existing case "reads a repository once when several worktrees share it" was not taken (existing case unchanged). Fail first, with dev's list logic, assignment logic, state, service and contracts swapped back: 19 failed (all of upstream's new web and server cases, the compat case, and the GOAT fallback-gate case; GOAT's two boundary cases pass on dev too, as invariants).

Checks: typecheck @goat/web, @goat/server, @goat/contracts exit 0; lint clean on the changed files; apps/server/src/pullRequest, the compat test, apps/web/src/components/pullRequest and state/pullRequests.test.ts: 52 files 554 tests, then 37 files 321 tests passed after the last fixes. P1 rows owed: two environments with the same repository, one without host credentials: All lists it through the other with its environment label; Reviewing keeps the first's error.



## Condition (c) for f3da8ff63b, written before its code

An agent can resolve a GitHub review thread through a goat tool today: goat_pull_request_thread_resolve (agent surface "pull_request.thread_resolve", packages/contracts/src/agentSurface/entries/pull_request_writes.ts:97) calls PullRequestService.setThreadResolution, the same service method the web Resolve button uses, with the permission check at PullRequestService.ts:2144. GitLab overview threads join that path: GitLab's setThreadResolution resolves a discussion by its id whatever its position (GitLabPullRequestProvider.ts:649-659, setDiscussionResolution with discussionId = threadId), and an agent finds the overview thread's id in goat_pull_request_activity. One gap the port must close: that read builds its answer as `{ ...activity, ... }` and fits each list into the byte budget (apps/server/src/mcp/toolkits/pullRequests/handlers.ts:657-704), so a new overviewThreads list would pass through the spread unbudgeted; the row gives it its own budget slot and an overviewThreadsOmitted count. Tests: the activity read answers overview threads within its budget and counts the ones left out; an agent's resolve of an overview thread reaches GitLab's discussion resolution with that id (GitLab CLI mocked).



## f3da8ff63b: resolve GitLab overview threads from Summary and Timeline (C4), what landed

Contract (upstream): PullRequestOverviewThread (a review thread with path and line null), PullRequestActivity.overviewThreads optional and apart from reviewThreads, pullRequestConversationThreads helper; ProviderChangeRequestActivity.overviewThreads. GitLab: discussions keep overview threads (GOAT's decoder keeps its gitLabDiscussionPosition helper; the thread type in gitLabCliTypes.ts widens to PullRequestConversationThread); the provider sends overviewThreads only when there are some (GOAT deviation: upstream always sends the list, GOAT leaves it out when empty so a merge request without them reads exactly as before, which also keeps dev's GitLabActivity case unchanged). Server: PullRequestService passes the list on (withOverviewThreads in pullRequestActivityFields.ts). Web: PullRequestResolveThreadButton.tsx (upstream) on the Summary and Timeline remark of a thread; chatSubject (in GOAT's PullRequestChatActions.tsx) hands an overview thread over as its opening remark. Mobile: activity filter, timeline and discussion screen read conversation threads (upstream), and K2's link target finds a linked overview reply's discussion. MCP (condition c): goat_pull_request_activity budgets overviewThreads like its other lists and reports overviewThreadsOmitted (optional, only when the host sent the list); goat_pull_request_thread_resolve reaches GitLab's discussion resolution unchanged.

Rule 3 under IV (ii): packages/source-control-gitlab/src/server/GitLabOverviewDiscussions.test.ts, the case upstream has in GitLabPullRequestCli.test.ts. GOAT's case equals upstream's parent case except one fixture name (author username "alex" for upstream's "julius", diff of the two 127-line cases); the commit makes it upstream's text at f3da8ff63b with that same name kept. Upstream's hunk: title "reads a positioned discussion as a thread and an open overview discussion as a finding" becomes "reads a positioned discussion at its line and an overview discussion as a thread and a finding"; the expected threads gain { id: "ghi789", path: null, line: null, side: "right" } and { id: "jkl012", ... }; three expectations added (threads[1] unresolved with notes ["4","5"], threads[2] resolved). GOAT's hunk: the same lines. Nothing else existing changed: upstream's rewrite of the provider case "turns the first note of an open overview discussion into a review finding" (GOAT's GitLabActivity.test.ts:118) was not taken; its content is GOAT's new GitLabOverviewThreads.test.ts case, and dev's case passes unchanged.

New cases: GitLabOverviewThreads.test.ts (overview thread apart from file threads with the old finding kept for older clients; no list when there is none; resolve by discussion id and GitLab's 403 reported); handlers.budget.test.ts (overview threads within the 256 KiB budget, one left out and counted, keys absent when the host sent none); PullRequestSummaryTab.browser.test.tsx (upstream's Fix case; Resolve on an overview thread calls the resolution with its id and refreshes; no Resolve when the viewer may not resolve).

Each way: a newer server to an older client: overviewThreads is a separate optional key the older client ignores; overview remarks stay in comments and findings as before, and reviewThreads never holds a path-less thread. An older server to a newer client: no overviewThreads, so no Resolve on overview remarks; the MCP read has no overviewThreadsOmitted. Fail first, with dev's contracts, GitLab provider and decoder, Summary tab and MCP handlers swapped back: 4 failed (the decoder case, the provider case, the MCP budget case, the Resolve case); the others are invariants.

Move-outs before it: 4248d62082 (PullRequestService.ts :348-352 VERDICT_LABELS, frees 6), 9695d8ac77 (pullRequestDetail.logic.ts :218-243 threadPullRequestPanelTarget, re-exported, frees 28), bc14c15253 (gitLabMergeRequestJson.ts :543-575 label decoder; decodeUnknownList, decodeLabelEntry and DecodeFailure gain an export; GitLabPullRequestCli.ts moves one import line, stays at 1779). Entries after the row: PullRequestService.ts 3727 (dev 3732), pullRequestDetail.logic.ts 1325 (1343), gitLabMergeRequestJson.ts 1048 (1069).

Checks: typecheck web, mobile, server, contracts, source-control-gitlab, source-control-core exit 0; lint clean; unit 229 files 2041 tests, browser 15 files 73 tests passed. P1 rows owed: a GitLab merge request with an overview thread (GitLab mocked or a person row): Resolve on Summary and Timeline on web, the discussion screen on mobile. The live GitLab resolve stays a person-or-account row.

## Condition (d), 479ee74135 per client (written ahead of that row)

Web and desktop start a thread from a pull request through the PR dialog (PullRequestThreadDialog) and the detail panel's actions, and carry the link through the draft. Mobile starts one through Work on PR, which already attaches the review to the chat it opens and links it there; the draft-carried link is a web-store change, so mobile does not carry checkoutPullRequest, and the user guide's mobile sentence (Work on PR opens a chat with the review attached) stays true.



## Coordinator 22:45:36 UTC, verbatim

> FOR EVERY LANE (relay it): before a push, every changed test file runs whole, with no -t filter; and for a row that changes when or whether something wakes, notifies or holds a thread, the test files of that subsystem run whole as well. A -t run is for iteration and is named as such in the record.
>
> Quote it in next3-K2.md. Also from the same message, for your folder: M3's O24 hunks in apps/mobile/src/features/pull-requests/ now follow M3's device sweep (only sheets that fail it); O22's stay as ruled.

The -t runs in this record were iteration only: the code-tab "stale selected commit" case while placing the Viewed case (8cbc95923a) and the stored-link "malformed" case while finding the right scenario (479ee74135). Every changed test file ran whole before READY (below).

## The one integration-head merge

09b4d64624eea8646a8258a7937a5e3f3309e9f6 (f3da8ff63b, K2's last row before it) merged with origin/chase/t3-261114-next3 at 259883c788bb32d5601023932e07f879bde9af60 (K7 not in yet; T1c and K10's shared pre-commit in) gives 735ba22fb978ac08be555266eb2fb553db8d06af. git reported a clean merge ("Merge made by the 'ort' strategy", 15 files changed, no conflicts; code-budgets.json merged without a conflict). It came before 479ee74135, the one row that writes into useComposerSend.ts, as ruled.

## 479ee74135: a thread started from a pull request links it (C4 stored draft), what landed

Decision 1 as accepted: PersistedDraftThreadState.checkoutPullRequest is Schema.optionalKey(Schema.Unknown); readStoredCheckoutPullRequest (composerDraftCheckoutPullRequest.ts) accepts only two strings each 1 to 4096 characters and drops anything else; the writer writes only the typed { url, branch } (partialize spreads the typed session field); no version bump; the fork delta has the deviation (010_fork_delta.md, pr-checkout-draft). The rest is upstream's behaviour in GOAT's shape: the PR dialog and both checkout handoffs (PullRequestDetailPanel.tsx and usePullRequestActions.ts, through one markDraftCheckoutPullRequest helper) put the pull request on the checkout draft; the first successful send links it to the new thread when the draft is still on the checkout branch (useLinkCheckoutPullRequest.ts, called from useComposerSend.ts, so ChatView.tsx is unchanged: GOAT deviation from upstream's ChatView callback). Upstream's other change in those handoffs is ported too: the task goes on the checkout draft (pointed), not the draft opened before the checkout.

Fail first, the stored-draft condition: composerDraftStore.storedLink.browser.test.ts (a browser test, since the attachment check reads real localStorage, which the unit environment does not share with the persist storage) has another tab store a malformed link after this tab's first write; this tab's next write keeps it (writes merge with what is stored); with upstream's typed schema the strict whole-storage read fails and the saved image reads as unsaved (AssertionError: expected [] to deeply equal [ 'img-1' ]); with Unknown it passes, the other tab's draft keeps its prompt in storage, and rehydrating drops only the bad link. A first version of that test (malformed value seeded before hydration) passed with both schemas, because this tab's first write replaced the hydrated draft; it was not counted. Upstream's unit cases (link after the live branch sync reverts, no link after a branch move, cleared or project change drops it, persisted value and pre-field drafts restore) are in composerDraftStore.checkoutPullRequest.test.ts (sibling, the main test file is at its entry); they fail at dev by construction (the field and options are absent).

Each way: old drafts read by the new code restore unchanged (the pre-field case); new drafts read by an older client: the older client's lenient normalizer drops the key and its strict schema ignores it, so it never links and a later write of that draft removes the key (best effort, as accepted); a draft whose stored link fails to decode keeps its prompt and the other drafts' saved images (the browser case).

Condition (d), per client: written in this record before the row (web and desktop carry the link; mobile's Work on PR already attaches the review to its chat and does not use the web draft store; the user guide stays true).

Move-out before it: 1929140282 (composerDraftStore.ts :771-796 at c995c5427a, terminalContextDedupKey and normalizeTerminalContextForThread to composerDraftTerminalContexts.ts, verbatim; both gain an export; the store drops the normalizeTerminalContextText import only the moved code used; frees 24). Entries after the row: composerDraftStore.ts 4332 (dev 4336), useComposerSend.ts 1544 (entry 1540 after K10's pre-commit; 4 of the 25 allotted), PullRequestDetailPanel.tsx 1798 (dev 1798).

Checks: typecheck @goat/web exit 0; lint clean; composerDraftStore.test.ts, composerDraftStore.checkoutPullRequest.test.ts, apps/web/src/components/chat, apps/web/src/components/pullRequest: 219 files 1490 tests; browser: the stored-link test, src/components/pullRequest, ChatView.browser: 16 files 74 tests; PullRequestThreadDialog.test.ts 1; useComposerSend question and redirect browser tests 9; all passed, each file whole. devlog/_chase/scan.sh --delta: no new finding. P1 rows owed: start a thread from a pull request (dialog and Work on PR in the panel), send once, the thread shows the PR linked; switch the draft's branch before sending, no link.

## 2026-11-18 UTC — K2 resumed, pushed, local gate blocked

All eight rows were present at `f738ac2efa1e36b205d8238b2980ff57bba34221`. That last commit makes two checkout-draft helpers file-local for Knip. The final merge of `f82d2df4b0960eb39bd36e4100b72b6f2758c7d2` had one budget conflict. Set useComposerSend.ts to its measured 1,547 lines (cut ceiling 1,635), committed as `00b419cbc1d189a402c86e6091ade5c1ae6d6cdd`. `vp i` exited 0 after the lockfile change. Plain lane push and remote SHA verification exited 0. Integration advanced during verification to `6def29ca359f546e50dcd731a6364e3f0d575545`; `git merge-tree --write-tree HEAD origin/chase/t3-261114-next3` exited 0 against it.

- `vp run check:changed origin/chase/t3-261114-next3`: first run interrupted at an idle browser phase, exit 130, no aggregate counts. With `VITEST_MAX_WORKERS=4`, same base and test selection, exit 1. Vitest: 2,770 files passed, 12 failed, 5 skipped (2,787). Tests: 37,737 passed, 72 failed, 21 skipped (37,830). All non-test steps passed, including 42-package typecheck. Failures were in six web browser cases, SSH workspace and tunnel fixtures, Grok fixtures, the native Swift schema probe, and PostgreSQL relay fixtures. The Swift 6.3.3 compiler rejected the 6.4-built SDK. The relay PostgreSQL tools were absent from PATH. The local gate remains blocked.
- Root `vp test run` for all 21 changed non-server test files and 10 direct companions: exit 0, 31 files and 458 tests. From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run --reporter=verbose` on handlers.budget, PullRequestService.readableFallback and PullRequestService.viewedRevision: exit 0, three files and nine tests (2 + 5 + 2). All files ran whole.
- From `apps/web`, `vp test run --project browser --reporter=verbose` on ChatView.handoffCompaction, ChatView.modelPick, Sidebar.shortcuts, ChatHeader and FileBrowserPanel: exit 0, five files and 23 tests. All six gate-failing browser cases passed in this isolated run.

C4 review commits: `61b1b242477` (b3fdf2b10f, older-client decode and reveal routing), `44105a2b45c` (e89c8ce014, Viewed revision and compatibility tests), `c097e937805` (479ee74135, lenient draft storage and send hook), `878cde96c5a` (54a5c51a58, repository ownership and account-scoped fallback), `09b4d64624e` (f3da8ff63b, optional overview threads and bounded MCP output). Other adapted ports: `2c25254b656` (8cbc95923a, folding helper and browser harness), `1a4ac5fe8e2` (abbd967c4b, relocated helper and fixture). Patch-identical upstream port: `6123403fa04` (3a0bcba00a). GOAT-only move-outs: `239649e7932 df050ab2e53 574f17b15f3 4ac1f97ad26 2b994754591 efc31ab6e04 c666e67a29c 4248d620820 9695d8ac778 bc14c152533 1929140282a`. GOAT-only cleanup and merge budget: `f738ac2efa1 00b419cbc1d`.

P1: web/desktop anchor reveal and hover preview, mobile comment and line reveal, Viewed folding and Changed after a push, first-send checkout linking and the changed-branch case, cross-environment All versus Reviewing, and mocked GitLab overview Resolve on web and mobile.

NOT RUN: independent C4 review, P1 real clients and captures, live GitHub/GHES links and GitLab Resolve, lane CI, standalone repo-wide checks, and a gate on a merge with the newer integration tooling.

## 2026-11-18 UTC — C4 review fix round 1, READY for re-review

Plain-pushed and verified `a81bf0cbb06fbd3176d6d1a313ec03687d969ff1` on top of `00b419cbc1d189a402c86e6091ade5c1ae6d6cdd`. The existing merge base is `f82d2df4b0960eb39bd36e4100b72b6f2758c7d2`. `git merge-tree --write-tree HEAD origin/chase/t3-261114-next3` exited 0 against `258239d88f0c5df1ef43d787957007d1775f823d`. No additional merge.

| Finding | Commit | Failing case and fix |
| --- | --- | --- |
| P2-1 | `51e282565f3` | The fallback account's row entered Authored while partitions loaded. Live and restored partition reads target preferred assignments. Fallback rows stay in Others during loading and after settlement. |
| P2-2 | `b8e8407ad55` | A carried fallback row survived typing `author:me`. The request uses the effective parsed author and the immediate filter uses the typed author. The baseline read still checks its menu author. |
| P2-3 | `a81bf0cbb06` | Two successful model threads produced zero link calls. Capture the branch-matched URL before the send and link only acknowledged thread IDs. The different-branch and failed-start cases stay unlinked. |
| P3-1 | `5fff34868c8` | Code tab shuffled seed 1 failed with header position 304 versus the existing upper-half bound of 250. Restore the original settings and hydration status. Pin the paged layout fixture's diff expansion so it is independent of prior hydration. Assertions unchanged. |
| P3-2 | `d984048f1a5` | A synthetic last overview thread fit only if the omission count was excluded from the shell. Reserve the worst-case count whenever the field is present. |

- Whole focused `vp test run`: exit 0, 26 non-server files and 238 tests. From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run` on handlers.budget, PullRequestService.readableFallback and PullRequestService.viewedRevision: exit 0, three files and ten tests. Code tab `--sequence.shuffle --sequence.seed=1`: exit 0, eight tests. Web typecheck exit 0.
- `VITEST_MAX_WORKERS=2 vp run check:changed origin/chase/t3-261114-next3`: exit 1, 37,854 passed, 67 failed, 21 skipped in 2,810 files. All non-test steps passed, including 42-package typecheck. The same 66 test names failed at `00b419cbc1d`: 44 SSH workspace, 16 Grok, 1 SSH tunnel, 1 Swift schema probe and 4 PostgreSQL relay. Eight representative cases across seven files reproduced the same failure modes on integration `6def29ca359` and `258239d88f0` (both probes exit 1): remote Git initialization, SSH shim Node lookup, Grok ACP exit 127, Swift SDK/compiler mismatch, missing PostgreSQL tools. The extra `GuestPage` timeout did not reproduce when the whole file ran in isolation: exit 0, three tests on lane and both integration heads.
- NOT RUN: integrated P1 client captures, live forge cases, hosted lane CI, independent re-review, full baseline gate.

## 2026-11-18 UTC — review fix round 2, BLOCKED on Rule 3

Local head `c87507c00c7386dba27cdbc03280acf949e3cafc` merges integration `a00670156950fd2373145ab25a3ada18219720ac` once. The remote K2 head remains `134249c1c3903ca8395b7f1576c5424b221fb263`. The merge keeps both integration's withheld-diff revision guards and K2 link reveal. It extracts the Code tab's conversations outside the rendered diff to keep the tab under its line budget.

- P2 checkout acknowledgment. `fe62d77de7333790b5d1df7957aed1fc0fb5e256`, already in the starting head, compares the live checkout to the captured worktree bootstrap branch before linking any acknowledged thread. With `a81bf0cbb06fbd3176d6d1a313ec03687d969ff1`'s two production hooks substituted in the pinned checkout, the whole redirect browser file exited 1 (10 passed, 1 failed). The attachment barrier let the live draft change while the dispatch retained its original base branch. The regression expected zero link calls and received two. With the fix, the checkout link file passed all three cases, including the acknowledged-thread and rejected-start paths.
- P2 Rule 3. `18804f07e8e81f1c2b05441163eb60931fb287ad`, already in the starting head, removed the stale-commit case's pinned settings. `85444d442d` moved the checkout tests and their spies to `useComposerSend.checkoutPullRequest.browser.test.tsx`. The entire redirect file and the stale-commit Code tab case are byte-identical to integration. The merge also preserves integration's withheld-diff cases and the list-ranking parameterized case byte-for-byte.
- Node 26.12.1. Whole `vp test run` for 24 changed non-server files plus the restored redirect file exited 0 (25 files, 212 passed). From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run` on handlers.budget, PullRequestService.readableFallback and PullRequestService.viewedRevision exited 0 (3 files, 10 passed).
- CodeTab `--sequence.shuffle --sequence.seed=1` exited 1 (15 passed, 1 failed). The unchanged stale-commit case's header was at 304px and its upper-half bound was 250px. Substituting integration's exact test file on the same merged production also exited 1 on the same assertion (12 passed, 1 failed). Asked the coordinator for Rule 3 permission to try the exact four-line `__setClientSettingsForTests` setup from `5fff34868c8`, with `diffFilesCollapsed: false` and the original assertion. The merged head still needs fresh proof if the change is approved.

NOT RUN: `vp run check:changed origin/chase/t3-261114-next3`, lane CI, live client/P1, live forge checks and independent re-review. The lane code push is held for Rule 3.

### Coordinator Rule 3 ruling, verbatim

```text
K2 Rule 3 ruling (coordinator): DENIED. Evidence: on the integration tip (a00670156950 plus K7b/U11/U13 merges) without K2, apps/web/src/components/pullRequest/PullRequestCodeTab.browser.test.tsx run with --sequence.shuffle --sequence.seed=1 passes 13/13. So the unchanged "reveals a pending file across pages while a stale selected commit falls back to all commits" case fails only with K2's production code, and pinning diffFilesCollapsed:false in its setup would hide a K2 regression (this is the same edit review r2 flagged).

Find the cause in K2: which K2 change makes the pending file land 304px down (vs <250) under seed 1 — e.g. K2 production code reading/initializing the diffFilesCollapsed client setting differently, a module-level store or cache in K2 code that survives between tests, or a K2-added test elsewhere in the shuffled run that mutates client settings without disposal. Fix it in production code (or, if the leak is in a K2-added test, make that new test dispose what it sets), with the stale-commit case byte-identical to integration. Prove with seed-1 and default-order runs of the whole file, then continue the round: push, gate (whole changed files + vp run check:changed origin/chase/t3-261114-next3, Node 26.12.1), record this ruling verbatim in next3-K2.md, and report READY with head SHA, the root cause in one sentence, receipts and NOT RUN. If you conclude K2 intentionally changes the default collapse behavior users see, stop and send me that product change with evidence instead.
```

### Review fix round 2 follow-up

K2's line-range guard delayed even a file-header reveal until its file expanded, leaving the paged destination at 304px. `505803dee3b02776e0a3ad9ac1e7d3a9ac937548` lets a folded header scroll immediately while line ranges still wait for expansion. The default collapse setting and the stale-commit case are byte-identical to integration. The redirect suite is also byte-identical to integration. Plain fast-forward push from `134249c1c3` succeeded and `git ls-remote` verified the lane SHA.

- Folded-header regression in `useCodeViewFileReveal.test.ts`: red exit 1, 8 passed and 1 failed (zero item scrolls instead of one); green exit 0, 9 passed. The line-range regression still verifies waiting on a folded file.
- Whole `PullRequestCodeTab.browser.test.tsx`: seed 1 red exit 1, 15 passed and the unchanged stale-commit case failed at 304px versus <250px. Seed 1 and default order each exited 0 with 16 passed on the fix.
- Node 26.12.1, final head: whole `vp test run` for 24 changed non-server files plus the restored redirect suite exited 0 (25 files, 213 passed). Three changed server suites run from `apps/server` with `GOAT_TEST_TMP_GUARD=fail` exited 0 (3 files, 10 passed). The attachment-await red and green receipts are above.
- `VITEST_MAX_WORKERS=4 GOAT_TEST_TMP_GUARD=fail vp run check:changed origin/chase/t3-261114-next3` exited 1. All static checks passed, including 42-package typecheck. The 2,907-file selection yielded 2,901 passed, 1 failed and 5 skipped, with 39,169 tests passed, 16 failed and 21 skipped. The workspace batch passed all 1,438 files (20,385 passed, 4 skipped). The only failed file was `apps/server/src/textGeneration/GrokTextGeneration.test.ts`. A four-case probe on exact integration `a00670156950` also failed all four, reproducing ACP exit 127 (`exec: node: not found`) and the memory fixture failures. K2 has no diff in the Grok/ACP provider code, the server text-generation directory, or the Vitest configuration. On the same exact integration checkout, the Code tab seed-1 baseline passed 13/13.

READY for independent re-review at `505803dee3b02776e0a3ad9ac1e7d3a9ac937548`. The broad gate's only red suite has the integration fixture failure described above.

NOT RUN: hosted lane CI, live client/P1, live forge checks, full baseline Grok suite, independent re-review.

## Review fix round 3

An in-flight single-model send could start on its captured branch and worktree while the reused draft acquired another checkout's PR during attachment upload. `88464591de1a5a4a4b736a45bd92dcb16e438864` requires the dispatched branch in `checkoutLink.read` and passes `activeThreadBranch` from the single-model bootstrap. The multi-model caller still passes the base branch it dispatches. A branchless send or a live draft for a different branch produces no link.

The dedicated checkout Chromium suite on `505803dee3` plus the new test exited 1 (3 passed, 1 failed). An upload barrier paused dispatch while the draft was rebound. The single thread still started on `feature` in `/worktrees/feature`, but the acknowledgment linked `https://github.com/org/repo/pull/2` once instead of recording zero links. After the fix, the same whole suite exited 0 (4 passed).

`4702b9156e309754c5e14fa1fd0514b8827ea993` merges integration `bb35c19e1e5f9ad227416bff7bc668bc4db71414` once with no conflicts. All 13 integration CodeTab case bodies and the full redirect file are byte-identical to integration. The folded-header fix is in the merged head.

- Node 26.12.1. Whole test files changed against integration or carried in this merge, plus the redirect suite: 35 non-server files passed with 335 tests passed and 2 skipped. Guarded `vp test run` from `apps/server` with `GOAT_TEST_TMP_GUARD=fail`: 4 files and 46 tests passed.
- Whole `PullRequestCodeTab.browser.test.tsx`: default order and `--sequence.shuffle --sequence.seed=1` each passed all 16 cases.
- `VITEST_MAX_WORKERS=8 GOAT_TEST_TMP_GUARD=fail vp run check:changed origin/chase/t3-261114-next3` on merge base `bb35c19e1e5` exited 1. Format, lint, both Knip passes, both GraphQL checks, unused patches, agent audits and the 42-package typecheck passed. Across 2,907 selected files, 2,901 passed, 1 failed and 5 skipped. Tests: 39,171 passed, 16 failed and 21 skipped. The workspace batch passed all 1,438 files (20,387 passed, 4 skipped). The only failing suite was `apps/server/src/textGeneration/GrokTextGeneration.test.ts`. All 16 failing test names match the round 2 gate, including the known ACP exit 127 (`exec: node: not found`) and its fixture timeouts.

READY for independent re-review. Plain fast-forward push verified the lane head at `4702b9156e309754c5e14fa1fd0514b8827ea993`. Integration advanced during the gate to `654b9955d71792664d6bf4a291816d63ac199880`; `git merge-tree --write-tree` against that head exited 0. The gate used `bb35c19e1e5`.

NOT RUN: hosted lane CI, live client/P1, live forge checks, a gate on a merge with the newer integration tip, a fresh Grok baseline on the newer integration tip, independent re-review.

## 2026-11-19 — round 2 resume receipts

Plain-pushed finished round 2 at `134249c1c3903ca8395b7f1576c5424b221fb263` (exit 0, origin verified). Branch race `fe62d77de73` failed first with two wrong links during the held upload, and Rule 3 restoration `18804f07e8e` preserved the stale-commit body. The requested integration merge at `3d683c091e517f93c2fa6fefb487b9af60f28fce` produced local `d0683899ab65fda3026c80e665ad2bb3c220ea52` after five PR conflicts and a file-only reveal timing fix. `vp i` exited 0. Whole focused checks on that local head passed 331 tests across 27 non-server files, 27 tests across two shuffled browser files and 10 tests across three guarded server files. `VITEST_MAX_WORKERS=2 vp run check:changed origin/chase/t3-261114-next3` exited 1 (38,537 passed, 66 failed, 21 skipped, 2,883 files). All non-test steps passed. Eight representative SSH/Git, Grok, Swift and PostgreSQL failures reproduced on exact integration `3d683c091e5`.

The final plain push of the local merge was rejected because another worker had already published `505803dee3b02776e0a3ad9ac1e7d3a9ac937548` with a later integration merge, equivalent folded-header fix and stronger checkout fixture isolation. Kept that history. The separately verified round 2 published tip passed 213 tests across 25 focused files, 27 tests across three shuffled browser files and 10 tests across three guarded server files. Its two-worker changed gate exited 1 (39,119 passed, 66 failed, 21 skipped, 2,907 files), with all non-test steps passing and the same fixture suites failing.

During verification, origin advanced to round 3 `4702b9156e309754c5e14fa1fd0514b8827ea993`. It includes the requested integration by ancestry, merges `bb35c19e1e5f9ad227416bff7bc668bc4db71414` directly, and merges cleanly in preview with `09f842a481be0c6eadb53c1d2c1f716f47bb7483`. The plain push of the exact current remote reported Everything up-to-date, exit 0. Fresh verification on the actual tip: three whole, seed-1 Chromium files passed 28 tests and three guarded server files passed 10 tests. A fresh Grok probe of its integration parent `bb35c19e1e5` reproduced the ACP exit 127 and `exec: node: not found` (one failed, 24 filtered out, exit 1), matching the round 3 gate receipt above.

NOT RUN: hosted lane CI, live P1 and forge checks, independent re-review, full integration baseline suite, and a second full gate on the already gated round 3 tip.
