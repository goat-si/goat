# N1: web saves and composer (lane record)

Lane branch: `chase/t3-261114-n1-web-saves`, from origin/dev `02511156b0`, merged with origin/dev at `3182a54238` (merge `d6257bb019`). Lane head `232e473f333a4a3bc411239b75a92258e2172041` (review round 1 fixes on top of `f4044724aa`), pushed. Not merged anywhere yet; the coordinator merges reviewed lane heads into `chase/t3-261114-next`. Host pen-mac-studio. Class: L21 is C4 (the merge decides which saved user data survives; ruling N1-P3-4), with P2-1 as its older-data case; L19, L20 and L22 keep #3176's labels. Stored shape and wire are unchanged.

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
  Coordinator authorisation, 2026-11-16, rule 3: in apps/web/src/hooks/useSettings.test.ts the getClientSettings call-count expectations at :99-100 (2 to 3) and :125-126 (once to 2) may change. Reason: ruling C1 B adds one read of the stored settings under the lock before each save, so each of these saves reads once more than on dev. No other expectation in an existing dev test may change in this lane.
  The round 1 move (P3-5) and fix (P2-1) left both counts as authorised (3 and 2).
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

## Review round 1 (f4044724aa: BLOCK, 2 P2, 5 P3)

Rulings: /Users/jun/handoff-in/chase/next-N1-coordinator-rulings.md; report: next-N1-review-f4044724.md. One commit per ruling on top of f4044724aa, then origin/dev merged last.

| ruling           | commit       | what changed                                                                                                                                                                  |
| ---------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1-P3-5          | `817ade3a2c` | verbatim move of the settings merge into apps/web/src/hooks/clientSettingsMerge.ts (before the P2-1 fix); it takes the baseline as an argument and resolves with the next one |
| N1-P2-1          | `cbf21f61c7` | the merge folds the stored value (foldLegacyFirstRunPrompt) before copying untouched keys                                                                                     |
| N1-P3-1          | `92b49e89e0` | attachment-only failed send with a rejected stash write names the lost attachments; image warnings shared with the composer stash (reportStashedImages)                       |
| N1-P3-2          | `5d6b34e4ac` | appendAnswerToDraft in client-runtime is the one join rule; web and mobile call it; composerDraftText.ts unchanged                                                            |
| N1-P3-4          | `6ca002a2f8` | the cleared-draft test gives the other tab a copy of alpha before it is cleared                                                                                               |
| N1-P2-2, N1-P3-3 | record       | the authorisation quoted under Decisions (C1); three Known limits below                                                                                                       |

Fail-first, round 1:

- P2-1 (useSettings.test.ts "keeps a first-run answer stored under the legacy key when another setting is saved", on 817ade3a2c): `AssertionError: expected 'pending' to be 'answered'`, 1 failed, 33 passed.
- P3-1 (new stashFailedSend.test.ts, on cbf21f61c7): `expected "vi.fn()" to be called once, but got 0 times` (no toast for the rejected attachment-only stash) and `expected "vi.fn()" to be called with arguments: [ ObjectContaining{…} ]` (no "Stashed images did not attach"); 2 failed.
- P3-2 (the shared case, on 92b49e89e0): client-runtime `appendAnswerToDraft is not a function` (2 failed); mobile `Received` lacked the second and third "Yes" (1 failed, 2 passed); web passed already, since the rule is web's.
- P3-4: with the pre-port store and persist storage from 818a075ab3, `- "alpha": undefined  + "alpha": "alpha draft"`; passes on the fix.

Gate, round 1: on `232e473f33` (the fixes merged with origin/dev at `0eb911bba8`; N13b had no gate running on pen-mac-studio): `node scripts/goat-rename.ts --check` 0; `set -o pipefail; vp run check:changed` exit 0, with format, lint, knip 1/2 and 2/2, agent surface audit, agent context budget and typecheck (8 packages) passing, and 182 test files, 5636 tests passing with no unhandled errors. Budgets unchanged from round 0 (composerDraftStore.ts 4477, useComposerSend.ts 1675); useSettings.ts is 972 lines (991 before the move).

## Known limits

- Cross-tab localStorage in Chromium propagates between renderer processes asynchronously; the lock serializes read-merge-write between tabs but cannot make a write another process has not delivered yet visible. Upstream has the same window.
- A failed send's stash entry keeps a file only when its upload is ready in this environment; others are named in the entry's unreadable list. Images over the stash size limit are named as dropped, as for a stashed prompt.
- A cancelled answer's attachments past the composer limit stay behind and are released with the question (web and mobile).
- The mobile half of O2 has unit tests only; its device capture is owed to the N15a device pass.
- `/side` typed in mobile's PendingUserInputCard field, or in the Decisions inbox on web and mobile (DecisionUserInputForm.tsx, useDecisionInbox.ts), is still sent as the answer: O4 was ruled for the composer.
- Answers typed in the Decisions inbox live in component state, so Stop still discards them on web and mobile (O2 covers the composer's answer drafts).
- A tab still running the old bundle writes whole drafts, settings and stash values. Drafts that tab erases are not restored by a new-bundle tab, which rewrites only drafts it edits, until the old tab reloads.
- The Decisions-inbox and mobile-card rows above go to next-pr-plan.md (lane coordinator). In my opinion N15b (mobile parity) owns them: three of the four surfaces are mobile (PendingUserInputCard, the mobile inbox for /side and for Stop), and the web inbox change is the same small rule.

## NOT RUN

- Real-client O2 and O4: the Replay `question` scenario takes options only (no custom answer), so nothing can be typed as an answer; covered by questionAttachments.test.ts, unsent-question-answers.test.ts and useComposerSend.question.browser.test.tsx.
- Real-client O3 (needs a server to reject a dispatch); covered by the ChatView.browser.test.tsx scenario.
- Before captures on dev for C1; the two-tab unit tests fail on dev's code (above).
- Mobile device pass (N15a).
- Full suite (`ci:full`).
