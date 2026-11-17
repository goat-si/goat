BLOCK 4fa174d23c46106c18e41b360693f110fd9558c2

The lane is close to mergeable. Every test file it added or changed passes at the head, the quick CI run is green on this exact head, every move-out is verbatim, the budgets match countLines, and no existing test expectation changed. I found one P2: nothing tests the rule that the new tool-call setting never hides approvals, questions or errors. The code follows that rule today, but every mutation I made to break it passed all cases on web and mobile. The brief counts that as P2. It needs only new test cases and no production change. With those cases and a green quick run, I'd approve K10 for merging into chase/t3-261114-next3.

I checked the remote head with git ls-remote at the start (08:26 KST) and at the end (08:41 KST). Both times it was 4fa174d23c46106c18e41b360693f110fd9558c2, and chase/t3-261114-next3 was 259883c788. The scratch folder is /tmp/k10-review-4fa174d2. The head is extracted under ./head with git archive, and all logs and probe outputs are under ./notes. The install was APFS-cloned from /tmp/pr3660-final-df1a69df/head. Its pnpm-lock.yaml blob is 34dad940e81d34843bb32b761a9cda77c06c8a3c, the same as the head's, and the workspace links are relative, so they point at the archive. I restored every mutation and checked it with cmp, then removed every probe file.

## Findings

**P2-1. The rule that the setting never hides certain rows has no test on web or mobile.**
- **Where:** apps/web/src/components/chat/MessagesTimeline.toolCallVisibility.ts:33-48 is zen's keep list, and :113-118 is the filter for hideSuccessful and hideAll. packages/client-runtime/src/work-log/presentation.ts:445-460 is the set of hideable items that both clients use. apps/mobile/src/lib/threadActivity.toolCallVisibility.ts:31-41 is mobile's zen keep list.
- **Trigger:** Any later edit to those lists. Zen's list keeps only what it names, so a new item kind is hidden unless someone adds it.
- **Consequence:**
  - From reading the code, the current behaviour is right. Under every setting, these rows stay: pending approvals, answered questions, errors, runtime errors, plans, and the person's own messages.
  - The controls for pending approvals and questions sit in the composer and don't depend on the setting (ChatView.tsx:3831).
  - Still, every mutation I made passed every case:
    - Letting hideAll drop a pending approval in the web filter: the web toolCallVisibility, messagePhase and MessagesTimeline.logic test files passed (3 files, 99 tests).
    - Removing the approval clause and all three error clauses from zen's list: the same 99 passed.
    - Removing `prominent` and the error clause from mobile zen's list: 2 files, 57 passed.
    - Adding approval_request, user_input_request and error to the shared hideable set: web 8 passed, mobile 1 passed.
  - The R9 plan promised this test: "hideAll never hides an approval, an error or a pending question (test)".
- **Smallest fix:** Add one case in each of the lane's own new test files, MessagesTimeline.toolCallVisibility.test.ts and threadActivity.toolCallVisibility.test.ts. It should check that hideSuccessful, hideAll and zen keep a pending approval, an answered question, an error item, a runtime.error entry, a proposed plan and the user's messages. It should also check that a Working row shows under hideAll while a tool runs. No production line changes.
- **Basis:** RAN the mutations (notes/mut3.log, mut3b.log, mut6.log, mut7w.log, mut7m.log) and READ the code.

**P3-1. The link-scan cache stores whole message texts and fills up while a message streams.**
- **Where:** packages/shared/src/threadLinks.ts:93-109.
- **Trigger:** A message streams while it contains a thread link. On web this means an unheld link. On mobile it means any link, because both entity hooks scan every message that has links.
- **Consequence:** I streamed a 100,038-character Korean message in 1,389 chunks. Afterwards 44.4 MiB was still on the heap, and only 0.2 MiB once 256 other texts had pushed those copies out. Every streamed chunk misses the cache, so it saves no work while streaming. It only helps when a second link scans the same text in the same render. The memory is bounded at 256 times the longest message, with two bytes per character for non-Latin text, so it is not a leak.
- **Smallest fix:** Cap the cache by total characters, or skip caching very long texts. Another option is to scan once per message in ChatMarkdown and pass the ids down through context.
- **Basis:** RAN a probe (notes/probe1e.json).

**P3-2. An archived thread's chip now says "Open thread", but clicking it lands on the home screen.**
- **Where:** ThreadContextChip.tsx:54-55 shows the tooltip. ThreadFamilyLookup.ts:87 answers for archived threads. threadRoutes.ts:53-55 treats an unlisted archived thread as missing, and ThreadRouteView.tsx:200-213 then navigates to "/".
- **Consequence:**
  - Before the lane, the chip showed the agent's label and "Thread no longer available". Now it shows the real title, the project icon and "Open thread".
  - The click outcome is unchanged and predates the lane. What's new is the tooltip promising something the click doesn't do.
  - Older settled threads that the shell leaves out still open normally. So one answer mixes threads that open with threads that don't, and the client can't tell them apart.
