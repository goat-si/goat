APPROVE WITH NITS db856aaa0116bd06c0098c51f52606d90492499c

The push fixes N14F-P2-1 as ruled. One rule, `replyHolderIsHeld`, guards the three places the ruling named. Its tests now rest on the real shell atom instead of a planted deleted shell, and I ran fail-first and mutations to confirm that each place has a case that catches it. The inbox fix (N14F-P3-3) stores only what the person edited and leaves what gets submitted unchanged. N14F-P3-4 and N14F-P3-5 are done as ruled.

I found no P0, P1 or P2. There are two new P3s:

- **P3-A:** the client holds a much smaller set of thread shells than the ruling assumed. Because of that, "the client holds no shell" is wrong in an ordinary case, and the toast and the guide then blame deletion or archiving for a thread that is live.
- **P3-B:** a queued-message edit skips the holder check.

There is also one correction to the author's NOT RUN: an existing test harness does reach turn start, so the call-site test for N14F-P3-2 is cheap (see "The call-site test").

**Lane N14 may merge into chase/t3-261114-next2 at this head now.** The quick run 44150775263 has already finished green on this exact head.

`git ls-remote` gave db856aaa01 for the lane at the start and again at 19:04 UTC. The integration branch was eb46f07428 both times.

## Findings

**P3-A. The client reads "I hold no shell for this thread" as "deleted or archived", but a web client does not hold most older settled threads.**

- **Where.**
  - The rule and the toast sentence: `composerReply.tsx:74-80` and `:94-101`. The rule's other two uses: `composerReply.tsx:146-153` and `TimelineAssistantRows.tsx:246-250`.
  - The user guide clause: `docs/user/composer.md:179-180`.
- **What a web client holds (READ).**
  - A current server advertises `shellThreadFamilies` and `shellOlderSettled` (`ws.ts:1655-1656`), and the web client opts in (`client-runtime state/shell.ts:437-438`).
  - With that on, the shell snapshot keeps every unsettled thread, but of the settled top-level threads only the 25 newest across the whole environment. Pinned and snoozed threads are also kept, and so are the parents of live subagents (`ShellStream.ts:127-173`).
  - Threads settle automatically by default. Auto-settle dispatches `thread.settle` (`Orchestrator.ts:12274-12298`), which sets `settledOverride: "settled"` (`:3224`).
  - Collapsed projects and other projects do not matter, because the snapshot covers the whole environment. Remote and SSH environments follow the same rules on their own servers.
- **How a cut thread can come back (READ).** `threadShellAtom` reads the shell merged with mounted family reads (`threadShell.ts:284-295`, `threadFamilies.ts:378-421`). A cut thread returns only in four ways:
  - through the open thread's family read, which is mounted only when the open thread itself is missing from the shell (`ThreadRouteView.tsx:140-148` and `:38-49`);
  - through Settled shelf pages, only while the shelf is expanded (`olderSettledShelf.ts:27`, `:42-58`);
  - through search results;
  - through a shell update when the thread changes.

  A fork carries no `launchedBy` (`ThreadForkService.ts:94-100`), so `keepLocalLaunchers` does not keep a fork's source either.
- **Trigger.** The person forks an older, automatically settled thread A and works in the fork F. F is new and unsettled, so the snapshot keeps it, and its family is never mounted. A is cut.
- **What the person sees.** Nothing is silently dropped; every error is in the safe direction.
  1. Reply is missing on every row F inherits from A. This is not a brief gap: it lasts as long as A is not held. The ruling accepted this cost for "a live holder the client does not list", but its examples (a subagent, a forked side chat) are edge cases, while forking an old thread is common.
  2. A reply is drafted while A was held, for example because A was still among the 25 newest, or loaded on the shelf, or delivered by an update this session. It is sent after A has stopped being held. Two ordinary ways that happens:
     - the next full snapshot after a server restart or update, since the client resumes a cached snapshot only on the same server instance (`state/shell.ts:462-466`);
     - collapsing the Settled shelf.

     The send is refused with "The thread that held it was deleted or archived". A is live, and the server would have accepted the reply. The draft and the card stay intact, but once the person cancels the card, they cannot add the reply again in F.
  3. A stashed reply to A restores without its card, and the reply is lost for good, because the stash entry is taken before the restore runs (`useComposerStash.ts:194`, `:209`).

  The guide's clause leads a reader who sees no Reply to conclude the source was deleted or archived.
- **Likelihood.** Case 1 is ordinary for anyone with more than 25 settled threads. Case 2 needs a reply draft kept across a restart, an update, or a shelf collapse, which is uncommon.

  A reconnect matters only when F is itself cut and family-mounted. Family rows clear on a new connection generation (`threadFamilies.ts:241-253`) and return after one read, and sending is blocked while disconnected (`useComposerSend.ts:499-511`). So that window is one round trip.
