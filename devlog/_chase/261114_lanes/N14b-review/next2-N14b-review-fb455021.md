APPROVE WITH NITS fb4550219b975f42075534c6db9f5277ffbdae73

I found no P0, P1 or P2. The relaxed restore, the gate's new target and the plan follow-up record all work as the 19:50 and 20:02 UTC rulings require. For every send path a restored reply can take, the gate refuses before anything is cleared or sent. I ran the five mutations from the brief and a case catches each one. There are two P3s: one test gap and one correction to the record. **N14b may go into its follow-up pull request at this head; quick run 44167706403 has already finished green on it.**

`git ls-remote` gave fb4550219b for the branch both at the start and at 20:25:09 UTC. The integration branch was df1a69dfd2 and dev was d265257a04 both times.

## Findings

**P3-1. Nothing tests that the family read stays mounted once it brings the source.**
- **Where:** `ThreadRouteView.tsx:42` (`missing || mountedKey === key`) and `ThreadRouteView.forkFamily.browser.test.tsx:78-90`.
- **Trigger:** N14b's new condition, `forkSourceMissing`, turns false as soon as the read's own rows arrive. Only that line keeps the mount after that.
- **Consequence if the latch is lost:** each arrival releases the mount, which drops the source, which mounts again. The person would see Reply flicker on inherited rows. The lane cache means no new RPC, but the merged rows rebuild endlessly.
- **Basis (RAN):** with that line changed to `missing ? key : null`, both ThreadRouteView test files still pass (11/11).
- **Fidelity (READ):** the test mocks `useQuietThreadShell` and `threadFamilies.mount`, not the server RPC. The 25 "newer settled" shells are decoration, because the mocked hook ignores them. What it plants (no source shell) is a real state, so this is a nit, not a false pass.
- **Smallest fix:** in case 1, after the mount, add the source to `held.shells`, rerender the same route, and expect `held.released` to stay `[]`.

**P3-2. The record misstates two things.**
1. **Side chats are covered, not untouched.** `ThreadForkService.ts:127-132` gives every side chat `forkedFrom: { type: "run", … }`, so `useForkSourceMissing` (`forkSourceShell.ts:15-19`) also reads the family for a side chat whose parent is not held. That is harmless and even helps, but the record says side chats are untouched, and the route test has no side chat case.
2. **Limit (2) is narrower than recorded.** See "The recorded limits".

**Smallest fix:** correct both sentences in the record. Optionally add one side chat line to the route test.

## What checks out

**1(a) Every way a restored reply leaves the client** (READ; the paths marked RAN were also run):

| Path | Where | Passes the gate at `:709` first? |
|---|---|---|
| Plain send, steer, queue behind a run, multi-model, background send | `useComposerSend.ts:1005-1018` | Yes. RAN with the redirect harness, which reaches `startTurn`. |
| Queued-message edit save | `:738-755` | Yes, now judged against `sentTo`. RAN. |
| Plan follow-up | `:826-901` | Yes. RAN. |
| `/side` (`queueSideChatQuestion`) | `:915` | Yes, and it carries no record. |
| `startSideChatOverAnswer` | `:458` | No, it runs before the gate, but it sends no record. |
| SSH draft send | `:517-652` | Not needed: only a new-thread draft gets here, and a new-thread draft cannot hold a reply. |
| `continueThreadOnSsh` | `:319-405` | Not needed: it sends separate instructions only. |
| Client-side scheduled send | none in `apps/web/src` reads `replyTo` | Not applicable. Queued runs the server already holds are the accepted race. |
| Stash again from a restored draft | `useComposerStash.ts:466-468` | Nothing leaves the client; the next restore and send go through the same rules. |

A refusal returns at `:709`, before every clear (`:852`, `:917`, `snapshotComposerSend`). Two tests assert this:
- the holder case asserts no calls at all;
- the queued-edit case asserts that the reply is still in the draft.