- **Smallest fix:** This needs a decision. One option is a lookupArchived key on the same answer, which is C4 and beyond the 22:03:06 ruling. The other is letting the route open an archived thread.
- **Basis:** READ and INFERRED.

**P3-3. The guard that drops unknown Codex message phases has no test.**
- **Where:** CodexAdapterV2.ts:4586-4587 and :5005-5006.
- **Consequence:** I changed the guard to store any non-null phase, and CodexAdapterV2.messagePhase.test.ts still passed 2 of 2. A probe shows why the guard matters: encoding an assistant_message with the phase "summary" through OrchestrationV2TurnItemJson throws a SchemaError at ["phase"]. Today only typecheck protects the guard (the TS2345 error the author hit).
- **Smallest fix:** Add one case that sends the phase "summary" and checks that the item is emitted without a phase.
- **Basis:** RAN the mutation and the probe.

**P3-4. The web link test counts lookup keys, and a remounted message asks the server again.**
- **Where:** MarkdownThreadLink.browser.test.tsx mocks the lookup and records keys. threadLineageLookup.ts:29-30 sets staleTimeMs 0 and idleTtlMs 0.
- **Consequence:** I counted wire requests through the real lookup. Two links in one message sent one request, and a re-render sent none. When every reader unmounts and comes back, it sends one new request. That happens when a message scrolls out of the list and back, or the person switches threads and returns. Before the lane, unheld links sent no requests at all.
- **Smallest fix:** Record this limit alongside the 22:20:16 ruling, or give the link lookup's own instance a short idle TTL.
- **Basis:** RAN a probe (notes/probe1c.json).

**P3-5. Mobile R8 has no test.** The plan named upstream's apps/mobile/src/state/entities.test.ts, but the lane didn't add it. Nothing tests the mobile title relabel at entities.ts:214 or the chip-icon atom keyed on the lookup answer at :84-145 and :231. The shared lookup in client-runtime is tested. Basis: READ.

**P3-6. Two nits.**
- CodexAdapterV2.ts:205-207 puts a `const` and its comment between import statements. It works and lint passes, but it belongs below the last import.
- The R9 record says a test shows that an older web build ignores the new key. No such test exists, though Effect Schema's default behaviour does ignore it. toolCallVisibility.test.ts tests an unknown value; mobile-preferences.test.ts does test the mobile drop.

## What checks out

**R8 (a), the ruling's conditions.**

| Condition | Result | Where | Pinned by |
| --- | --- | --- | --- |
| One optional lookupProjectIds key beside lookupTitles; no new method or capability | TRUE | threadFamilyLookup.ts:18-21; orchestrationV2.ts:3806; rpc.ts and server.ts untouched | threadFamilyLookup.test.ts:29 |
| Deleted and unknown ids absent from both maps | TRUE | ThreadFamilyLookup.ts:57-61 | ThreadFamilyLookup.test.ts:187; mutation M1 fails it (RAN) |
| Project gone gives null; chip shows the title without an icon | TRUE | ThreadFamilyLookup.ts:45-60; MarkdownThreadLink.tsx:47-49; ThreadContextChip.tsx:20-21 | the same server case; browser case 1 ("Beta") |
| Caller without the read scope refused; chip keeps its label | TRUE (server by test, client by reading) | RpcAuthorization.ts:97; web threadLinkLookup.ts:28,39-40; mobile :29,42-44 | ThreadFamilyLookup.auth.test.ts:16; no client case for a refused scope |
| Older server without lookupProjectIds shows the title only | TRUE | threadLineageLookup.ts:52 | threadLineageLookup.test.ts:168; browser case 2 |
| Older client's decode ignores the new key | TRUE | none needed | threadFamilyLookup.test.ts:29 |
| Server with families but no lookupOnly: nothing applied | TRUE | threadLineageLookup.ts:49-50 | threadLineageLookup.test.ts:168 (the family answer) |
| Condition 1: one request for many links, with the 22:20:16 relaxation | TRUE, with the remount limit in P3-4 | threadLineageLookup.ts:60-61; runtime.ts:486-491 key by contents | probe (RAN) |
| Condition 4: key and type in threadFamilyLookup.ts; Condition 5: 1c3d5f7e82 marked not applicable with its fork delta clause | TRUE | 010_fork_delta.md | n/a |