- **Smallest fix.** There are two options; the second needs a coordinator decision.
  - **No fetch:** make the sentence and the guide clause true for every cause, for example "GOAT can't find the thread that held it here. It may have been deleted or archived. Cancel the reply above the composer and send again."
  - **The real fix, which needs one read the ruling excluded:** also mount the open thread's family when it is a run fork whose source has no shell. Concretely, `useOpenThreadFamily(serverThreadRef, bootstrapComplete && (unlistedThreadRef !== null || forkSourceMissing))`. The family read returns every active thread in the lineage, so a live source comes back and a deleted or archived one does not, which matches the server's answer except for archived threads.
- **Basis.** RAN a scratch case on the head's `shellSnapshotForSubscriber` with 25 newer settled threads, one older settled source and a fresh fork: the fork is kept and the source is cut (`notes/reviewN14r3.shellWindow.test.ts`). READ the client path above. INFERRED that a thread arriving as a shell update stays until the next full snapshot; I did not check whether opening A counts as such an update. NOT RUN in a real client.

**P3-B. A queued-message edit skips the holder check.**

- **Where.**
  - `composerReply.tsx:90` returns false for a DraftId.
  - While a queued message is being edited, the composer target is a DraftId (`useQueuedRunEdit.ts:239-240`).
  - `beginEdit` puts the queued message's reply into that draft (`useQueuedRunEdit.ts:279-288`).
  - The save after the gate (`useComposerSend.ts:738-755`) sends `content.replyTo` (`useQueuedRunEdit.ts:152-166`).
- **Trigger.** A reply to an inherited row is queued behind a running turn. The person deletes or archives the source, then edits the queued message and saves it.
- **Consequence.** The edit shows a normal reply card, the save goes through with no toast, and the agent receives the reply as unavailable. Without the edit this is the accepted queued race; the edit is the one moment the client knows the holder is gone and still lets the reply through.
- **Smallest fix.** At `:709`, check against the thread the send goes to: `typeof composerDraftTarget === "string" ? activeThreadRef : composerDraftTarget`. A refusal returns before `saveEdit`, so the edit stays open with its card and the person can cancel the reply and save.
- **Basis.** RAN case 4 of `notes/reviewN14r3.callSite.browser.test.tsx`, which uses the redirect harness. With a DraftId target, an open edit and a draft reply naming a thread the client does not hold, sending calls `saveEdit` with the reply and shows no toast.

**Outside this delta, not a finding against this push (READ only).** The plan follow-up send runs after the gate (`useComposerSend.ts:826-864`). It builds its context without `replyTo` (`:856-862`), yet its text carries the reply's link (`:711`, `proposedPlan.ts:64-69`). So a Reply sent while the plan follow-up prompt is showing never carries its record. I did not run this; it deserves a look in an L18 follow-up.

## What checks out

**Item 1(a): three places and no fourth.**

`replyHolderIsHeld` is used at `TimelineAssistantRows.tsx:250`, `composerReply.tsx:149` (inside the restore) and `composerReply.tsx:93` (inside the gate called at `useComposerSend.ts:709`).

A response record enters a draft only through `setReplyTo`:

| Way in | Where | Check |
| --- | --- | --- |
| Reply button | `ChatComposer.tsx:3022-3027` | rule (i) |
| Stash restore | `useComposerStash.ts:209` | rule (ii) |
| Failed-send put-back | `chatViewSend.ts:267` | puts back a reply that just passed the gate; a resend passes `:709` again |
| Queued-message edit | `useQueuedRunEdit.ts:288` | **P3-B** |
| Persisted drafts | `composerDraftStore.ts:1686`, `:2287` | sends pass `:709` |

A pasted reply card carries only its link text; `withReplyReference` keeps a single reference (`composerReply.tsx:42-45`). It brings no record.

A record leaves the client in these ways:

- **Normal send, steer, queue behind a run, multi-model and redirect** all go out after `:709`, through `buildOutgoingMessageContext` (`:1004-1017`). I RAN the redirect path.
- **Queued-edit save** is P3-B.
- **`/side` from the composer** can't be reached with a reply. The text then starts with the reply link, so `parseSideChatCommand` does not match and the message goes out as an ordinary send. `queueSideChatQuestion` carries only the prompt (`sideChatFromComposer.ts:8-15`).
- **Paths before `:709`:** `startSideChatOverAnswer` (`:449-467`) and the SSH draft send (`:517-652`, text only at `:612`) carry no record.
- **Codex feedback command:** no record.
- **Plan follow-up:** sends no record (outside this delta, noted above).
- **Scheduled send:** no client-side scheduled send in this tree carries a reply record (`git grep`). Queued runs held by the server are the accepted race.
- **Mobile** creates no replies.

