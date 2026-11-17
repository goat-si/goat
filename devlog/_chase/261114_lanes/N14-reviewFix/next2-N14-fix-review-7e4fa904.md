BLOCK 7e4fa9044645b39817f819863b84b5e15c6fb747

I'm blocking on one new P2 inside the P2-1 fix. In a fork whose source thread was deleted, Reply is still offered on the rows the fork inherited, and the agent receives the reply as unavailable while the person sees a normal card. The round's deleted-source guard reads a shell that a real web client never holds, and its test plants that shell, which is the same pattern behind the original P2-1. The rest of the round holds. The ancestry walk is correct and cheap. P2-2 is fixed, and reviewer A's failing probe now passes. Every P3 is done as ruled, and the merge of 0be6f7c7f4 is clean and correctly resolved.

The remote head was 7e4fa9044645b39817f819863b84b5e15c6fb747 by `git ls-remote` at the start and again at the end (17:49 UTC).

## Findings

**P2-1. A fork of a deleted thread offers Reply on its inherited rows, and the agent receives the reply as unavailable.**

- **Where:** `apps/web/src/components/chat/TimelineAssistantRows.tsx:247-248` hides Reply only when `useThreadShell(inheritedFrom)?.deletedAt != null`. A client never holds a deleted thread's shell:
  - the shell query skips deleted rows (`ProjectionShellThreadRows.ts:363`);
  - the shell stream sends a deletion as `thread.removed` (`ShellStream.ts:653`);
  - the reducer drops that shell (`shellReducer.ts:184-190`).

  So the hook returns null and Reply stays. Meanwhile the fork keeps showing the deleted source's rows, because `readTimelineIndex` reads the source with no deleted check (`ProjectionStore.ts:5523-5526`). That is by design: `runtimeLayer.forkDeletion.test.ts:151` is titled "deleting a source keeps … its live fork shows". The server refuses a deleted holding thread (`ResponseContextCheck.ts:51`).
- **Trigger:** fork a thread, delete the original, open the fork, press Reply on an inherited response, and send. This is not a race. The state survives reloads.
- **Consequence:** the person sees a normal reply card and a normal sent card. The agent gets `<context kind="response" id="…" unavailable="true"/>` with no read line. That is the silent drop ruled out at 12:57:11 (i) and the 16:38:35 condition "never a record the server will project unavailable". `docs/user/composer.md:177` is false in that thread. The round's test "offers no Reply on a row inherited from a deleted thread" (`TimelineAssistantReply.browser.test.tsx:114`) passes only because it plants `{id: PARENT, deletedAt}` in the shell atom.
- **Smallest fix:** on an inherited row, offer Reply only while the client holds a live shell for the holding thread (`useThreadShell(inheritedFrom)` non-null and not deleted). Give `restoreStashedReply` the same requirement: `composerReply.tsx:77` compares ids before it reads any shell, so it accepts a deleted direct parent. Rewrite the test to render with no shell for the parent, since that is what a client holds after a deletion. The cost is that rows inherited from an archived thread also lose Reply, because archived shells are not in the active index (`threadShell.ts:194-210`). That is a missing action, which the person can see, not a silent drop.
- **Basis:** RAN a scratch test on the real store and orchestrator ([reviewN14fix.deletedSource.test.ts](/tmp/n14-fix-review-7e4fa904/notes/reviewN14fix.deletedSource.test.ts), using the layer from `runtimeLayer.forkDeletion.test.ts`). It creates a source thread, writes a completed run with an assistant message, forks, and deletes the source.
  - Before the delete, the fork's row is inherited with `sourceThreadId` "review-source", and the provider text has the `thread.read` line.
  - After the delete, `getThreadShell(source)` is null and the source is in neither list of `getShellSnapshot`.
  - The fork still shows the inherited assistant row with `sourceThreadId` "review-source".
  - The provider text becomes `<context kind="response" id="response_r1" unavailable="true"/>`.

  Also RAN: the lane's own first case in `TimelineAssistantReply.browser.test.tsx` renders Reply on an inherited row with no shell for the holding thread. READ: the shell path above.

**P3-1. Deletion races are still silent.**

