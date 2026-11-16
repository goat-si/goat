# N1: web saves and composer (lane record)

Lane branch: `chase/t3-261114-n1-web-saves`, from origin/dev `02511156b0`, merged with origin/dev at `3182a54238` (merge `d6257bb019`). Lane head `f4044724aa1491a5cfb6be70e480bef7d7c25d86`, pushed. Not merged anywhere yet; the coordinator merges reviewed lane heads into `chase/t3-261114-next`. Host pen-mac-studio. Class: not C4 (stored shape and wire unchanged).

## Rows

| card | upstream     | ruling | GOAT commit  | summary                                                                                                       |
| ---- | ------------ | ------ | ------------ | ------------------------------------------------------------------------------------------------------------- |
| L21  | `cb931fcbe2` | C1 B   | `81f5741e4a` | fix(web): a save in one tab no longer erases what another tab saved                                           |
| L20  | `efd683ccc3` | O3 C   | `28457b4f45` | fix(web): a failed send leaves the timeline and waits in the stash when a new draft was typed                 |
| L19  | `94f7984d2c` | O2 C   | `5364929301` | fix(web,mobile): Stop keeps typed question answers and their attachments                                      |
| L22  | `d835e430db` | O4 A   | `1dd6ac8850` | fix(web): /side typed while a question is open opens the side chat (rest; the answer half was ported earlier) |

Other commits:

- `818a075ab3` refactor(web): move the composer draft persist storage out of composerDraftStore.ts (verbatim move-out; composerDraftStore.ts was at its entry, 4508 of 4508).
- `e1d2693fe7` refactor(web): move the composer send input type out of useComposerSend.ts (verbatim move-out; useComposerSend.ts was at its entry, 1808 of 1808).
- `15ffe87a52` refactor(web): move two module helpers out of useComposerSend.ts (verbatim move-out before L22).
- `f4044724aa` test(web): the settings failure test waits for the write the cross-tab lock starts (follow-up to L21, found by the gate; see Gate).

## Decisions