**(b) Server side.**
- Plain family reads return at ThreadFamilyLookup.ts:94, before lookupAnswer runs. Opening a thread therefore costs no extra query.
- Current clients always send lookupOnly (threadLineageLookup.ts:46). Only clients from before lookupOnly reach the family-plus-ids branch, which already returned lookupTitles before the lane.
- The new projects query runs only when lookup ids are given. Its IN list has at most 100 entries, because the input is capped at threadFamilyLookup.ts:9.
- The orchestration:read scope also covers the archived shell reads (RpcAuthorization.ts:96, :105). No client gets a narrower read than that, so the answer reveals nothing new (READ).

**(c) Request count.** My probe ran the real lookup:
- A re-render that builds a new array asks with the same key and sends no request.
- Two links in one message share one request.
- An unknown id is marked as checked, left out of the answer, and not asked again on re-read.
- 150 ids go out as pages of 100 and 50. 1,500 ids go out as 10 pages and stop at the 1,000 cap.
- A streamed chunk with the same ids keeps the same key, so it sends nothing new.
- Each remount sends one request (P3-4).

**(d) Render cost.** Before the lane, each unheld link already subscribed to every environment's thread refs (base MarkdownThreadLink.tsx:23). Now it subscribes to one environment's refs, plus the global refs until the lookup answers. Both lists only change when a thread is created, removed or archived. Held links pass markdown as null and subscribe to neither. On mobile, the two hooks per message ask with the same key, so there is one read (READ and INFERRED).

**(e) Link parsing.** Links inside code spans and fences are skipped, and a percent-decoded id is added next to the written one (RAN). Memory is covered in P3-1.

**(f) Clicking an unknown thread.** Those chips keep their label and their "Thread no longer available" tooltip, so R8 doesn't add clicks into the loading state. Back and the sidebar still work (INFERRED). Archived threads are the exception, in P3-2.

**R10, the stored phase.**
- **Both directions:** ForwardCompatibleOptional (baseSchemas.ts:55) drops a missing or unreadable value on decode, and writes nothing on encode. My probe confirmed that final_answer round-trips. An unknown string, null, or 7 decodes as absent and encodes as absent. A row without a phase keeps exactly its keys. A strict decode with a phase present still succeeds. The only stored change is that an unknown value disappears, which is what a downgraded server does with any new key. The tests that pin this are assistantMessagePhase.test.ts (all three directions) and the messagePhase tests. Outside the adapter, the server never reads the phase (INFERRED from grep).
- **Lifetime of messagePhases:** It lives on one native turn's context. It is dropped from activeTurns at :6309. Settled contexts stay in settledTurns only while background work runs, as they already did. It holds one small entry per agent message, the same growth as itemPositions, so it needs no separate limit.
- **What the person sees:** git diff 259883c788 4fa174d23c on timelineLiveRun.ts is empty (0 bytes), and the new test states GOAT's behaviour difference. In zen between a steer and the answer, the person sees their message, a Working row, the steer, the answer, and the live row with the latest line. Because upstream's zenAnswerLanded wasn't ported, GOAT keeps the Working row until the run ends, which is the safe direction. From reading the code, nothing leaves the timeline empty: the person's own message always shows.
- **The import cycle:** codexProviderThread.ts reads the two names only inside its function. CodexAdapterV2.ts uses providerThreadFromCodexThread only inside functions (:7125, :8210). No test mocks CodexAdapterV2. Keep it.
- **The fix in 4fa174d23c:** It does three things. It narrows stored phases from any non-null value to the three known ones. It makes CODEX_PROVIDER private again. It updates one budget line. Since 0c9c00b18e never shipped on its own, nothing changes compared with the base.

**R9, the client setting.**
- **Decode:** My probe decoded a stored value for each case. A missing key, "zen", "future-value" and "" all decode, with the unknown strings reading as showAll. 42, null and an object fail the whole settings decode. Before the lane, a sibling key already behaved that way, and worse: chatWidth fails the whole decode on 42 and even on "future-width". An unknown value is written back as "showAll" by this build's next save, which is the normal tradeoff.
- **Entry points:** The web Beta row has a Reset button. The setting is also reachable through settings search and the command palette (CommandPalette.tsx:1779 maps every settings search item). On mobile it is under Thread behavior and in mobile search.
- **Performance:** The filter runs once per derivation, through useTimelineRows.ts:42-60 and sameRowsInput. The setting is read with a selector that returns a plain value, so other settings don't trigger re-renders. With showAll it returns the same array. The streaming fast path compares plain values, so it stays fast. Mobile caches the visible groups per group in a WeakMap. One extra pass over the entries now runs for every setting; it belongs to R10's kept replies, not to R9.
- **The guide:** docs/user/activity-log.md matches the code and is written in the product's voice.

**Smaller rows (READ).**
- 165bf05a7b: the render test spies on the real SortableThreadRow.
- 612955b6cf and c4dd232439: neither one bypasses the send gate. A newer draft that holds a reply counts as having content, so the restore returns before overwriting it.
- R7 searches only projects in the same environment and returns that project's absolute path.