- **Where:** the draft's reply card, a queued or scheduled message, and a stashed reply all go out unchanged after the holding thread is deleted.
- **Trigger:** the holding thread is deleted while a reply is drafted, queued, scheduled or stashed. A stash restore passes the check at `composerReply.tsx:77` for a deleted direct holder.
- **Consequence:** each arrives as unavailable with no notice.
- **Smallest fix:** run the P2-1 check at the send gate too, beside `refuseReplyTheServerDrops` (`useComposerSend.ts:709`). That covers drafts and stashes. A queued or scheduled send that fires after a deletion stays a race to state.
- **Basis:** READ.

**P3-2. The send gate's call site has no test.**

- **Where:** removing the `if (refuseReplyTheServerDrops(...)) return;` call at `useComposerSend.ts:709` leaves every test green. Only `composerReply.test.ts` refers to the gate.
- **Trigger:** a future edit drops or moves that line.
- **Consequence:** the 16:38:35 ruling's "sends nothing" holds only by reading the code.
- **Smallest fix:** one `useComposerSend` case showing that a draft reply against a config without `replyToResponse` starts no turn.
- **Basis:** RAN the mutations of the gate functions (see item 3) and a `git grep` of the web tests.

**P3-3. The Decisions inbox stores suggested answers as if typed.** This has been there since 2a94ed4deb; the round kept it.

- **Where:** the form sends `{...seeded, …}` (`DecisionUserInputForm.tsx:67-70`, `:96-99` and `:112-119`). `useDecisionInbox.ts:95-98` stores that whole map, including the `initialAnswer` seeds. The composer stores only edits (`usePendingThreadRequests.ts:171`).
- **Trigger:** a request whose other questions carry suggested answers. The person answers one question in the inbox, then Stops.
- **Consequence:** Stop appends every stored answer to the thread draft (`questionAttachments.ts:150-157`). The provider's suggestions for untouched questions land in the person's draft.
- **Smallest fix:** write only the edited question to the shared store.
- **Basis:** READ, and INFERRED for the Stop outcome. I did not run it.

**P3-4. `ResponseContextCheck.test.ts:90` keeps a module-level mutable `threadReads` array.** Every case appends to it, and only the chain case resets it (`:242`). It works because the cases run in order, but it breaks the no-module-state rule. Smallest fix: create it inside the chain case through a store factory. Basis: READ.

**P3-5. "A side chat is a run fork" is not always true.**

- **Where:** the comment at `ResponseContextCheck.ts:44`, and the fork-delta line ("side chat 부모 포함").
- **Trigger:** a side chat opened before its parent has a completed turn. It is created without a fork (`SideChatSurface.tsx:76-104` → `Orchestrator.ts:2485-2486`, `forkedFrom: null`), and the round removed the old `sideChatOf` admission.
- **Consequence:** nothing breaks. Such a side chat inherits no rows, and `restoreStashedReply` follows forks only (`composerReply.tsx:82`).
- **Smallest fix:** say "a forked side chat" in both places.
- **Basis:** READ.

## What checks out

**Item 1, P2-1 (apart from the finding).**

**(a) Bound and cost.** The walk has no fixed cap. It stops at the chain's real length or a repeated thread.
- **One hop:** `getThread`, a primary-key `SELECT payload_json` on the thread row plus a decode of the thread payload, with no items (`ProjectionStore.ts:4569-4587`). It runs on the reader pool (`readOnReader(getThread)`, `:7553`).
- **Where it runs:** in the effect worker at turn start (`EffectWorker.ts:402` → `ProviderTurnStartService`) and at steer (`ProviderTurnControlService`), outside the orchestrator's serialized command handling.
- **When it runs at all:** messages without a response record skip it (`BuiltInSkillText.ts:31`, `ResponseContextCheck.ts:38`).
- **Real cost:** a reply on a 40-fork chain costs 41 small point reads at turn start, and the same again at a steer. The fork's own timeline read already walks that chain with heavier reads. That is not a finding. RAN: the chain case reads 42 threads, each once.

**(b) What is admitted.**

| Named in the record | Result | Pinned by a test |
| --- | --- | --- |
| An item of the receiving thread | admitted | yes |
| Inherited from the parent | admitted | yes, plus my real-store probe |
| Inherited from a grandparent | admitted | yes (`forkOfFork`, `sideOfFork`) |
| An item the ancestor gained after the fork point | admitted (no fork-point check) | no |
| An item id missing from the named thread | unavailable | yes |
| A sibling fork, a child | unavailable | yes |
| Another environment | unavailable | yes |
| A deleted ancestor | unavailable, never named | yes |
| An archived ancestor | admitted | yes |
| An ancestor in another project | admitted | yes |