- **C1 B (L21).** Drafts: the persist storage moved to apps/web/src/composerDraftPersistStorage.ts. Each write re-reads storage and writes only the entries this tab changed since its last write (upstream's per-key merge), inside a Web Lock named `goat:storage-lock:<storage key>` shared by the origin's tabs. Without Web Locks, or when the request fails before granting, the same read-merge-write runs at once (apps/web/src/lib/storageLock.ts). Pagehide condition: `pagehide` is added beside `beforeunload`; both flush synchronously and also land a write that is still waiting for the lock, and writes are numbered so one that waited never lands over a newer one. Settings: a write through the default store re-reads it under the same kind of lock and keeps every key this tab did not edit as stored. The edited keys are explicit (the patch's keys, or the keys an update changed), because a pure baseline diff misses a value set back to its starting value; that case has its own test. Upstream's refresh on another tab's storage event is carried. A caller's own `persist` function writes elsewhere and is not merged (tests only). Prompt stash: upstream's start-from-storage merge on stash, take and image finalize; it stays synchronous without a lock, because `stashEntry` must answer `written`/`durable` synchronously before the composer clears. Two-tab tests in both orders for drafts, settings and stash.
- **O3 C (L20).** A failed send always leaves the timeline (upstream). With an empty composer the draft is restored as before. When a new draft was typed meanwhile, the failed send (text, uploaded files, context records; images once encoded) goes to the prompt stash and the toast says "Your new draft was kept, and the failed message is in the prompt stash." Upstream's Copy-message toast (no timeout) remains only for a stash write browser storage rejects. Image encoding for the stash moved into apps/web/src/components/chat/stashFailedSend.ts and the composer's own stash uses it. A file whose upload is not ready is named in the entry's unreadable list.
- **O2 C (L19).** client-runtime: the announcer takes runtime requests and reports `unansweredRequestIds` (cancelled or expired). Web: the answer stores move into questionAttachments.ts with one resolution listener (upstream); before pruning, typed answers and their thread chips go to the thread's own draft (upstream), and the images and files of the request's question drafts move there through `moveComposerPromptAndImages`, keeping their uploads. Mobile: apps/mobile/src/state/unsent-question-answers.ts merges text, context and attachments into the thread draft through the same tracker and adds file chips, since the mobile composer shows files only as chips; `restoreMissingComposerFileReferences` is exported for it.
- **O4 A (L22).** `/side …` typed as the answer of an open question, with no attachments or context, opens the side chat with the question, clears the typed answer, and leaves the question pending. Where no side chat can start, the text stays a literal answer (upstream's comment). Decision in `sideChatCommandOverAnswer` (composerSubmission.ts, regression test in composerSubmission.test.ts); opening is shared with the existing `/side` path in apps/web/src/components/sideChat/sideChatFromComposer.ts.

## Upstream tests carried

- L21: the three regressions (drafts in composerDraftPersistStorage.test.ts since the storage moved there, settings in useSettings.test.ts, stash in promptStashStore.test.ts), storage keys renamed to `goat:*`.
- L20: "a rejected send …" in ChatView.browser.test.tsx, rewritten for the stash outcome. GOAT's fake environment answers through `onCommand`, so upstream's `holdCommand`/`rejectPendingCommand` are not carried; a handler rejecting with `OrchestrationV2DispatchCommandError` now answers with that error. The test sets `serverResolvedCommandContext` like the sibling send tests.
- L19: threadRequests.test.ts, threads-sync.test.ts, questionAttachments.test.ts (cancelled and expired), ComposerPendingUserInputPanel.navigation.browser.test.tsx; useComposerSend.question.browser.test.tsx announces with statuses.
- L22: upstream's `isComposerSubmissionBlocked` tests were already in GOAT.

## Fail-first (code before each fix)

- L21 drafts (composerDraftPersistStorage.test.ts, on 818a075ab3): 5 failed. `expected { alpha: 'alpha draft', …(1) } to deeply equal …` (both orders), `expected { alpha: undefined, beta: undefined }` (removal), `Cannot read properties of null (reading 'state')` (pagehide before debounce), `expected '{"state":…' to be null` (the write did not wait for the held lock).
- L21 settings and stash: 6 failed. Stash `expected [ 'this-tab' ] to deeply equal [ 'this-tab', 'other-tab' ]`, `expected [ 'other-tab' ] …`, `expected undefined to be 'shared'`; settings `expected { …(81) } to match object { timestampFormat: '12-hour', … }` (both orders) and the storage-event case.
- L20 (ChatView.browser.test.tsx): `expect(element).not.toBeInTheDocument()`, Matcher did not succeed in time: the failed row stayed in the timeline.
- L19 client-runtime: 2 failed, `expected [ Array(5) ] to deeply equal [ Array(3) ]` and the sync announcement lacking `unansweredRequestIds`. Web (after upstream's store move only): 4 failed, cancelled and expired `expected { prompt: 'Earlier draft', … } to match object …`, the attachment move, and the resolved case. Mobile: the module is new, so its fail-first is only `restoreMissingComposerFileReferences is not a function` (1 failed, 1 passed).
- L22: useComposerSend.question.browser.test.tsx `expected "vi.fn()" to not be called at all, but actually been called 1 times` (the answer was sent); composerSubmission.test.ts `sideChatCommandOverAnswer is not a function`.

## Gate

- `f4044724aa` (pen-mac-studio, after merging origin/dev at 3182a54238): `node scripts/goat-rename.ts --check` 0. `set -o pipefail; vp run check:changed` exit 0: format, lint, knip 1/2 and 2/2, agent surface audit, agent context budget, typecheck (8 packages) pass; test 179 files, 5536 tests pass.
- The first run on `1dd6ac8850`+merge exited 1: all 5536 tests passed, but Vitest reported one unhandled rejection (`Error: disk full`) from settingsPersistence.hook.browser.test.tsx. Cause: the settings write now starts once the Web Lock is granted, a task after the click, and the test rejected its pre-built promise before `setClientSettings` had taken it. With the lock bypassed the error went away; f4044724aa makes the test wait for the write first.
- No known issue was hit; no PID was stopped.

## Surfaces

- Entry points: drafts, settings (all pages) and the stash share the storage paths; `/side` from the composer only (the command palette has no answer path).
- Clients: web for all four; mobile for O2 (unsent-question-answers.ts). Desktop wraps web; its settings read and write through the bridge and go through the same merge.
- Providers: none provider-specific; O2 depends on runtime request status, which every adapter reports.
- Real client (web dev server on this worktree, GOAT's browser): two tabs of one browser context; tab B turned Render math on, then tab A turned Keep composer context on; after reloading tab A both are on, and tab B showed A's change live. Capture: /tmp/n1-c1-two-tabs-after-reload.png. Replay `question`: Stop on an open question ends the run with "Stopped by user" and no console errors.
- Captures stay in /tmp until the coordinator names the PR.

## Code budgets

`git diff origin/dev -- oxlint-plugin-goat/code-budgets.json`: composerDraftStore.ts 4508 → 4477, useComposerSend.ts 1808 → 1675. No entry raised; the intermediate move-outs leave useComposerSend.ts at 1808 and each port lowers it to the file's length. New files are under 200 lines.

## Known limits

- Cross-tab localStorage in Chromium propagates between renderer processes asynchronously; the lock serializes read-merge-write between tabs but cannot make a write another process has not delivered yet visible. Upstream has the same window.
- A failed send's stash entry keeps a file only when its upload is ready in this environment; others are named in the entry's unreadable list. Images over the stash size limit are named as dropped, as for a stashed prompt.
- A cancelled answer's attachments past the composer limit stay behind and are released with the question (web and mobile).
- The mobile half of O2 has unit tests only; its device capture is owed to the N15a device pass.

## NOT RUN

- Real-client O2 and O4: the Replay `question` scenario takes options only (no custom answer), so nothing can be typed as an answer; covered by questionAttachments.test.ts, unsent-question-answers.test.ts and useComposerSend.question.browser.test.tsx.
- Real-client O3 (needs a server to reject a dispatch); covered by the ChatView.browser.test.tsx scenario.
- Before captures on dev for C1; the two-tab unit tests fail on dev's code (above).
- Mobile device pass (N15a).
- Full suite (`ci:full`).