**1(b) `sentTo`** (READ):
- A DraftId target with a reply exists only during a queued-message edit. That draft id is built from the route thread (`useQueuedRunEdit.ts:239-240`), and an edit needs a non-null active thread (`:236`). So `activeThreadRef` is the thread the save goes to.
- New-thread drafts never hold a reply: the Reply button sits only beside a timeline row, and the restore returns for a string target (`composerReply.tsx:151`). Forks are made on the server, never as drafts.
- **False refusal:** none for the thread's own response (`:79`) or for a held live source. The one transient case is a send in the round trip after a fork opens, before the family read lands. It is refused with the "may have been deleted" sentence, keeps the text and the card, and a resend works.
- **Missed check:** a null target with a reply cannot be reached. If it were, the capability half would still run, and the server would project the reply as unavailable.
- The citation's environment equals the target's on every path.

**1(c) The restore** (READ, plus the RAN fail-first):
- The order is environment, then `showsHistoryOf`, then "pending wins" (`composerReply.tsx:153-161`).
- `showsHistoryOf` walks the `forkedFrom` run chain through held shells. It returns true as soon as it reaches the holder, so the direct source needs no shell; that is the relaxation.
- A reply cannot land in a thread that does not show its response, because the walk must reach the holder from the target. A stash for the thread's own response still restores.
- `useComposerStash.ts` is byte for byte df1a69dfd2's (`git diff` is empty).

**2. The family read** (READ):
- **(a) Who asks.** Only run forks (including side chats) whose source has no shell. A thread that is not a fork never asks. Before the snapshot the fork's own shell is null, so it does not ask then either, and `bootstrapComplete` also gates it.
- **Cost.** One `getThreadFamily` per family per shell generation. `lane.families` caches the answer under every member's id (`threadFamilies.ts:270-271`), so reopening the fork, or opening a sibling fork, is a cache hit.
- **(b) No storm.** The mount stays until the route key changes. Readiness changes only with generation or session, and a failed read is retried only at mount (`:372-374`). For a deleted source the read settles without it, `forkSourceMissing` stays true, and nothing new is asked.
- **(c) What the person sees.** This is the same as a thread opened by link. The Settled shelf lists only rows at or above its frontier (`olderSettledShelf.ts:69`). The notification coordinator uses the merged rows only to look up parents (`ThreadNotificationCoordinator.tsx:137`). The rows leave when the route is released. I did not trace the palette, fleet or decision inbox one by one. Mobile code is unchanged and was not run.
- **(d) Older server and remote environments.** Against a server without families the read settles empty without an RPC (`threadFamilies.ts:263-268`); RAN as part of 17/17. The read goes to the fork's own environment (`ThreadRouteView.tsx:46-48`).
- **(e) The sentence and the guide.** "can't find … may have been deleted or archived" is true in every state: held, not yet read, deleted, archived, read failed. "Cancel reply" exists (`composerReply.tsx:189`). The guide clause is true, and no other copy of the old sentences remains (`rg`).
- **(f) Effects.** No new React effect. `ThreadRouteView.tsx` gains a thin call. `scripts/` and `oxlint-plugin-goat/` are untouched.

**3. The plan follow-up** (READ, RAN):
- **Before the change:** the person saw the card. The agent got the link text (`:711`, kept by `proposedPlan.ts:64-69`) but no record.
- **Now:** the record goes once, through `buildMessageContext` (`:856-863`). This path returns at `:901` and never reaches the other builder. The text always carries the reference, because a reply makes the draft text non-empty.
- **Clearing:** a successful send clears `replyTo` (`:852`). Contrary to the brief, a failed send does not keep it, since `:852` runs before the submit. That is the next3 row the coordinator ruled at 19:50.

**4. The tests:**
- **Stash fail-first (RAN):** with `composerReply.tsx` from 868116db00 swapped in, "expected undefined to deeply equal { version: 1, kind: 'response', …(4) }", 1 failed and 5 passed. The file was restored and `cmp` shows it identical. Only that restore case changed in `stashFailedSend.test.ts`; `composerReply.test.ts` changes only the toast title.
- **Mutations at the head (RAN),** each restored byte-identical:

| Mutation | Cases that fail |
|---|---|
| Drop the holder half of the gate | "holding thread … does not hold starts no turn" and "queued-message edit … refused" |
| Drop the server half | "server without replyToResponse" |
| Pass `composerDraftTarget` instead of `sentTo` | "queued-message edit" |
| Drop `replyTo` at `:861` | "plan follow-up carries its response record" |
| `useForkSourceMissing` returns false | the route test's first case |

- **Server and client-runtime tests:** test-only, and no production code under `apps/server` or `packages` changed. They pass.
- **Conventions:** no sleeps, polling loops, per-test timeouts, retries, wall-clock deltas or frame waits, and no fake timers left from the reverted wait. Non-null assertions appear only in tests. The route test's `held` object is reset by `setup()`, and it renders with `await using`. `useComposerSend.ts` is 1635 lines by `countLines`, equal to its budget entry.

**5. Runs at the head, one process at a time (RAN):**
- `apps/web`: 6 files, 23/23 (`composerReply`, `stashFailedSend`, `useComposerSend.redirect`, `ThreadRouteView.forkFamily`, `TimelineAssistantReply`, `ComposerStashMenu`).
- `apps/server`: 2 files, 14/14.
- `client-runtime` `threadFamilies`: 17/17.
- `tsc --noEmit` in `apps/web`: exit 0, 0 errors, 21 suggestions.

## The recorded limits

**(1) Fork of a fork, stash restore.** If the reply is dropped, it is a silent loss of the card: the stash entry has already been taken (`useComposerStash.ts:194`), the text comes back, and no sentence is shown. The trigger is narrower than recorded, though. When the middle thread F1 is not held, F2's source is missing, so F2's family read brings F1. The loss remains only when the restore runs within that read's round trip, or when F1 is deleted or archived. **Acceptable as recorded, P3, unlikely;** it is worth a next3 line.

**(2) Grandparent not read.** This is narrower than recorded. The family read selects threads by `rootThreadId`, and forks keep their source's root (`ThreadForkService.ts:125`). So whenever the direct source is missing, the grandparent comes too. The gap is only "the direct source is held but an older ancestor is not", and there Reply stays hidden, which is the safe direction. **Acceptable;** reword the record (P3-2).

## Merge state

From `git merge-tree` only:
- origin/dev d265257a04 is itself the merge base, so the head is a fast-forward of dev. The merge is clean (tree f00db21268) and no file changed on both sides.
- #3660 is not on dev yet (df1a69dfd2 is not an ancestor of dev).
- I could not test the merge after #3660's squash.
- The head is a fast-forward of df1a69dfd2.

## The author's claims

**Confirmed:**
- the 5 files at 21/21 (my 6-file run, adding the route test, gave 23/23);
- the fail-first line, word for word;
- no `stashedReplyCanBeJudged` or "Still loading the thread" left in `apps/web/src`;
- no sentence in the docs became untrue.

**Resting on the report:**
- typecheck 42/42 (CI's `goat-typecheck` passed on this head);
- `check:changed` with 10 files and 2037/2037.

**CI:** run 44167706403 is a `workflow_dispatch` on fb4550219b. It completed with success: `goat-scope`, `goat-check`, `goat-typecheck` and `goat-ci-result` all passed.

**Scratch folder:** [/tmp/n14b-review-fb455021](/tmp/n14b-review-fb455021), left in place.
- `head/` is a `git archive` of the head. Its `node_modules` (45 folders) are APFS-cloned from `/tmp/n14-r3-review-db856aaa/head`. The lockfile blob is 34dad940e8 in both.
- All 12 delta files `cmp` equal to the head after the swaps.
- Logs and the mutation script are in `notes/`.
- The coordinator's worktree was not touched (HEAD ed7b0b15fb, clean).

NOT RUN: `check:changed`, oxlint, typecheck outside `apps/web`, `ThreadRouteView.browser.test.tsx` without a mutation, a real-client pass (a fork outside the 25-thread window, the toast), desktop, mobile, any dev server, the merge after #3660's squash, and full CI.

APPROVE WITH NITS fb4550219b975f42075534c6db9f5277ffbdae73