- **Items after the fork point:** admitting them gives the agent nothing new. `thread.read` already reaches any non-deleted thread on this server (see "The open ruling"), the line carries only ids, and only a stash restore could carry such an item.
- **Deleted ancestors:** RAN. The unavailable element carries only the context id, and the visible reference carries only the label.
- **Handoff, subagent and delegated-task threads:** none are run forks. Only `ThreadForkService.ts:128` writes `forkedFrom {type:"run"}`; task and subagent children use `node`, and provider handoffs stay inside one app thread. Their rows are their own, so Reply names the thread itself.

**(d) Every remaining way to see a normal card while the agent gets unavailable.**
- A deleted source, before or after the fork is opened: P2-1.
- Deletion between drafting, queueing, scheduling or stashing and the send: P3-1, a race.
- A stash restored in a different thread:
  - it accepts a deleted direct holder (P3-1);
  - it refuses to walk through an archived or deleted intermediate thread that the server would read past. That is the safe direction: the card just isn't restored.
- A row whose source the client knows but the walk cannot reach: rows come only from the thread itself and its run-fork ancestry (`ProjectionStore.ts:5523-5575`; visibility is local, inherited or synthetic). That is the same relation the walk follows, so deletion is the only gap. An ancestor read error ends the walk without a log (`ResponseContextCheck.ts:50`), but only on a store error, as ruled.
- A server without the capability: Reply is hidden, and a draft reply is refused with a toast. Not silent; RAN.
- Mobile creates no replies.

**(e) Client and server agree.** Both follow only `forkedFrom.type === "run"`, with a seen-set, and differ only in the deletion and archive cases above.
- **Go to source:** the card uses `assistantCitationNavigation(replyTo.citation)` (`composerReply.tsx:129`). It routes to `citation.threadId`, which is now the holding thread.
- **Subagent titles:** they are sent only for the thread's own rows (`TimelineAssistantRows.tsx:275`). `readResponseSubagents` reads the receiving thread's projection, which lists only its own subagents, so the client has no list for an ancestor's rows.

**(f) Tests.** The server test now feeds the shape the client sends: the holding thread's id and its item id. RAN, with the pre-fix files swapped in at the head and restored byte-identical (`cmp`):
- Pre-fix `ResponseContextCheck.ts`: 3 of 12 fail, the two-forks-up, chain and deleted-ancestor cases.
- Pre-fix `TimelineAssistantRows.tsx`: 2 of 3 fail. The citation named "side-chat", and Reply showed on the planted deleted row.

The deleted-row case is P2-1.

**(g) The user guide.** `composer.md:177` is now true in side chats and in forks of live or archived sources. It is false only in P2-1's case.

**Item 2, P2-2: fixed.**
- **Which side wins:** the inbox lays the shared answers over its own drafts per question, and the shared answer wins (`useDecisionInbox.ts:69-74`). It writes its drafts and merges into the shared store per question (`:87-99`).
- **No stale writes:** the form is controlled and sends its whole current map, so a write carries current values and never overwrites the composer's text. The inbox's drafts are always a subset of the shared store, so the two differ only when the shared side is ahead, and then it wins.
- **Clearing:** the composer clears by writing an empty answer and keeping the key (`usePendingThreadRequests.ts:65-96`), so no old text returns.
- **Stop returns both:** RAN. Reviewer A's `reviewN14a.unsent.browser.test.tsx` and the lane's two new cases pass at the head.
- **Requests resolved elsewhere:** they prune the shared entry (`questionAttachments.ts:183-199`), and the item leaves the feed, which prunes the inbox's drafts (`useDecisionInbox.ts:212-224`).
- **Keys:** environment, thread and request (`:43-45`).
- **Attachments:** the inbox only counts them for `/side`.
- **Render and keystroke cost:** nothing writes on render, and there is no loop between the two surfaces. The inbox is its own route (`routes/_chat.decisions.tsx`), never mounted beside a composer, so its whole-store subscription costs composer typing nothing.