**Item 1(b): which shells the client holds.** See P3-A for the window. On reconnect, the snapshot is kept and resumed on the same server instance (`state/shell.ts:462-466`, `:491`). A server restart replaces it, which cuts older settled rows that had arrived only as updates.

On a page load, I found no state in which the composer can send while the shell set is still empty. I did not run a reload race.

**Item 1(c): the gate's inputs.**

- Only the queued edit puts a DraftId target together with a reply that names another thread (P3-B). New-thread drafts show no inherited rows, and forks are created on the server, never as drafts.
- The citation's environment is the timeline's environment (`TimelineAssistantRows.tsx:273`), and the stash restore checks environment equality (`:147`). So the citation's environment equals the target's in every path I found. If they ever differed, the thread-id-only comparison would let the reply through and the server would project it unavailable; I found no way to reach that (INFERRED).
- Lines `:655-708` only read state. A refusal returns before `snapshotComposerSend`, before any clear, queue or turn start. RAN: in my probe, the refused cases record no approval decline, no settings write and no turn.

**Item 1(d): the toast.** The text is true for deleted and archived holders and false for live holders the client does not hold (P3-A). The action it names exists: the card's "Cancel reply" (`composerReply.tsx:187-188`). It uses the same `stackedThreadToast` warning as `refuseReplyTheServerDrops`, and no toast appears when `replyTo` is null (the unit test asserts this).

**Item 1(e): restore order.** The restore checks environment, then `showsHistoryOf`, then the rule (`:146-153`). A reply to the thread's own response short-circuits at `:79`, so it needs no shell for anything. A pending reply still wins (`:158`).

**Item 1(f): differences from the server.** The client lets through a reply the server will project unavailable only in three cases: P3-B, the window before `thread.removed` reaches the client, and the plan follow-up (which sends no record at all).

**Item 2: what the tests plant.**

- The planted live parent shell `{id, deletedAt: null}` is what the rule reads from a real live shell: the shell query excludes deleted rows (`ProjectionShellThreadRows.ts:363`).
- The "gone" cases in `TimelineAssistantReply`, `stashFailedSend` and `composerReply.test` all fall through to the real atom, which returns null.
- The existing expectation in `stashFailedSend` (`toEqual(reply)`) is unchanged; only its fixture now plants a live parent.

**Fail-first (RAN).** I swapped 7e4fa90446's four production files into the head (equivalent to 05fda8829e for `apps/web`), ran, and restored them byte-identical, checked with `cmp`. The failures:

- (i) "expected [ …(1) ] to have a length of +0 but got 1";
- (ii) "expected { version: 1, kind: 'response', …(4) } to be null";
- (iii) "refuseReplyWhoseHolderIsGone is not a function" (its counterpart case fails the same way);
- the inbox case: "expected 'All files\n\nTyped in the inbox' to be 'Typed in the inbox'".

**Mutations at the head, each restored byte-identical.** Making `replyHolderIsHeld` always return true fails exactly three cases, one in each place. Dropping `|| refuseReplyWhoseHolderIsGone(...)` fails nothing across six files, including both `useComposerSend` tests and `ChatView.replySnapshot`.

**Item 3: the inbox.**

- **(a) Seeded shapes.** The only seeded shape is `{customAnswer: initialAnswer}`, and only for questions that have an `initialAnswer`, allow a custom answer, and have no draft yet (`threadRequests.ts:96-111`). Options and multi-select answers are never seeded, and attachments live in their own drafts. So the filter recognises every seeded shape. A typed answer to a suggested question has the same single-key shape (`userInputDraft.ts:119-129`), which is why the "already shown" check comes first.
- **(b) What the person loses.** Typing and then restoring the suggestion keeps the entry, because it has been shown since the first keystroke. Typing exactly the suggestion with no prior entry can't really happen, since the field already shows the suggestion; if it did, the entry would be dropped, which equals the suggestion anyway. Clearing to empty stores `""`, and seeding skips questions that already have a draft, so the suggestion does not come back. Submit is unchanged: the form builds its answers from the seeded map at render (`DecisionUserInputForm.tsx:40-41`, `:74`), and `submit` sends them as given (`useDecisionInbox.ts:137-177`).
- **(c) Stale closures.** The filter can only drop an entry that equals its suggestion and has not been shown. The shared write merges per question (`:122-125`), so a dropped entry never deletes a shared answer. Shared answers lie over local ones (`:92-97`), so the P2-2 fix still holds.
- **(d) The test's map.** It is what the form sends when the person types in "approach".

**Item 4: the small ones.**

