# N7 MCP command reads and scheduler (lane record)

Lane branch: `chase/t3-261114-n7-mcp-reads`, based on dev `5688d26760`, merged with the integration branch `chase/t3-261114-next` at `b2fb30748a` and with dev `97c0dd32c4` last (head `6162bd8be32e8813a7e93cbae223fdccaced0a8e`, verified on origin). N3 and N6 were not on the integration branch at the gate. Host pen-macbookpro2. Rows from #3176: `9b352a04de`, `a4d0a06e7f` (code half), `b7a224c7dd` (code half), `85b160658f`, `4aec277f79`, `5e2438ce94`. Not ported in this push: `591188471a` (needs C9 from lane N6, not on the integration branch), L13 `4aab23cd72` and `18866e52e4` (decided FULL, below; port follows as a second push of this lane).

## Rows and commits

| row | upstream | GOAT commit | result |
| --- | --- | --- | --- |
| move-out | none | `342ab734c7a25c2bd809e312dec7c633c952a592` | GOAT-only dispatchWakePolicy moves unchanged from Orchestrator.ts to goat/DelegatedTaskWakePolicy.ts (13901 to 13801) |
| move-out | none | `99978c313de2ecba1ac474b614c7f82193d0aee3` | deterministic adapter, provider snapshot and CapturedTurn move unchanged from OrchestratorMcpToolkit.integration.test.ts to OrchestratorMcpToolkit.adapter.testkit.ts; no test moves |
| move-out | none | `c94dc7a23e58555379752393a94d8e672b4b304d` | OrchestratorMcpServiceShape moves unchanged to OrchestratorMcpServiceShape.ts (type-only imports, re-exported) |
| `9b352a04de` | MCP tool calls no longer read the caller's whole thread (#33295) | `d140a8062692c2a91fbb32c8789a4a94f0a3bb17` | ported |
| move-out | none | `a427e9db572a71236a054e844ff3a076fede7157` | two GOAT-only Stop/cloud repair tests move unchanged, titles included, to Orchestrator.stopRepair.test.ts |
| `a4d0a06e7f` | sending to a very long thread reads about 5x less (#35130), code half | `95d9103b2847a284eff0583db7c9445f1d12fd40` | ported; migration 083 already in (28e7065e46) |
| `b7a224c7dd` | queued message commands read through the type index (#29521), code half | `68bd7d2859be59bbd98029fa1f62f160f2a1cfcf` | ported; 088 and its plan assertion already in (3779ebd4e3, 4fcce26fce) |
| move-out | none | `46522874b64672e5a5ddbaf0e3a7cff6a01d9099` | two GOAT-only read budget tests and threadReadLayer move unchanged to OrchestratorMcpService.responseBudget.test.ts |
| `85b160658f` | keep thread tool responses small by default (#29268) | `54e5e701c2bc6b91671761f9fc4bb76543a38f99` | ported |
| `4aec277f79` | t3_queue and handoff analytics no longer read a thread's whole history (#36130) | `c13c8321a1482aba522a87576dd30e0708fa86bd` | ported |
| move-out | none | `34148e0d05932a26b33f7ac34f0806eecad133dc` | commandReadsSkipSettledLeafNodes and the two tests that run it move unchanged to ProjectionStore.commandReads.test.ts (same suite name, same titles) |
| move-out | none | `91f67a0f568fe0d4301b8468fc5df4fcb778afb3` | GOAT-only server activity reads move unchanged from ProjectionStore.ts to goat/ServerActivityReads.ts |
| `5e2438ce94` | thousands of finished subagents read about half as much (#35178) | `762fe0f6489a1a50fc19191c8d769247cdfaaacc` | ported |
| budgets | none | `3eb581cf90c355c765f7d057e7da80a67837a7d8` | entries lowered to real length: McpHttpServer.ts 1217, OrchestratorMcpService.ts 3949, OrchestratorMcpToolkit.integration.test.ts 1092, Orchestrator.control-reads.test.ts 1655, ProjectionStore.test.ts 7673 |

Each move-out was checked byte for byte against the removed text (diff of the moved block, empty). scripts/lib/goat-rename names none of the moved test files or titles; `node scripts/goat-rename.ts --check` 0.

## Decisions and adaptations

- 9b352a04de: the caller check (loadCaller, loadThreadCaller, loadScopedThread) reads only active runs through the run status index; a task's result transfer comes from the child's transfers; the acknowledgement reads its task and spawning run by id, the wake's root node and attempts, and the remaining tasks by id. GOAT adaptations: the thread read loads only the tasks a page can name (directChildTaskIds, from upstream 9b1d351ba0, which GOAT ported earlier without it); send, interrupt, retry, waitForThread, the review ledger, remote-launch recovery and acknowledgeChildRead read only what they use; GOAT's loadScopedWaitThread folds into loadScopedThread(scope, id, []). The acknowledgement keeps GOAT's expectedRevision check and reads the parent's transfers only when a command names a revision (a child read fails for a child thread with no projection, as lazyThreads "leaves a result recorded after the read" shows). Left out: the unobserved-acknowledgement branch and readRemoteTask (GOAT has neither) and loadTargetThread (GOAT keeps targetShell). Carried tests go to GOAT's split files: executedModel test (upstream's transfer move), ProjectionStore.shellReads idle compaction test (EXPLAIN checks on the SQL store only; queryPlanFor in ProjectionStore.testkit.ts), DelegatedCompletionDelivery queued-wake test, and the integration test's read assertions with goat_task_read and goat_provider_list (GOAT's name for orchestrator_capabilities); projectionQueryTracer in OrchestratorMcpToolkit.threadRead.testkit.ts gains run, table and acknowledgement reads.
- a4d0a06e7f: the command-filter seek check is its own test in ProjectionStore.test.ts (GOAT keeps the idle compaction test in ProjectionStore.shellReads.test.ts, at its 1000-line limit); the ordinal-skip check joins GOAT's bounded SQL history test after its malformed rows are deleted.
- b7a224c7dd: upstream's edit to its own command-filter seek test is carried (turn items seek thread_type_idx).
- 85b160658f: defaults 10 threads, 10 items, 500 characters per item. The CLI's thread reads ask for 20000 characters. GOAT's other internal readers (fleet health and goals, launch watch, channel recall, remote task targets, notes) pass their own limits or read only status and results. Left out: the pageIncludesTerminalTaskResult textOffset change and its integration test edit (GOAT already acknowledges a cut-off result on the page that reaches its end) and peer/RemoteDelegation.ts (absent). Carried: upstream's activity test check (pages of 10 x 500 characters).
- 4aec277f79: GOAT splits t3_queue into goat_queue_list, goat_queue_read and goat_queue_edit; one readQueue helper reads queued runs and then their messages by id; the edit's slash-command check reads its one run and message. mcp.readThread keeps GOAT's turnItemTypes parameter and takes the record filter after it. Orchestrator and ThreadManagementService expose getMessagesById (the store already had it). Carried tests in toolkits/thread/handlers.test.ts (the handlers' own file; core.test.ts is at its budget); its toolkit layer is now layerThreadToolsWith(threads, extra).
- 5e2438ce94: carried test assertions run on the SQL store only (the replay store has no SQL client).
- Rule 3 item 4, option (a): the testkit stale hook stays as on dev. The test "a call that read the tasks before a same-id round committed cannot move that round's lane" now interleaves: the first call holds the continue lock inside its review-continue dispatch (the testkit's existing race hook), starts the second call, and waits on a Deferred that the second call's runs-only caller read completes (its last read before the lock; new testkit option beforeLock). The first call then commits; the second, waiting for the lock, reads the tasks under it and is refused. Assertions unchanged. Mutation runs: M1 moved the tasks read in reviewContinuation.ts before serialize(...) and M2 made serialize run the effect without the lock; both fail the test (the second call returns a started round instead of the refusal: "Tests 1 failed | 3 skipped (4)" each), passing again when restored.
- Orchestrator.ts budget: not lowered (13831 on the merged tree, entry 13908): lane N5 adds lines there on the integration branch.

## Coordinator rulings (verbatim)

# N7 coordinator rulings (2026-11-16)

## Rule 3 authorisation (quote verbatim in next-N7.md)

Coordinator authorisation, 2026-11-16, rule 3, lane N7 (MCP command reads and scheduler). Upstream never edits these five GOAT tests; they change because the ports (9b352a04de, 4aec277f79) stop reading the caller's or the parent's whole thread.
(1) Authorised. apps/server/src/mcp/OrchestratorMcpService.activity.test.ts, the taskStatus providerInstanceId test: the mock records the requested sections instead of options?.messageRoles, and expect(parentMessageRoles).toContainEqual([]) becomes expect(parentSections.flat()).not.toContain("messages"). The new assertion is the stronger one: no parent read asks for messages.
(2) Authorised. apps/server/src/mcp/OrchestratorMcpService.childWork.test.ts:779 (a steer unblocks a waiting delegate_task): subagents-only reads are counted as taskReads, and assert.equal(parentReads, 4) becomes assert.equal(parentReads, 1) plus assert.equal(taskReads, 3). The count of wakes the test proved stays proven.
(3) Authorised. apps/server/src/mcp/OrchestratorMcpService.lazyThreads.test.ts: the subagent_result transfer fixture moves from parentWithResult to childProjection; assertions unchanged (the same move upstream makes in its own OrchestratorMcpService.test.ts fixture).
(5) Authorised. apps/server/src/mcp/toolkits/thread/handlers.test.ts, "goat_queue_edit puts a slash command only into an agent's own queued message": the mock gains getMessagesById; assertions unchanged.
(4) NOT authorised as described. apps/server/src/mcp/OrchestratorMcpService.reviewContinuation.testkit.ts and the test "a call that read the tasks before a same-id round committed cannot move that round's lane": a hook that skips the only reads left makes the test pass without checking anything, and a test that cannot fail is not kept. Do one of these and show the evidence in the record: (a) rewrite the interleaving so the same-id round commits while the call WAITS for the continue lock (a Deferred held before the lock is granted), keep the test's assertions, and show that it fails when the tasks read is moved back outside the lock or the lock is removed; that is authorised as a fixture change with the same expectation; or (b) if 9b352a04de removed every read outside the lock that could decide the lane, so that no interleaving exists, say so with path:line for each read of the tasks on that path, and ask again for the removal of the test by name. Until then the testkit hook stays as it is on dev and the row is not pushed with a vacuous test.
Upstream's own test edits (the executedModel transfer moved to the child in 9b352a04de; the activity test's pages of 10 x 500 characters in 85b160658f; the command-filter seek test expecting thread_type_idx in b7a224c7dd) are carried as upstream wrote them and named in the record. No other expectation in an existing dev test may change in this lane without asking.

## L13 4aab23cd72 decision (quote verbatim)

Coordinator decision, 2026-11-16, lane N7, decision:6b2f71ab-c94e-4724-8b26-20b6559cc990 (row L13 4aab23cd72 with 18866e52e4; a backlog row whose note "keep the continue/new_thread invariant" was written before the upstream feature was read in full): FULL. Upstream 4aab23cd72 is the feature "scheduled tasks can run in one thread with a fresh session each run"; GOAT already has its migration (080) and its writer, so the reader, resolveThreadMode, the first-run bind, the contract field and the web and mobile settings are ported. The invariant is restated: a save without threadMode (every older client and every existing row) stores continue exactly when thread_id is set; new_thread never has a thread; continue and fresh_session may be saved unbound and are bound once, by the first run that launches their thread. The two fixtures the sheet names (ChannelRoutines.test.ts:79, scheduledTaskCompletion.test.ts:81) are fixed to the restated invariant.
Conditions (C4, contracts and stored rows): (a) older peers both ways: an older client's save and read (no threadMode) behave exactly as on dev; an older server that receives threadMode from a newer client (ignored or rejected: say which, and what the newer client shows); a row written by this server and read by an older server after a downgrade (a fresh_session row with a thread: what does dev's reader do with it: it must not crash or run the task in the wrong mode silently: say what it does); (b) tests: an unbound continue task and an unbound fresh_session task each bind on their first run and only once (two overlapping first runs do not create two threads); a fresh_session task with a thread starts a new provider session each run and keeps the thread; new_thread is unchanged; GOAT's channel routines and Bot scheduled tasks (GOAT-only callers of ScheduledTaskService) keep their mode; (c) agent surface: the schedule_task tool's new parameter and 18866e52e4's update path; every description within 400 characters; the audit and context-budget checks pass WITHOUT raising any budget (the ACP instruction block has one byte of room): if upstream's change to agentContextBudget.json cannot be met inside GOAT's budget, stop and ask; (d) settings: this is a per-task field, not a server setting, so no SETTINGS_ACCESS entry: confirm; (e) surfaces: web and mobile scheduled-task settings get captures (before and after, the new mode control, one unbound task after its first run); if the lane cannot run a real client, they are owed to #3519's integrated pass and listed per surface; docs/user/project-settings.md updated as upstream; strings follow the neighbouring strings' translation practice; (f) budgets: ScheduledTaskService.ts (2313 entry) and OrchestratorMcpService.ts within their entries; move code out first if needed.

## Fail-first (carried tests on the code before each fix)

- 9b352a04de: 6 failed | 42 passed. executedModel "retries terminal acknowledgement with a fresh command id": TypeError: Cannot read properties of undefined (reading 'filter'); integration "reports distinct/identical/emoji/long child results": AssertionError: expected [ …(4) ] to deeply equal [] (acknowledgement reads without id filters); shellReads "SQL idle compaction filters…": expected 'SEARCH orchestration_v2_projection_ru…' to not include 'orchestration_v2_projection_runs_thre…'.
- a4d0a06e7f: 3 failed | 67 passed. control-reads "dispatches metadata, queue resume and request controls without hydrating unrelated history"; ProjectionStore "the filters every command reads with seek the rows they keep": expected 'SEARCH orchestration_v2_projection_tu…' to include 'USING INDEX orchestration_v2_projecti…'; "reads a fixed SQL turn-item window…": expected true to be false (the MIN(ordinal) lookup ran).
- b7a224c7dd: 2 failed | 66 passed. control-reads "queued-message commands read a long thread's history without walking all of it": message.dispatch: SEARCH orchestration_v2_projection_turn_items USING INDEX orchestration_v2_projection_turn_items_conversation_idx (thread_id=?); seek test: expected … to include 'turn_items_thread_type_idx (thread_id…'.
- 85b160658f: 1 failed | 8 passed. activity "readThread pages cut-off text without splitting an emoji across pages": expected { position: 1, … } to match object { text: "x" x 500, textTruncated: true, nextTextOffset: 500 }.
- 4aec277f79: 2 failed | 7 passed. "goat_queue_list and goat_queue_read load only the queued runs and their messages": expected [ 'every run', 'every message', … ] to deeply equal []; "handoff analytics read only the caller's active run and its message": expected [ 'every message' ] to deeply equal [].
- 5e2438ce94: 2 failed | 16 passed. control-reads metadata test; commandReads "command reads skip finished leaf nodes of finished runs": expected [ 'acknowledged', …(8) ] to deeply equal [ 'active-run-delivered', …(5) ].

## EXPLAIN QUERY PLAN lines (asserted in the carried tests, SQL store)

- runs by status (9b352a04de): SEARCH orchestration_v2_projection_runs USING INDEX <status index>; not orchestration_v2_projection_runs_thread_ordinal_idx.
- runs, nodes, subagents, messages by id (9b352a04de): USING INDEX sqlite_autoindex_orchestration_v2_projection_{runs,nodes,subagents,messages}_1.
- command filters (a4d0a06e7f, b7a224c7dd): turn_items_thread_type_idx (thread_id=? AND type=?); nodes_settled_leaf_idx (thread_id=? AND <expr>=?); USING COVERING INDEX orchestration_v2_projection_subagents_settled_idx; source_thread_status_idx (source_thread_id=? AND status=?); target_thread_idx (target_thread_id=? AND status=?).
- settled subagent records (5e2438ce94): SEARCH node USING INTEGER PRIMARY KEY; SEARCH settled USING COVERING INDEX; SEARCH settled_node USING COVERING INDEX; subagents_settled_idx (thread_id=?); MULTI-INDEX OR; provider_threads_session_idx (provider_session_id=?); no SCAN of orchestration_v2_projection_nodes or _provider_threads.
- 4aec277f79 adds no statement (it uses getMessagesById and run id filters already in place).

## thread_mode invariant

Unchanged in this push (L13 not ported yet). The restated invariant from decision:6b2f71ab applies to the follow-up push.

## C4

No contract change in this push. C4 rows L13 4aab23cd72 and 18866e52e4 follow with older-client and older-server cases both ways and a negative case.

## Gate

pen-macbookpro2, one heavy job (none other running). Tree: lane head merged with integration `b2fb30748a` and dev `97c0dd32c4`. `node scripts/goat-rename.ts --check` 0. `set -o pipefail; vp run check:changed`: exit 1. format, graphql, lint, agent context budget, agent surface audit, knip 1/2 and 2/2, typecheck (39 packages) pass; vp test (1172 files): 1 failed | 1167 passed | 4 skipped; 18890 passed, 1 failed: packages/ssh/src/runtimeFactsScripts.test.ts "reads a built runner in one call and parses only the lines before its end line" = goat#3363 (macOS /bin/bash 3.2, BASH_XTRACEFD ignored; packages/ssh is identical to the integration branch; fails alone too). Focused runs per row in this record; mcp + DelegatedCompletion + ProjectionStore + ThreadManagementService: 190 files, 2241 tests pass; mcp + cli/thread + channels + fleet + notes: 327 files, 4245 tests pass.

## Surfaces

Server only: MCP thread, task, queue and schedule tools (local, remote and relay callers read through the same service); CLI thread reads (explicit 20000 characters). No web, mobile or desktop change in this push. No settings, contracts or agent-visible descriptions change (audit and context budget unchanged).

## Known limits

- goat_thread_read and goat_thread_list default to 10 items and 500 characters per item (85b160658f); callers that need more pass limits.
- The acknowledgement's revision check reads the parent's transfers when a command names a revision (kept from GOAT, not upstream's child read).

## NOT RUN

- Real-client pass (no visible change in this push).
- 591188471a (N6's C9 not on the integration branch), L13 4aab23cd72 and 18866e52e4 (follow-up push).
- PostgreSQL-backed relay tests (no PostgreSQL on this Mac).