## The open questions

- **1(b):** The new query runs only when lookup ids are given, never on a plain family read. Its list is bounded at 100, and its scope is the same one that reads archived shells. Keep it.
- **1(c):** The lookup is keyed by contents, so re-renders, a second link in the same message and streamed chunks all reuse one request. A remount sends one more. Accept that and record it, or add a short idle TTL.
- **1(d):** The subscriptions are no wider than before the lane, and held links subscribe to nothing. Keep them.
- **2(b):** messagePhases lives for one turn and holds one small entry per message. No limit is needed.
- **2(d):** The cycle is safe because neither side touches the other's names when the module loads. Keep it, because moving the names would add churn to an upstream-shared file for no gain.
- **3(a):** Only non-string values fail the whole decode, the same as every sibling key. Strings never fail it, and unknown strings come back as showAll. No change is needed.

## Rule 3 and the move-outs

I compared lines for each move-out commit: 93a0d86ae0, ac8ccf4c97, c39bebb583, f82c80353c, 26f0f66855, ea0b38c008, c9c89316f9, 7c36a98321 and 077e48d6d1. After stripping added `export` keywords, the lines removed and added differ only in imports, re-exports, and one header comment in codexProviderThread.ts (notes/moved-1.txt to moved-3.txt). The moved effect keeps its disable reason.

Every budget entry the lane touched equals countLines at the head, and only useComposerSend.ts goes above its base value (1540 to 1543, as accepted). The entries are:

| File | Base | Head |
| --- | --- | --- |
| ThreadDetailScreen.tsx | 1815 | 1661 |
| ThreadFeed.tsx | 3344 | 3338 |
| threadActivity.ts | 2171 | 2101 |
| CodexAdapterV2.ts | 8284 | 8257 |
| ChatMarkdown.tsx | 1679 | 1662 |
| ChatView.logic.ts | 1586 | 1550 |
| MessagesTimeline.logic.ts | 2504 | 2460 |
| MessagesTimeline.tsx | 1596 | 1563 |
| useComposerSend.ts | 1540 | 1543 |
| orchestrationV2.ts | 4438 | 4399 |
| settings.ts | 2052 | 2007 |

The non-null counts move from threadActivity (29 to 28) to threadActivityGroups (1).

Eight test files that existed at the base changed, and all with zero removed lines. Every change is a new case or an added import. The new browser tests use `await using`, `expect.element`, and a reset at the top of each test, with no sleeps or timeouts.

## Merge state

origin/chase/t3-261114-next3 is still at 259883c788 and the head contains it. git merge-tree gives tree e737cf6871, which is the head's own tree, so this is a fast-forward. Against the K5 branch at 18c6644ea8 there is no conflict (tree 39cac14303). The only file changed on both sides is code-budgets.json, and it auto-merges.

## The author's claims

- I re-ran every changed test file myself:
  - web: 8 files, 40 tests passed
  - mobile: 2 files, 6 tests
  - contracts: 3 lane files plus baseSchemas, 21 tests
  - client-runtime: 1 file plus a probe, 5 tests
  - server: 3 lane files, 7 tests (T1c's two files are outside this delta)
- ProviderSessionManager.lifecycle.test.ts run alone at the head passed 6 of 6 in 6.1 s. It imports CodexAdapterV2.ts for one constant, but its failing case is a TestClock case that runs no Codex turn. That fits the author's account of a timeout under load.
- The check:changed result (exit 1, with 476 of 477 test files passing) rests on the author's report.
- I confirmed the CI run: 44198291907 is completed with conclusion success on 4fa174d23c. goat-check, goat-typecheck and goat-ci-result all succeeded.

## For the real-client pass

- Web chips:
  - an unheld live thread shows its title and project icon
  - a thread whose project is gone shows its title and no icon
  - an archived thread: the tooltip, and where the click lands
  - a thread on another machine: does the click stay loading, and do back and the sidebar still work?
- The Beta row: each of the four settings on a busy thread, Reset, settings search, the command palette, and Korean Reset names.
- Zen during a steer and after it.
- Find while zen is on.
- A pending approval and a pending question under hideAll and zen.
- File links that point into another project.
- On mobile: link titles and icons, the Thread behavior row, and zen.

NOT RUN: any real client on web, desktop or mobile; a real Codex turn; native builds; check:changed and repo-wide checks; gt generate (so the catalog regenerate being a no-op rests on the record); a run of the full MessagesTimeline suites beyond the three files above; the mobile file-link copy-path comparison; and any measurement of request counts on a live server.

BLOCK 4fa174d23c46106c18e41b360693f110fd9558c2