**Item 3, the P3 fixes.**
- **A-P3-4, fixed as ruled.** RAN a diff of the move: the moved helpers are byte-for-byte, apart from the new file's imports and one trailing blank line. No existing test or mock changed, and the new `/side` case passes.
- **A-P3-2, fixed as ruled**, apart from the call site (P3-2). RAN mutations in the scratch tree, each restored byte-identical:
  - removing `replyToResponse: true` fails the new descriptor case (`expected undefined to be true`);
  - opening `useReplyToResponseAvailable` fails "offers no Reply when the thread's server does not check replies";
  - opening `refuseReplyTheServerDrops` fails its refusal case.
- **A-P3-3, fixed as ruled.** There is one warning per call, naming the missing service and the thread id, with no message text, and the reply is still unavailable (`BuiltInSkillText.ts:36-46`). The test case passes (RAN). The record's Replay transcript has the shape the head produces: my probe's provider text has the same context line, `starts:` line and read line (RAN). The `<user_request>` wrapper comes from turn start.
- **A-P3-1 = B-P2-1, done.** Every cited line is true at the merged head:
  - `LegacySidebar.tsx:3502` is `routeTerminalOpen`;
  - `:3631` is `buildThreadJumpLabelMap`;
  - `composerReplyTarget.ts:11` is the WeakMap;
  - `composerContext.ts:294` is `environmentId`.

  The only wording issue is P3-5.
- **B-P3-2 and P3-5, done.** The record has the B-P3-1 sentence (`keybindings.ts:260-261` and `:266-270` are right for this head), the O28 corrections, and the next3 note at `next2-pr-plan.md:492` (xii).

**Item 4, the merge.**
- **Tree:** git's own merge result (`git merge-tree`) equals the merge commit's tree in every file except `useComposerSend.ts` and `code-budgets.json` (RAN).
- **Imports:** both dropped imports are unused in the merged file (RAN `grep`).
- **Budgets:** by the rule's own `countLines` (RAN), ThreadFeed.tsx is 3344, GitActionsControl.tsx 1375, LegacySidebar.tsx 3883 and useComposerSend.ts 1635.
  - ThreadFeed and useComposerSend sit below both parents because both sides deleted lines.
  - GitActionsControl takes the integration's value, and LegacySidebar takes the lane's.
  - All 326 line entries hold, and no unlisted file over 1000 lines is among the 176 files changed against the integration head.
- **Meeting points:**
  - Mobile `ThreadFeed.tsx`: the lane moved `TurnDiffStat` out and the integration moved `UserMessageCopyButton` out. These are disjoint, and no import is left unused in the merged file (RAN).
  - `useComposerSend.ts`: the reply gate at `:709` runs before any state change. SF1's `saveSettingsBeforeRedirect` (`:1228`) reads `changedBeforeDecline`, which includes the lane's reply check (`:1178-1180`).
  - `useThreadWorkspaceStatus`: its callers are ChatView, GitActionsControl and FileBrowserPanel. The lane touches only FileBrowserPanel's icon, not the hook calls at `:25` and `:498`. N4c's browser test passes (RAN).
- **Icons:** no MorphIcon or morphicons anywhere outside devlog prose (RAN `git grep`).

**Item 5, the rules.**

| File | Whose | Change in the round |
| --- | --- | --- |
| `ServerEnvironment.test.ts` | dev | one new case; nothing removed |
| `ResponseContextCheck.test.ts` | lane's own (absent at e04442e66c) | old mock thread shape (6 lines) rewritten to what the client sends, as ruled |
| `TimelineAssistantReply.browser.test.tsx` | new in this round | — |
| `composerReply.test.ts` | new in this round | — |
| `stashFailedSend.test.ts` | dev | one new case; nothing removed |
| `DecisionUserInputForm.sideChat.browser.test.tsx` | lane's own | one new case |
| `useDecisionInbox.unsent.browser.test.tsx` | lane's own | `setup` takes an item (3 lines); two new cases |

- **Test hygiene:** no sleeps, polling, timeouts, retries, wall-clock math or frame waits. Browser tests render with `await using`, and `setup()` resets the shared stores. The one module-level array is P3-4.
- **Production code:** no new non-null assertions or `any` casts (RAN `grep`), and comments are within the cap.
- **Effect budget:** `scripts/effect-budget.json` is unchanged by the round, and the round adds no React effect (RAN).
- **Where GOAT code lives:** the logic sits in GOAT modules. `TimelineAssistantRows.tsx` gains one prop and two conditions in the lane's own Reply button.