- **N14F-P3-4:** done as ruled. The 12 case titles are identical, and only the chain case's body changed, with the same three assertions. Nit: the shared `const store = makeStore()` still pushes every read into a default array that nothing reads.
- **N14F-P3-5:** done in both places.
- **Guide clause:** written in the product's voice. Read strictly, it only states a necessary condition, so it promises nothing the accepted costs take away; but see P3-A for how it reads in practice.
- **Rules of the cycle:**
  - no existing dev expectation changed;
  - no sleeps, polling loops, per-test timeouts, retries, wall-clock deltas or frame waits;
  - browser tests use `await using`, and `router: false` carries its reason;
  - no new non-null assertions, `any` casts or React effects;
  - comments are within the cap;
  - both budget files are untouched by the delta.

  By `countLines`, `useComposerSend.ts` is 1635, equal to its entry. `composerReply.tsx` is 191 lines, `useDecisionInbox.ts` 271 and `TimelineAssistantRows.tsx` 500.

**Item 6: runs at the head, one vitest process at a time (all RAN).**

- Web, 12 files, 78 tests passed: the three reply files (13), the decisions folder (5 files, 42), the two `useComposerSend` tests (4), `useQueuedRunEdit` and `queuedMessageEdit`.
- Web, 3 more files, 9 tests passed: `composerReplyTarget`, `ChatView.replySnapshot` and `composerDraftStore.replyTo`.
- Server: `ResponseContextCheck` 12 of 12 passed.
- `tsc --noEmit` exits 0 in `apps/web` (0 errors, 21 suggestions) and in `apps/server` (0 errors).

## The call-site test

The author's claim is contradicted. `useComposerSend.redirect.browser.test.tsx` already drives `onSend` through `:709` to the turn-start command: `state.normal` is recorded as "startTurn" (`:31`), and `:177` asserts it. The question probe the author used answers a pending question, so it returns at `:449-467`, before the gate.

My probe (`notes/reviewN14r3.callSite.browser.test.tsx`, cases 1 to 3, about 60 lines) adds three cases to that harness:

- a draft reply against a server config without `replyToResponse` starts no turn;
- a draft reply whose holder the client does not hold starts no turn;
- a draft reply whose holder the client holds starts the turn.

It needs no new mocks. It uses the fixture's toast mock and the fixture's spied `entities` module for the held shell. For server configs, it reuses the implementation of the fixture's registry spy.

| Change at the head | Refusal cases | Held case |
| --- | --- | --- |
| None | pass | pass |
| `:709` call removed | both fail: "expected [ 'approval:decline', …(2) ] to deeply equal []" | passes |
| Second half of `refuseReplyThatGoesUnread` dropped | only the holder case fails | passes |

A trimmed copy added to the redirect file would be about 40 lines. Whether to make it a follow-up is the coordinator's call.

## Merge state

From `git merge-tree` only:

- The merge base with eb46f07428 is 0be6f7c7f4. The merge is clean (exit 0, tree a15fcf66db).
- No file changed on both sides. The integration side changed only `ThreadWorkspaceService.setupShell.test.ts` and `ProjectSetupScriptRunner.ts` (424f39f3a9, eb46f07428).
- None of the lane's 176 changed files refers to either of those files.

## The author's claims

**Confirmed by my runs:**

- the fail-first outputs for (i), (ii), (iii) and the inbox case, word for word;
- the three reply files at 13 of 13;
- the decisions folder at 5 files and 42 tests;
- "10 more files, 55 tests": the same set, which I ran in two groups;
- `ResponseContextCheck` 12 of 12;
- `useComposerSend.ts` staying at 1635 lines.

**Contradicted:** the NOT RUN claim that no existing send harness reaches turn start.

**Resting on the author's report:** typecheck 42 of 42 (CI's `goat-typecheck` passed on this head) and the 9 beside files with 2021 tests.

**CI:** run 44150775263 is a `workflow_dispatch` on db856aaa01. It completed successfully at 18:47:58 UTC, with `goat-scope`, `goat-check`, `goat-typecheck` and `goat-ci-result` all green.

**Scratch folder:** [/tmp/n14-r3-review-db856aaa](/tmp/n14-r3-review-db856aaa), left in place.

- `head/` is a `git archive` of the head. Its `node_modules`, including the per-package ones, are APFS-cloned from `/tmp/n14-fix-review-7e4fa904/head`.
- The lockfile blob is 34dad940e8 at the head, at 7e4fa90446 and in the source install. The install still has morphicons, which nothing uses.
- All 12 delta files `cmp` equal to the head. The two probes and every log are in `notes/`.
- The coordinator's worktree was untouched (HEAD ed7b0b15fb, clean).

NOT RUN: the 9-file beside run and `check:changed`; oxlint; typecheck of packages other than `apps/web` and `apps/server`; any real-client pass (a fork of a deleted or older-settled source, an app restart with a reply draft, a reload race); desktop; mobile native; any dev server or live Replay turn; the full CI suite.

APPROVE WITH NITS db856aaa0116bd06c0098c51f52606d90492499c
