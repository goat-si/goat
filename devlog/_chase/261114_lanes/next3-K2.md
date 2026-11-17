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