**Item 6, runs.** Everything ran one vitest process at a time, on the scratch install described below.
- **Server:** 6 files, 82 tests, all passed. They were ResponseContextCheck (12 cases, warning case included), ServerEnvironment, BuiltInSkillText, GoatSkillText, `McpToolAccess.capabilities` and `agentSurface`.
- **MCP count tests:** both files are unchanged since e04442e66c, along with `contracts/agentSurface`.
- **Web:** 12 files, 57 tests, all passed. They were TimelineAssistantReply, composerReply, stashFailedSend, the whole decisions folder plus A's probe, `useThreadWorkspaceStatus`, and the two `useComposerSend` browser tests.
- **Typecheck:** `tsc --noEmit` exits 0 in `apps/web` (21 suggestions, no errors) and in `apps/server`. The first server run flagged only `console.log` in my probe, so I moved the probe out and ran again.

## The open ruling (1c)

It can happen, but rarely. A fork always starts in its source's project, because `ThreadForkService` copies `projectId`. `thread.project.adopt-folder` (`Orchestrator.ts:3949-3995`) can later move a thread whose folder is another project's root.

I recommend **admit**. Naming that thread grants nothing new. The agent can already read it by id with `thread.read`: `loadReadableThread` (`OrchestratorMcpService.ts:893-922`) loads any non-deleted thread by id under that thread's own project, and `loadCaller` (`:772-794`) checks only the tool capability. The read is limited to this environment and nothing narrower, and the inherited rows are already part of the receiving thread's own history. Refusing would only add a second rule the web must mirror to avoid another silent drop.

## Merge state

These are from `git merge-tree` only.

| Against | Merge base | Result |
| --- | --- | --- |
| `chase/t3-261114-next2` = 0be6f7c7f4 | — | fast-forward; the merged tree e2bb9c23da equals the head's tree |
| N4d at cee19f4d19 (as briefed) | 0be6f7c7f4 | clean; no file changed on both sides |
| N4d at eb46f07428 (moved during the review, three more commits) | 0be6f7c7f4 | clean; no file changed on both sides |

N4d changes only `ThreadWorkspaceService.setupShell.test.ts` and `ProjectSetupScriptRunner.ts` at both heads.

The quick run 44137274587 is on the exact head (workflow_dispatch), but it was still queued at 17:49 UTC: `goat-scope` queued, and no job had run.

## The author's claims

**Confirmed by my runs:**
- 4 server files with 74 tests, and 12 ResponseContextCheck cases.
- The fail-first reasons for both P2-1 tests, which I checked by swapping production files at the head.
- A's probe now passes.
- The verbatim move.
- The four merge budget entries and both dropped imports.
- The merge resolution.
- No MorphIcon.
- Web and server typecheck pass.

**Contradicted:**
- "Web hides Reply on a row whose source the client knows is deleted": in practice the client never knows.
- "docs/user/composer.md:177 holds as written": false for forks of deleted sources.

**Resting on the author's report:**
- typecheck 42/42 for the other packages;
- 85 files with 2732 tests;
- the static half of check:changed;
- the live Replay run itself (its shape matches the code);
- fail-first at the lane's own test commits.

My scratch folder stays at [/tmp/n14-fix-review-7e4fa904](/tmp/n14-fix-review-7e4fa904).
- **Install:** `head/` is a `git archive` of the head. Its node_modules is APFS-cloned from `/tmp/n14a-review-2a94ed4d/head`, whose lockfile blob is 34dad940e8, the same as the head's. That install differs only in still having morphicons installed.
- **Probes and logs:** `notes/` holds my real-store probe, the budget and import scripts, and the run logs. A's inbox probe is copied to `head/apps/web/src/components/decisions/`.
- **Swapped files:** every swapped or mutated file was restored byte-identical (`cmp`).
- **Coordinator's worktree:** untouched (HEAD ed7b0b15fb, clean). Only `git fetch` wrote remote refs.

NOT RUN: the 85-file beside run and `check:changed`; typecheck of packages other than `apps/web` and `apps/server`; fail-first at the lane's test commits; desktop build; mobile native; any dev server, live Replay turn or real-client pass, including the deleted-source fork in a real browser; CI run 44137274587, still queued at 17:49 UTC.

BLOCK 7e4fa9044645b39817f819863b84b5e15c6fb747
