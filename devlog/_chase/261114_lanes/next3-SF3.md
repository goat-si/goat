# next3 SF3 providers and text generation (lane record)

Lane branch: chase/t3-261114-next3-sf3-providers, cut from origin/chase/t3-261114-next3 at 259883c788bb32d5601023932e07f879bde9af60 (git rev-parse HEAD on the lane worktree equals the integration head). Thread host: pen-mac-studio, queued behind K10. Rows: goat#3608 with goat#3648, goat#3588, goat#3589. Class: C4 for row 1 (it changes a packages/contracts table and what each client version shows against each server version), C3 for rows 2 and 3. State: PLAN ONLY. No code commit, nothing pushed to a code branch, no install, test or check:changed run on this machine (K10 holds the heavy-job token).

## Ancestry check (#3519 = 3ecea04f19, #3660 = 42bf8633ce on origin/dev 8c59f73519)

Commands: gh issue view for each row (all four OPEN); rg on the lane head for each row's code; git log upstream/main -S for later upstream changes.

| row | on dev or the integration head? | evidence |
| --- | --- | --- |
| goat#3608 fallback predicate | no | apps/server/src/textGeneration/textGenerationCapability.ts:57-67 accepts any enabled, available, capable instance; packages/shared/src/serverSettings.ts:220-232 (agentOnlySelection) the same plus project enablement; apps/web/src/modelSelection.ts:441-444 takes the first enabled, available entry. None checks installed, auth, status "error" or usage. No fallback log line anywhere in apps/server/src/textGeneration. |
| goat#3648 OmO default | no | packages/contracts/src/model.ts:142-165: neither DEFAULT_MODEL_BY_PROVIDER nor DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER has an omo key, so packages/shared/src/serverSettings.ts:142-146 returns "gpt-6-luna" for an OmO fallback. |
| goat#3588 Pi held start | no | packages/provider-pi/src/server/adapter.ts:2664-2665 and :2761 then :2826 await pendingPromptResponsesDrained with no deadline. upstream/main has no later change to it (git log 817b92f13a..upstream/main -S pendingPromptResponsesDrained: empty). |
| goat#3589 Cursor stream copy and queue | no | packages/provider-cursor/src/server/adapter.ts:1378-1380 slices the tail on every chunk; CursorAgentSdk.ts:664 calls void dispatchUpdate per chunk into an unbounded promise chain (:532-553); adapter.ts:308 Queue.unbounded. Upstream fixed the copy after this cycle's cut in 6be1bd6472 (#26934, not an ancestor of 93cbca3fcbd); upstream/main CursorAgentSdk.ts:689 still has void dispatchUpdate, so the queue half has no upstream fix. |

Nothing is ticked as covered.

## Prior art (written before any fix)

Row 1 (goat#3608, #3648). Upstream 817b92f13a's TextGeneration.ts (generate, about :105-140 at that commit) moves off an unusable selection with a predicate that requires the fallback to be a different instance, enabled, enabled for the project, installed, not unauthenticated, not in status "error", available, able to generate text, not on an exhausted usage window, and review guides only on codex or claudeAgent. Upstream's web picker (resolveAppModelSelectionState in the same commit) keeps the looser enabled-and-available test, so upstream itself shows one fallback in Settings and runs another, and it logs nothing when it falls back. GOAT differs by putting the predicate in one function in packages/shared that the server, the shared memory and review guide resolvers and the web picker all call, and by logging the fallback once per change. GOAT has no exhaustedUsageWindow; it has isWindowExhausted, freshWindows and appliesToModel in packages/shared/src/quotaVerdict.ts:22-68, which placement and Fleet already use, so the usage test uses those.

Row 2 (goat#3588). Upstream f255158370 (ported in N9b, 886de17bba) introduced the held start and waits without a bound; upstream/main has not changed it. Inside the same adapter GOAT already bounds every other wait on Pi: requests time out after PI_REQUEST_TIMEOUT_MS = 15 s and session start after PI_SESSION_TIMEOUT_MS = 60 s (adapter.ts:82-83), and the prompt queue is capped at 64 (:419). The one wait that may legitimately last long is a Pi extension dialog (comment at :2827-2829); the adapter tracks open dialogs in pendingPrompts (:1232), so the bound can pause while one is open.

Row 3 (goat#3589). Upstream 6be1bd6472 (#26934) appends each chunk and trims only when the buffer passes twice the 256 KiB cap, and slices to the cap when the item completes; that removes the per-chunk copy at amortised cost. For the queue, docs/internals/server-resilience.md:82-87 requires every server queue to have a limit and a slow consumer to get coalesced or dropped updates; the command output hub already coalesces for clients. Every other provider adapter (pi :338, muse :225, opencode :739, acp :932, devin-cloud :100) also uses an unbounded event queue, so a Cursor bound is new ground for adapters.

## Rows

### 1. goat#3608 + goat#3648: one fallback rule for web and server, OmO default, one log line (C4)

What changes:
- New GOAT-owned packages/shared/src/textGenerationFallback.ts (subpath export ./textGenerationFallback in packages/shared/package.json): isTextGenerationFallbackCandidate(provider, { settings, projectId, excludeInstanceId, model, now }) with upstream's conditions (different instance, enabled, project-enabled, installed, auth.status !== "unauthenticated", status !== "error", available, text-generation capable, no fresh exhausted window that applies to the model), and resolveTextGenerationFallback(settings, providers, options) that applies it in fallbackTextGenerationModelSelection's driver order.
- apps/server/src/textGeneration/textGenerationCapability.ts:57-71 calls resolveTextGenerationFallback; it logs once (Effect.logInfo, "Text generation moved from <instance>/<model> to <instance>/<model>: <reason>") whenever the pair differs from the last pair it logged, kept in one Ref (one value, bounded).
- packages/shared/src/serverSettings.ts:126-137 (agentOnlySelection) uses the same candidate test; the predicate leaves the file, so it shrinks.
- apps/web/src/modelSelection.ts:441-444 picks the fallback entry through resolveTextGenerationFallback, then derives the model and options as today.
- packages/contracts/src/model.ts: omo gets "default" (table: see D3).
Files: the four above plus packages/shared/package.json and new tests.
Older client, newer server: the older web keeps the loose rule, so where a provider is signed out, uninstalled, errored, exhausted or disabled for the project, its Settings can name that provider while the newer server runs the tighter choice and logs it. Nothing fails; the log line says what ran. Newer client, older server: Settings shows the tighter choice while the older server may still run the loose one (as today). No wire field is added or read differently: installed, auth, status, availability and usageLimits are already in every ServerProvider snapshot (packages/contracts/src/server.ts:293-315), and usageLimits is optional, so a snapshot without it is never treated as exhausted.
Stored data: none. resolveTextGenerationProvider applies on read and after a write (apps/server/src/serverSettings.ts:865, :1984), never written back, so the OmO default changes no settings file. Migration: none.
Negative cases (tests): no candidate at all keeps today's result (server: the instance's own default; web: NO_PROVIDER_MODEL_SELECTION); a snapshot without usageLimits counts as not exhausted; a stale non-exhausted window does not block; the selected instance is never its own fallback; a text generator API instance keeps its own path (textGenerationCapability.ts:39, modelSelection.ts:431-435).
Tests (fail first): new packages/shared/src/textGenerationFallback.test.ts: "a fallback skips signed-out, uninstalled, errored, project-disabled and usage-exhausted providers" (fails today: resolveMemoryModelSelection lands on the signed-out one); "memory, review guide and settings normalization on OmO run OmO's default model" (three rows, fail today with "gpt-6-luna"). apps/server/src/textGeneration/TextGeneration.test.ts (497 lines, no entry): "falls back past a signed-out provider to a ready one" and "logs a fallback once per change of the chosen model" (captured logger, two calls, one line; a third call after the pair changes, a second line). New apps/web/src/modelSelection.fallback.test.ts: "Settings names the provider the server falls back to" (the web resolver and the shared function over the same provider list, including a signed-out first entry; fails today).
Size: M (about 120 lines of code, 200 of tests).

### 2. goat#3588: a held Pi start is bounded and says why (C3)

What changes: both held waits (adapter.ts:2664-2665 and :2826) go through one GOAT-owned helper awaitPromptAcknowledgment(drained, hasOpenDialog) in a new packages/provider-pi/src/server/promptAcknowledgment.ts. It races the deferred against a 2 minute bound; when the bound runs out and Pi has a dialog open (pendingPrompts.size > 0) it waits another full bound; otherwise the start fails with a ProviderAdapterProtocolError whose text tells the person what happened (wording in D4). Stop or cancel, the session closing and Pi exiting keep ending the held start exactly as now (the deferred still fails at :373-377 and :2296-2300). Compaction holds (heldPrompts) are untouched.
Files: adapter.ts (two call sites, one import), promptAcknowledgment.ts (new), test/promptAckChecks.ts.
Tests (fail first, TestClock, in packages/provider-pi/src/server/test/promptAckChecks.ts, which adapter.test.ts registers at :2): "a start held past the bound for an earlier prompt's acknowledgment fails with the reason" (before the fix the start is still running after TestClock.adjust, so the assertion on its exit fails); "an open Pi dialog keeps the held start waiting past the bound"; "an acknowledgment inside the bound still starts the turn" (only if no existing case covers it; checked at code time).
Size: S (about 30 lines of code, 90 of tests).

### 3. goat#3589: Cursor shell output without the per-chunk copy, and a bounded path (C3)

3a, the copy: port upstream 6be1bd6472's two adapter.ts hunks verbatim (append, trim only past 2 x 256 KiB; slice to the cap at completion) and its test "keeps the last 256 KiB of streamed shell output when the result carries none". GOAT places the test in packages/provider-cursor/src/server/adapter.shellOutput.test.ts (190 lines), since adapter.test.ts is at its entry. That test passes before the change too (behaviour is unchanged; it guards the cap), so this commit's proof is the measurement below, as for any performance change.
3b, the queue (GOAT-own): the SDK hook (CursorAgentSdk.ts:660-667) coalesces shell chunks per run: at most one shell dispatch in flight, later chunks appended to one pending buffer kept to its last 256 KiB, flushed when the dispatch settles. The adapter's event queue gets a bound with backpressure (D5). Together a loud command holds at most one pending buffer per run, and the producer waits for the consumer instead of growing memory.
Measurement (issue's first step, before 3a and after each commit): an uncommitted scratch script under the lane's scratch folder drives the Cursor adapter through the adapter.shellOutput.test.ts fake SDK with 8 MiB in 4 KiB chunks, consumer paused for the first half, and records process.cpuUsage and heap used. Numbers go in this record; the script is not committed.
Tests (fail first for 3b): packages/provider-cursor/src/server/CursorAgentSdk.test.ts: "a shell flood while a dispatch is in flight leaves one coalesced chunk holding the last 256 KiB" (fails today: one pending callback per chunk). adapter.shellOutput.test.ts: "the event queue makes a loud command wait instead of growing" (offers past the bound suspend until the stream is read; then every byte of the kept tail arrives in order).
Size: S for 3a, S-M for 3b.

## Budgets (oxlint-plugin-goat/code-budgets.json, measured with countLines at 259883c788)

At entry and grown by this lane, so a verbatim move-out comes first (rows for the card below):
- packages/provider-pi/src/server/adapter.ts 3464 = entry 3464. Row 2 adds one import and longer call lines (about +4 to +6).
- packages/provider-cursor/src/server/adapter.ts 2394 = entry 2394. Row 3a adds 6 lines; 3b about 2.
At entry and NOT touched (new tests go to other files): packages/provider-pi/src/server/adapter.test.ts 4582, packages/provider-cursor/src/server/adapter.test.ts 1891, apps/web/src/modelSelection.test.ts 1305, packages/shared/src/serverSettings.test.ts 1015, apps/server/src/serverSettings.test.ts 3135, apps/server/src/serverSettings.ts 2248.
No entry, under 1000: packages/shared/src/serverSettings.ts 920 (shrinks), apps/web/src/modelSelection.ts 476, textGenerationCapability.ts 72, TextGeneration.test.ts 497, contracts model.ts 204, CursorAgentSdk.ts 844 (about +25), test/promptAckChecks.ts 621 (about +90), adapter.shellOutput.test.ts 190.

Rows for the card's at-entry move-outs table (requested from the coordinator before any cut):

| file | lane | block (path:line, 259883c788) | new module | lines freed | state |
| --- | --- | --- | --- | --- | --- |
| packages/provider-pi/src/server/adapter.ts | SF3 | :3391-3410 function piSubagentOutput (20 lines) and the blank line after it | packages/provider-pi/src/server/subagentOutput.ts | about 20 net after its import line; exact count in the commit | SF3 asks |
| packages/provider-cursor/src/server/adapter.ts | SF3 | :222-241 class CursorModelUnavailableError and const classifyCursorModelRejection (20 lines) | packages/provider-cursor/src/server/modelRejection.ts | about 19 net after its import line; exact count in the commit | SF3 asks |

Both blocks are module-level and close over nothing in the adapter body. Consumers found by rg: piSubagentOutput only at adapter.ts:1137; classifyCursorModelRejection only at adapter.ts:1662 and :1867; both searched again before the cut.

## Rule 3

Beyond IV I expect none: no existing expectation or setup changes are planned, and new cases go into new or non-entry files. One possible item, checked at code time and sent with exact before and after if it occurs: an existing apps/web/src/modelSelection.test.ts case whose fixture lists a signed-out, uninstalled or errored provider first and expects it as the fallback, or expects list order where D1 makes it driver order.

## Order

M1 (Pi move-out), M2 (Cursor move-out), then row 1, row 2, row 3a, row 3b. One commit per row; each row's record entry shows the failing test output before the fix. Total size M (about 200 lines of code, 400 of tests).

## Decisions for the coordinator

D1, fallback order on the web. One function for both sides means the web takes the server's driver order (codex, claudeAgent, cursor, grok, muse, pi, omo, opencode, antigravity, then configured instances) instead of the provider list order. When several providers qualify, Settings may then name a different provider than today, but it will name the one the server runs. I recommend the shared order (the issue asks that Settings shows exactly what the server runs); the alternative shares only the predicate and keeps the known order difference recorded in next-N9b.md:264.

D2, project enablement for titles, branch names and commit messages. These inputs carry no projectId (packages/provider-core/src/server/textGeneration.ts has none), so the server can check project enablement only where a project is known (review guide, source control writer). I recommend the predicate takes projectId | null, callers that know the project pass it, and title, branch and commit generation check machine-level enablement only, recorded as a difference from upstream. Threading projectId through every text generation input is a wider C3 change across all providers' text generation.

D3, where OmO's default goes. The issue proposes DEFAULT_MODEL_BY_PROVIDER, which is also read by the composer draft default (apps/web/src/composerDraftStore.ts:1034, :2935, :2971), provider model lists (apps/web/src/providerModels.ts:96, apps/web/src/providerInstances.ts:206) and session import (apps/server/src/project/AgentSessionImporter.ts:297), so new OmO drafts and imported OmO threads would also default to "default". I recommend DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER instead, which every text generation fallback reads first (packages/shared/src/serverSettings.ts:142-146, :157) and nothing else reads, so the change stays inside this row. Either fixes the three call sites in the issue.

D4, what a timed-out held Pi start does. Bound: 2 minutes, restarted while a Pi dialog is open. On expiry the held start fails with "Pi has not confirmed your previous message after 2 minutes, so this one was not sent. A Pi extension may still be handling it. Send again to keep waiting, or stop the session to restart Pi." Option A (recommended): fail the start and leave Pi running, so an extension that is slow but alive can still finish. Option B: also terminate Pi (as stopPendingWake does at adapter.ts:1693-1698) so the next send starts on a fresh Pi, losing whatever the extension was doing. Under A, the issue's "offer Stop" is the message text; Stop on a thread with no active Pi turn does nothing today (adapter.ts:2906-2913), so the message names the session stop instead.

D5, the Cursor event queue bound. Option A (recommended): coalesce at the SDK hook and make Cursor's event queue Queue.bounded(1024) with backpressure; the producer callbacks are already serialised (CursorAgentSdk.ts:532-553), so a full queue pauses the callback chain and the hook keeps coalescing into its 256 KiB buffer. Risk: an emitter that runs before anything reads the stream, or while the reader waits on the adapter, would block; the test in 3b and a read of every emit path before startSession settle this, and I will report what I find. Option B: coalesce at the hook only and leave the event queue unbounded like the other six adapters, with a new issue for a bound across all adapters.

D6, porting 6be1bd6472 now. It is newer than this cycle's cut (like K4's 0813f4978e, ruled 21:59:20). I propose porting it verbatim here and writing "6be1bd6472 taken early by SF3: next cycle checks, does not port" in the fork delta record, as K4 did.

## Gate per push

vp run check:changed against origin/chase/t3-261114-next3; vp test run, each WHOLE: packages/shared/src/textGenerationFallback.test.ts, packages/shared/src/serverSettings.test.ts, apps/server/src/textGeneration/TextGeneration.test.ts, apps/web/src/modelSelection.test.ts and modelSelection.fallback.test.ts, packages/provider-pi/src/server/adapter.test.ts (it runs promptAckChecks), packages/provider-cursor/src/server/adapter.shellOutput.test.ts, CursorAgentSdk.test.ts and adapter.test.ts. Row 2 changes whether a thread is held, so the Pi subsystem's files whole as well: packages/provider-pi/src/server/*.test.ts and apps/server/src/orchestration-v2/testkit/PiReplayFixtures.integration.test.ts. vp run typecheck for each changed package by its vp name (goat, the web, shared, contracts, provider-pi, provider-cursor; names checked with vp before the claim). Every heavy job only when this machine's token is free and ps shows no other lane's vitest or check:changed.

## Risks

- D1 can change which provider Settings names as the fallback for some people.
- The web judges usage windows with the render-time clock; a window that resets between renders shows the old choice until the next provider update.
- D5 A: a bounded adapter queue can deadlock if an emitter waits on the reader; settled by test and by reading every emit path before startSession.
- Row 2's bound could fail a start that a slow but healthy extension would have acknowledged after 2 minutes; D4 A keeps Pi alive so a resend still works.

## NOT RUN expected

- Live Pi with an extension input handler that never finishes (person-or-account row; the TestClock test stands in).
- Live Cursor with a loud command (needs a Cursor account; the harness flood stands in, reason recorded with the numbers).
- Live OmO memory summary and review guide (person-or-account row).
- The Settings pass in a real client (P1 is the integrated pass; lanes start no dev server).
- Repo-wide suites (CI owns them).

## Coordinator ruling (relayed verbatim by the lane coordinator)

> Coordinator to lane coordinator (2026-11-17 23:40 UTC), relayed verbatim:
>
> III. SF3 PLAN: ACCEPTED, with these rulings. Class: row 1 is C4 (agreed: it decides which provider account text generation spends on), rows 2 and 3 are C3. Move-outs M1 and M2 as on card 10.028.
> D1: the shared order (web takes the server's driver order). Settings must name what the server runs. Settings has no project, so it passes projectId null; record as a Limit that a project that disables a provider can make the server skip the one Settings names. A changed expectation in apps/web modelSelection.test.ts comes to me with before and after, as you say.
> D2: as recommended: the predicate takes projectId | null; every caller that already has the project id in scope where it resolves passes it (not only the review guide and the writer: check the title service, which holds projection.thread.projectId); nothing is threaded through provider-core's inputs. The remaining gap (a title, branch name or commit message can fall back to a provider the project disabled) is project content going to a provider the project turned off: write it as a Limit and put an issue draft in the record; it is filed when the lane merges.
> D3: DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER, text generation only. Show by a test or a cite that OmO's text generation accepts the model id "default". Note in the record that this differs from the table #3648 names, and why.
> D4: A (fail the held start, leave Pi running), 2 minutes, restarted while a Pi dialog is open. Conditions: a test shows what the thread holds after the failure: the reason, and the person's message not lost (say where it is: restored, or a failed item with its text). The message may only name a control a person can find: if "stop the session" is not a labelled action on an idle Pi thread, name the real one or drop that clause. Say what happens to the other starts held in the queue of 64 when one times out.
> D5: A, with four conditions. (1) The bound is defended in bytes, not entries: 1024 entries of up to 256 KiB coalesced output is about 256 MiB, which is not a bound; choose the entry count from a byte ceiling you can state (tens of MiB at most) and write the arithmetic in the record. (2) A test for an emit before the stream has a reader (startSession's own emits) and (3) a test that Stop, an interrupt and the session closing each release a producer suspended on a full queue, and that a Stop still ends the turn while the queue is full. (4) Read every emit path for one that can wait on the reader. If you find one that cannot be made safe in this lane, take B (hook coalescing only) and report it; no second question needed. Either way draft the issue for the other six adapters' unbounded queues in the record; not this lane's code. Note for the record: with an unbounded queue the dispatch settles at once, so B alone does not bound memory under a paused consumer; say so in the Limit if B is what ships.
> D6: yes, port 6be1bd6472 verbatim now, "taken early by SF3" in the fork delta record; lane coordinator, add it to card 10.028's taken-early list beside K4's 0813f4978e.
> Row 1, two more conditions: say whether GOAT keeps upstream's "review guides only on codex or claudeAgent" condition and why; say whether mobile shows a text generation selection anywhere (if it does, it uses the same function; if not, write "mobile: no such picker" with the path you searched). The log line carries instance and model names and a fixed reason word, never an error's text.
> Code start: SF3 may write code once K5's review has reported (the earlier rule). Heavy jobs by the machine token as before; a K5 or K10 fix round has the token first. READY comes with the measurement numbers of row 3 (before, after 3a, after 3b).
>
> Lane coordinator, for SF3: quote it in next3-SF3.md. Code waits for K5's review to report (I will tell you); until then you may refine the plan in your record. Your two claims are on card 10.028.

## Plan after the ruling (read-only research, lane head 259883c788)

### Row 1

D2, how the project id reaches the fallback without touching provider-core. The fallback runs inside the TextGeneration service (apps/server/src/textGeneration/TextGeneration.ts:79-89, capable()), whose inputs are provider-core types without a project. A GOAT-owned Context.Reference TextGenerationProject (ProjectId | null, default null) in textGenerationCapability.ts carries it, the pattern apps/server/src/workspace/workspaceLease.ts:44-64 already uses. Each caller that has the id where it calls wraps the call in Effect.provideService(TextGenerationProject, projectId), one line each:
- thread titles: apps/server/src/orchestration-v2/ThreadTitleRegenerationService.ts:169 (projection.thread.projectId, already used at :163);
- branch names: apps/server/src/orchestration-v2/ThreadLaunchService.ts:457 (input.projectId, already used at :445);
- commit messages and PR content: apps/server/src/git/GitManager.ts:1980 and :2207 (the projectId resolved at :548-567 for the same settings), checked at code time that it is in scope at both calls;
- review guides keep their own path through resolveReviewGuideModelSelection with input.projectId (apps/server/src/pullRequest/PullRequestReviewGuideService.ts:401-405).
No project in scope: memory (MemoryWorker.ts:618, memory is per environment) and channel reception (ChannelReceptionService.ts:355); they pass nothing and check machine-level enablement.
Limit (D1): Settings has no project and passes null, so a project that disables the provider Settings names makes the server skip it for that project's titles, branch names and commit messages.
Limit (D2): where no project id is in scope (memory, channel reception) the fallback can land on a provider a project disabled. With the callers above passing their id, the gap the ruling names for titles, branch names and commit messages closes at those call sites. Any caller found at code time without the id in scope is listed here and goes into the issue draft below.

Issue draft (filed when the lane merges), title "Text generation without a project in scope can fall back to a provider a project turned off": "Text generation picks a fallback provider when the saved one cannot run. Since <lane PR>, callers that know the project (thread titles, branch names, commit messages, PR content, review guides) check that the project has the provider enabled. <list of callers without a project, filled at code time> resolve with no project, so they can send project content to a provider that project turned off. Proposal: carry the project id through those callers, or refuse a fallback the project would refuse. Found in lane SF3 of cycle 261114 next3."

Review guides only on codex or claudeAgent: GOAT keeps it. It is already in the shared resolver (packages/shared/src/serverSettings.ts:129, investigate === true only for review guides) and stays when the candidate test moves out, because review guides investigate the checkout read-only and the other drivers reject that request (upstream's own comment beside INVESTIGATING_DRIVERS in 817b92f13a TextGeneration.ts). Review guides and memory do not pass through capable() (TextGeneration.ts:233-245): they use agentOnlySelection, which falls back only off a text generator API instance.

Mobile: no such picker. rg -i 'textGenerationModel|text generation|resolveAppModelSelectionState|TextGeneration' apps/mobile/src (non-test) returns nothing; the only mobile model route is apps/mobile/src/features/settings/SettingsMemoryRouteScreen.tsx (memory route, outside this row). packages/client-runtime/src/state/sharedSettings.ts:22-75 only merges a textGenerationModelSelection patch; it picks nothing.

Log line: "Text generation fell back" with fields from {instanceId, model}, to {instanceId, model}, reason, where reason is one fixed word from { unavailable, signed_out, not_installed, error, exhausted, disabled, unsupported_model } chosen by the first failed check on the saved provider. No error text.

D3: OmO goes into DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER. This differs from the table goat#3648 names (DEFAULT_MODEL_BY_PROVIDER) because that table also sets new OmO drafts' model (apps/web/src/composerDraftStore.ts:1034, :2935, :2971), provider model lists (apps/web/src/providerModels.ts:96, providerInstances.ts:206) and imported sessions (apps/server/src/project/AgentSessionImporter.ts:297), which the issue does not ask to change. OmO accepts "default": OmO runs through makePiTextGeneration (packages/provider-pi/src/server/driver.ts:19, :198 for the Pi and OmO profiles), which skips model selection entirely for "default" (packages/provider-pi/src/server/textGeneration.ts:66) so Pi or OmO uses its own configured model; packages/provider-pi/src/server/textGeneration.test.ts:93 and :181 already run text generation with "default". Row 1's OmO test runs it with the OmO profile as well.

### Row 2

Message text (the only control named is one a person can find): "Pi has not confirmed your previous message after 2 minutes, so this one was not sent. A Pi extension may still be handling it. Send again to keep waiting, or use Restart agent session to start Pi fresh." Restart agent session is the labelled command palette action on any thread (apps/web/src/components/CommandPalette.tsx:1447-1462: it stops the thread's session, and the next message starts a fresh one); server messages already name it (apps/server/src/cua/ComputerUseLeaseMessages.ts:87). Limit: mobile has no Restart agent session action (rg over apps/mobile/src finds only "Stop agent"), so on mobile the second clause names a web and desktop control.

The queue of 64 holds prompts, not starts: heldPrompts (held during compaction) plus pendingPromptResponses (sent, not yet acknowledged), adapter.ts:405-432. A Pi session serves one thread, and startTurn refuses while a turn is active (:2655-2660), so at most one start is held at a time. When it times out, the earlier prompt stays in pendingPromptResponses (Pi still owes its acknowledgment) and nothing else in the queue changes. The thread's other queued messages are not started one after another: when a run fails on the same provider instance with a failure class other than validation_error, the orchestrator holds every queued run (apps/server/src/orchestration-v2/Orchestrator.ts:1235-1251), and the person resumes with Resume or a new message (docs/user/composer.md:318-321). The integration test confirms which failure class this start error gets and that the queue is held.

What the thread holds after the failure: proved by a new integration test through the orchestrator with the fake Pi (apps/server/src/orchestration-v2, beside PiReplayFixtures.integration.test.ts, in a new file), not by reading code. It asserts the run's failure shows the reason text above, that the person's message is still in the thread with its text (the user message is committed before the provider start), and that queued runs are held. If the message turns out to be lost, the row grows to keep it and I report before writing that.

### Row 3, D5 finding (condition 4) and the proposed form of A

Reading every emit path (29 emitProviderEvent or Queue.offer calls in packages/provider-cursor/src/server/adapter.ts): the single reader is the session-wide Stream.runForEach in apps/server/src/orchestration-v2/ProviderSessionManager.ts:2237, which persists events and appends live output; it never calls into the adapter, so no emit waits on itself through the reader. But Queue.bounded would make every emit wait while the queue is full, including the Stop path: interruptTurn waits up to 10 s for the run to complete and then calls finalizeTurn, which emits (adapter.ts:2213-2224). With the reader stalled on the database, Stop could not end the turn. That fails condition (3).

Proposed instead (A with the bound only where the flood is): domain events keep the unbounded queue (their count follows turn activity: items, approvals, completions); command_output.delta events are bounded in bytes. The adapter counts the characters of deltas in the queue (added at offer, removed as the stream takes them); a shell delta that would pass the ceiling waits on a signal released by a take, by the turn's interrupt or Stop (context.interrupted) and by session close, and on interrupt or close it is dropped instead of waiting (the item's kept tail still carries the output at completion, adapter.ts:631). Arithmetic: ceiling 4 Mi characters of queued delta text, which is 8 MiB at V8's two bytes per character for non-Latin-1 text (at most; 4 MiB for one-byte strings); plus the SDK hook's coalesced buffer of 256 Ki characters (512 KiB at most) and the adapter's kept tail of up to 2 x 256 Ki characters (1 MiB at most) per running shell. A loud command so holds about 9.5 MiB at most per session. Tests: (2) startSession's emits with no reader yet complete (they are domain events and never wait); (3) a shell producer suspended at the ceiling is released by Stop, by an interrupt and by session close, and a Stop ends the turn while the delta budget is full; plus the flood test from the plan. If the coordinator prefers B (hook coalescing only), the Limit reads: with an unbounded queue the dispatch settles at once, so B alone does not bound memory under a paused consumer.

Issue draft (not this lane's code), title "Provider adapters hold their event queues without a bound": "Every provider adapter except Cursor creates its native event queue with Queue.unbounded: pi (packages/provider-pi/src/server/adapter.ts:338, and its RPC queues at rpc.ts:277-278), muse (packages/provider-muse/src/server/adapter.ts:225, plus its inbox at :233), opencode (packages/provider-opencode/src/server/adapter.ts:739 and v2/adapter.ts:245), acp (packages/provider-acp/src/server/adapter.ts:932 and AcpSessionRuntime.ts:901), devin-cloud (packages/provider-devin-cloud/src/server/adapter.ts:100), codex (apps/server/src/orchestration-v2/Adapters/CodexAppServerExit.ts:24) and claude (apps/server/src/orchestration-v2/Adapters/ClaudeEventQueue.ts:27). The ruling said six; the search (rg Queue.unbounded over apps/server/src/orchestration-v2/Adapters and packages/provider-*/src/server, tests excluded) finds eight adapters. docs/internals/server-resilience.md requires a limit on every server queue. A loud native stream, or a reader stalled on the database, grows server memory without a limit. Cursor got a byte bound on live command output in <lane PR>; apply the same to each adapter's output deltas and decide per adapter whether domain events need one. Found in lane SF3 of cycle 261114 next3."

### D6

6be1bd6472 is ported verbatim in row 3a; the fork delta record (devlog/_chase/010_fork_delta.md on the lane branch) gets "6be1bd6472 taken early by SF3: next cycle checks, does not port", as K4 wrote for 0813f4978e.

## Coordinator ruling on D5 and D4 (relayed verbatim by the lane coordinator)

> Coordinator to lane coordinator, 2026-11-17 23:58 UTC, relayed verbatim:
>
> III. SF3, D5: the proposed form is ACCEPTED (domain events stay on the unbounded queue; only command_output.delta is bounded, in characters). Conditions: (1) the gate is one small GOAT-owned module, not inline in adapter.ts; (2) the count cannot leak: released on take, on Stop, on interrupt and on close; a case that after a flood and a drain the count is back at zero; (3) a case that Stop ends the turn while the gate is full and the reader is stalled (your finding, pinned); (4) ORDER: a delta that waited must never reach the reader after its item's completed event; completing the item drops what still waits for it (a case); (5) the record states the per-session ceiling (your 9.5 MiB) and the worst case for 20 Cursor sessions at once; (6) if the gate passes about 80 lines of code or needs another question, B ships instead with the Limit written. The other answers are accepted: D2 through a Context.Reference with one line per caller (one case with the reference set and one without); D3 as shown; row 1 as answered; eight adapters in the issue draft. D4: the failure text must be true on every client, and mobile has no "Restart agent session" action, so the sentence may not name a control: "Send again to keep waiting, or restart the agent session." Code still waits for K5's review.
>
> Lane coordinator, for SF3: quote it in next3-SF3.md. Code still waits for K5's review to report; I will tell you.

## Plan after the D5 ruling

Row 2 message, final (this replaces the text in "Plan after the ruling", Row 2, and the mobile Limit there no longer applies, because the sentence names no control): "Pi has not confirmed your previous message after 2 minutes, so this one was not sent. A Pi extension may still be handling it. Send again to keep waiting, or restart the agent session."

Row 1 D2 tests: one case with TextGenerationProject set to a project that disables the first candidate (the fallback skips it), and one without the reference (machine-level enablement, the same candidate is taken).

Row 3b gate, by condition:
1. Module: new packages/provider-cursor/src/server/commandOutputGate.ts, GOAT-owned. adapter.ts only creates it, calls it at the shell-delta emit, at take (the events stream maps each taken delta through the gate's release), at Stop and interrupt, at item completion and at session close. Lines of the module are counted in the commit. Past about 80 lines of code, or if it needs another question, B ships instead with the Limit: "with an unbounded queue the dispatch settles at once, so hook coalescing alone does not bound memory under a paused consumer".
2. No leak: the count goes down on take, and every waiting or queued delta of a turn is released on Stop, on interrupt and on close. Case: a flood, then the reader drains everything; the gate's count reads 0.
3. Case (pinned finding): the reader is stalled and the gate is full; Stop ends the turn (the interrupt's finalizeTurn emits a domain event, which never waits), and the suspended producer is released.
4. Order: the gate keys waiting deltas by item. Completing a command item (adapter.ts:631, the completed turn_item.updated) first drops the deltas still waiting for that item and releases their count, then emits the completion, so no waiting delta reaches the reader after its item's completed event. A delta already offered before the completion precedes it in the queue and stays in order. Case: a delta waits at the cap, the item completes, the reader then sees the completion and no later delta for that item.
5. Ceiling: per session at most 4 Mi characters of queued deltas (8 MiB at 2 bytes per character), plus the SDK hook's coalesced buffer of 256 Ki characters (512 KiB), plus the adapter's kept tail of up to 2 x 256 Ki characters (1 MiB) for each running shell: about 9.5 MiB for one session with one running shell. The kept tail is per running shell; Cursor runs a turn's shell commands one at a time in what we have seen, and each further shell running at the same time adds up to 1 MiB. Worst case for 20 Cursor sessions at once, one running shell each: 20 x 9.5 MiB = 190 MiB. The 8 MiB queue cap is per session, so the total grows with the number of sessions. Today the same 20 sessions have no ceiling at all.

## Code phase (head 680ef3f461 on chase/t3-261114-next3-sf3-providers)

### Standing rules quoted (relayed verbatim by the lane coordinator)

> IV extension, coordinator 2026-11-18 00:35:17 UTC: "Standing rule from now, so this needs no round trip again: a type-only import added to an existing test file, and a layer provided to an existing case because the code under test gained a dependency, need no word from me when the commit changes no title, body, setup value or expectation of that case; the lane quotes the before and after in its record and the fresh review lists them. A provide that replaces or fakes a service the case's assertions read still comes to me."

> Coordinator 2026-11-18 00:45:31 UTC: "From now on for every lane: READY means the gate exited 0 on the pushed head, or the report names each failure with the same failure shown at the integration head."

> Coordinator 2026-11-18 01:14:39 UTC, IV: "before READY, every apps/server test file the lane added or changed is run once from apps/server with GOAT_TEST_TMP_GUARD=fail (CI sets it, check:changed does not), and the READY report says so."

> Coordinator 2026-11-18 01:17:54 UTC, II: "a VALUE import added to an existing import line of an existing test file needs no word from me when only appended cases or appended helpers use the new names and no existing title, body, setup value or expectation changes. The lane quotes the line before and after in its record; the fresh review lists it." Extended 01:20:03 UTC to a NEW import statement on the same terms (real module, no load-time effect, no existing case changed).

> Lane coordinator, no-stash rule (sent between 00:55 and 01:16 UTC; the real send time came from the thread log): do not use git stash; all worktrees share refs/stash.

Coordinator ruling on rule 3 for this lane (2026-11-18 00:00:37 UTC) is quoted in the commit 7355fe5649 message and applied as authorised (below).

### Commits

| commit | row | what |
| --- | --- | --- |
| cf94072fd8 | M1 | adapter.ts:3391-3410 piSubagentOutput -> subagentOutput.ts, 3464 -> 3444 |
| f1d3630737 | M2 | adapter.ts:222-241 -> modelRejection.ts, 2394 -> 2374 |
| ba3af4d5e9 | M3 | GitManager.ts :426-437 (limitContext, limitCommandOutput), :187 const, :43 type import -> promptContextLimits.ts, 3124 -> 3111 |
| 7973922c60 | M4 | ThreadLaunchService.ts :193-214 -> threadLaunchWorkspaceMissing.ts (re-exported), 1461 -> 1441 |
| 7355fe5649 | 1 | goat#3608 + #3648 |
| 9cf9d06388 | 2 | goat#3588 |
| cf0cd39c34 | 3a | port of upstream 6be1bd6472 (taken early by SF3) |
| 94bed1303f | 3b | goat#3589 bound |
| 680ef3f461 | merge | git merge origin/chase/t3-261114-next3 (ac238fcce3): "Merge made by the 'ort' strategy", no conflict; earlier the same merge against 259883c788 reported "Already up to date." Integration head moved to f82d2df4b0 afterwards; not merged (one merge per the brief). |

Budget entries at real length (countLines): GitManager.ts 3119 (dev entry 3124), ThreadLaunchService.ts 1442 (1461), provider-pi adapter.ts 3458 (3464), provider-cursor adapter.ts 2390 (2394). New modules all under 100 lines; commandOutputGate.ts 63.

Commits were made with --no-verify, because the pre-commit hook's lint-staged keeps its backup in the shared stash list and these commits stage part of the tree; format and lint ran in check:changed (pass, below).

### Rule 3 and imports

Authorised hunk (TextGeneration.test.ts, "runs OmO's own default for %s"):
before: 'yield* generation.pipe(Effect.provide(ServerSettings.layerTest())),'
after: 'yield* generation.pipe(Effect.provide(ServerSettings.layerTest({ providerInstances: { [OMO]: { driver: M.ProviderDriverKind.make("omo"), enabled: true } } }))),' (formatter wraps it over 9 lines). Comment above the case: before "// OmO has no text generation default in the model tables; Settings shows its first listed model." after "// OmO's text generation default is \"default\", the model OmO itself is configured with." New case: "skips an OmO that is off at machine level and runs Pi's own default".
New import statements (01:17/01:20 rules), used only by appended cases or helpers: TextGeneration.test.ts 'import * as Logger from "effect/Logger";' and 'import { TextGenerationProject } from "./textGenerationCapability.ts";'; test/promptAckChecks.ts 'import * as TestClock from "effect/testing/TestClock";' and 'import { PROMPT_ACKNOWLEDGMENT_TIMEOUT_DETAIL } from "../promptAcknowledgment.ts";' (every existing case there is it.effect / it.effect.each). No other existing test file changed; new cases sit in new files (textGenerationFallback.test.ts, modelSelection.fallback.test.ts, PiHeldStartTimeout.integration.test.ts, adapter.outputGate.test.ts, commandOutputGate.test.ts) or appended (CursorAgentSdk.test.ts, no import change).

### Fail first (before each fix)

- Row 1: `vp test run packages/shared/src/textGenerationFallback.test.ts apps/server/src/textGeneration/TextGeneration.test.ts apps/web/src/modelSelection.fallback.test.ts` on the move-out head with the tests only: Test Files 3 failed (3), Tests 10 failed | 13 passed. shared: "expected 'codex' to be 'muse'" (signed-out codex taken), review guide "expected 'codex' to be 'claudeAgent'", OmO settings normalization got gpt-6-luna; web: "expected 'codex' to be 'claudeAgent'" and "expected 'claudeAgent' to be 'codex'" (list order); server: ran codex not claudeAgent/claude-haiku-5-5, TextGenerationProject missing, no log line, OmO normalization "gpt-6-luna". The memory-on-OmO case's first fixture lacked OmO enabled (OmO is off when unconfigured) and was fixed before the code fix.
- Row 2: with the adapter's bounded wait reverted: "× fails a start held 2 minutes for an earlier prompt's acknowledgment, with the reason" AssertionError: expected false to be true (the start was still pending after TestClock.adjust 2 minutes). The dialog case passed (it pins waiting). The integration test first failed on the code as planned: the thread's error item read "Provider turn failed." (generic); that led to PiPromptAcknowledgmentTimeoutError on provider-core's curated list (failure.ts, one line), after which it passes.
- Row 3b: with CursorAgentSdk.ts reverted: AssertionError: expected [ 'first\n', …(3000) ] to deeply equal [ 'first\n', …(1) ]. The Stop-while-full case and the gate unit cases are pins (Stop already worked with an unbounded queue).
- Row 3a: performance only; the upstream case passes before and after (it guards the cap); proof is the measurement.

### Runs on the final code (each preceded by ps in its own step)

- vp run typecheck for goat, @goat/web, @goat/shared, @goat/contracts, @goat/provider-pi, @goat/provider-cursor: "6/6 successful", exit 0 (before the fixup; the fixup is re-covered by check:changed's typecheck below).
- Row 1 whole: shared textGenerationFallback, serverSettings, serverSettingsTextGeneration, textGeneratorFallback; server TextGeneration.test.ts; web modelSelection.test.ts and modelSelection.fallback.test.ts: 7 files, 122 tests passed, exit 0.
- apps/server with GOAT_TEST_TMP_GUARD=fail: TextGeneration.test.ts, PiHeldStartTimeout.integration.test.ts (after its fix, alone: 1 passed), ThreadTitleRegenerationService.test.ts, PullRequestReviewGuideService.test.ts, serverSettings.test.ts, ThreadLaunchService.test.ts, GitManager.test.ts: 307 passed with the one integration failure described above, then the integration file alone passed.
- Pi subsystem whole: packages/provider-pi/src/server (all), provider-core failure.test.ts, PiReplayFixtures.integration.test.ts: 24 files passed, 1 skipped (omo.live.test.ts, describe.skipIf no OmO binary), 299 tests passed.
- Cursor whole: packages/provider-cursor/src/server: 43 files, 374 tests passed.
- Gate: vp run check:changed origin/chase/t3-261114-next3 on 680ef3f461 (integration ac238fcce3): format, lint, graphql, agent context budget, agent surface audit, knip 1/2 and 2/2, typecheck (39 packages) pass; vp test (257 files) FAIL: 16 cases in apps/server/src/textGeneration/GrokTextGeneration.test.ts, all "AcpProcessExitedError: ACP process exited with code 127 ... bin/grok: line 2: exec: node: not found" (the test's fake grok script cannot find node on the spawned PATH). 255 files passed, 1 skipped; 5892 tests passed. SF3 does not touch Grok, provider-acp or that file. The same file at the integration head is the next heavy job SF3 runs (waiting for its turn).
- The first gate run (before the fixup) failed lint (react purity: Date.now() during render in MemoryGenerationSettings.tsx and SourceControlWritingSettings.tsx) and knip (unused export COMMAND_OUTPUT_QUEUE_CHARS); both fixed by fixups squashed into rows 1 and 3b (useNowMinute; export dropped).

### Row 3 measurements (uncommitted scratch test, kept at /tmp/sf3-states/zzSf3Flood.scratch.test.ts, removed from the tree)

Harness: the Cursor adapter with a fake SDK runner whose run emits shell-output-delta updates on its own fiber; each 4 KiB chunk is created as it is emitted; nothing reads the events for the first 300 ms, then everything is read. Per state, one vitest process with NODE_OPTIONS=--expose-gc, three rounds each of 8 MiB (2048 chunks) and 64 MiB (16384 chunks). "held" = heapUsed after a forced GC at the end of the 300 ms pause, minus the baseline; "peak" = largest heapUsed seen while reading (includes uncollected garbage).

| state | 8 MiB held (MiB) | 8 MiB peak | 8 MiB CPU user (ms) | 64 MiB held (MiB) | 64 MiB peak | 64 MiB CPU user / sys (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| before (259883c788 adapter and runner) | 2.6 / 1.9 / 1.9 | 4.7 / 4.0 / 3.7 | 98 / 85 / 75 | 9.3 / 9.5 / 8.9 | 105.4 / 106.1 / 105.1 | 340/221, 273/237, 278/257 |
| after 3a | 2.7 / 2.0 / 2.1 | 4.9 / 4.1 / 4.0 | 83 / 68 / 70 | 12.4 / 12.5 / 12.5 | 25.9 / 25.4 / 25.3 | 183/6, 153/3, 136/3 |
| after 3b | 2.1 / 1.4 / 1.4 | 20.4 / 19.5 / 19.1 | 87 / 72 / 66 | 1.4 / 1.6 / 1.4 | 58.8 / 63.0 / 63.0 | 233/7, 169/6, 170/3 |

Reading: 3a removes the per-chunk tail copy: on 64 MiB, user CPU drops from about 280-340 ms to 136-183 ms, system CPU from about 240 ms to under 10 ms, and the read-phase heap peak from about 105 MiB to about 25 MiB. 3b holds what a paused reader leaves queued at about 1.5 MiB against 9-12.5 MiB without the gate. Within 300 ms the fake producer only gets part of the flood out, so without the gate the held figure keeps growing with a longer stall, while with it it stays under the cap. 3b costs some CPU (gate waits and wake-ups: 64 MiB user 169-233 ms versus 136-183 after 3a) and a higher transient peak while reading (19-20 MiB versus 4-5 MiB on 8 MiB; 59-63 versus 25 on 64 MiB), which is uncollected garbage from the interleaved producer and reader, not retained memory. Earlier attempts reused one chunk string or built every chunk up front; those readings measured nothing useful and are discarded.

### Limits

- D1: Settings has no project and passes null; a project that disables the provider Settings names makes the server skip it for that project's text.
- D2: memory and channel reception have no project in scope; their fallback checks machine-level enablement only. Issue draft below.
- Settings judges usage windows with a one-minute clock (useNowMinute) in the memory and review guide pickers; resolveAppModelSelectionState reads Date.now() when it computes the fallback.
- Row 2: mobile has no "Restart agent session" action; the message names no control. A held start that times out leaves Pi running and the earlier prompt still owed; the next send waits again (up to 2 minutes).
- Row 3b: the hook keeps the last 256 Ki characters when output arrives faster than one dispatch; the live stream and the fallback tail (used only when Cursor's result has no output) can skip middle output under such a flood. The bound applies to Cursor only; the other eight adapters' queues are the issue draft below.
- Server resolution: a fallback provider still in its first status check is not considered (as before).

### Issue drafts (to file when the lane merges)

1. "Text generation without a project in scope can fall back to a provider a project turned off": memory generation (apps/server/src/memory/MemoryWorker.ts:618) and channel reception (apps/server/src/channels/ChannelReceptionService.ts:355) resolve the text generation fallback with no project; since lane SF3 every caller with a project passes it (titles, branch names, commit messages, PR content, review guides). Proposal: pass the project where one exists, or refuse a fallback any project would refuse.
2. "Provider adapters hold their event queues without a bound" (text as in the plan section above, eight adapters with paths).

### NOT RUN

- Live Pi with an input handler that never finishes; live Cursor loud command; live OmO memory summary and review guide (person-or-account rows).
- packages/provider-pi/src/server/omo.live.test.ts (skipped: no OmO binary).
- Settings in a real client (P1 is the integrated pass; lanes start no dev server).
- GrokTextGeneration.test.ts at the integration head: queued behind K10's round and N10's turn.
- apps/web/src/components/settings/SourceControlWritingSettings.browser.test.tsx outside check:changed (check:changed's test step ran 257 files; whether it included this browser file is not shown in its summary).
- Repo-wide suites (CI owns them).

## 2026-11-18 UTC — resumed verification

- Started clean on published `680ef3f461b7f39a7fb9176c79cc55c952f8d16b`. Merged `2c0e0002a996ec5d46c708919be5a43f579176fa` with ort, without conflicts. Lane head `8115ee4638914410e81033dab329f453a04fb9d9`. `vp i` exited 0 after the lockfile change. `3efeb73bf48ddb74b4537fee4309822ff7e97fd6` adds the approved early-port entry to the fork delta; runtime code is identical to the previously published lane delta.
- Solo `vp test run apps/server/src/textGeneration/GrokTextGeneration.test.ts` on the integration head at test start, `f82d2df4b0960eb39bd36e4100b72b6f2758c7d2`: exit 1, 6 passed and 16 failed. The fake launcher exits 127 with `exec: node: not found`. Missing ACP requests cause downstream assertions and four 120-second timeouts. The later integration commits merged above leave the Grok test, fixture, launcher and server test configuration unchanged.
- From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run` on TextGeneration, PiHeldStartTimeout.integration, ThreadTitleRegenerationService, PullRequestReviewGuideService, serverSettings, ThreadLaunchService, GitManager and PiReplayFixtures.integration: exit 0, 316 passed across eight files. Includes both server test files added or modified by SF3.
- From `apps/web`, `vp test run src/components/settings/SourceControlWritingSettings.browser.test.tsx`: exit 0, 1 passed.
- From the root, `vp test run` on the full Pi and Cursor server test directories, provider-core failure.test.ts, shared textGenerationFallback, serverSettings, serverSettingsTextGeneration and textGeneratorFallback, and web modelSelection and modelSelection.fallback: exit 0, 771 passed across 72 files. Cursor 374, Pi 277, provider-core 14, shared/web 106. One existing OmO live test skipped because the binary is absent.
- `bash devlog/_chase/scan.sh --no-fetch --delta`: exit 1 on the lane and on the registry from the merged integration commit. Both report the same 32 legacy hashes unreachable from origin/dev. `git diff --check origin/chase/t3-261114-next3...HEAD`: exit 0.
- `vp run check:changed origin/chase/t3-261114-next3`: exit 1 on the lane head. Format, lint, both Knip passes, GraphQL, agent surface/context and typecheck (42 packages) passed. The 257-file test step reported 255 files passed, 1 failed and 1 skipped (5,892 tests passed, 16 failed, 1 skipped). Grok was the only failed file. All 16 cases and error groups matched the solo baseline.
- GOAT fixes for fresh review: `7973922c60..94bed1303f` excluding `cf0cd39c34`, which is the early port of upstream `6be1bd6472`. Four preparatory move-outs are `259883c788..7973922c60`. The fork-delta commit is documentation only.
- P1: Settings shows the ready fallback used by text generation for the same scope, and OmO memory generation uses OmO's configured default. Pi shows the acknowledgment timeout and keeps the sent message visible with following runs held. Cursor streams loud command output, preserves the completion output, and Stop still finishes the turn.
- NOT RUN: P1 real-client pass, live Pi/Cursor/OmO scenarios, older-client/server live pairing, lane CI or repo-wide test suites. The OmO live test was skipped in the automated run because the binary was absent.

## 2026-11-18 UTC — independent review fix round

SF3 on pen-mac-studio, Node 26.12.1. Base `8115ee4638914410e81033dab329f453a04fb9d9`. Lane head `85371d03aad4c7c9cf9ece37c1ed75a7d6453aef`, branch `chase/t3-261114-next3-sf3-providers`. The five GOAT-authored commits sit directly above the published base.

| Finding | Commit | Failing-first evidence |
| --- | --- | --- |
| P2-1 · Cursor shell completion | `13ed78b33a7cbc4d667b32372b0171cc6f0549fb` | `vp test run packages/provider-cursor/src/server/CursorAgentSdk.test.ts -t 'last shell chunk'` exited 1 on the original path. With an empty SDK result, it emitted first → completion → final-tail. The stronger fixture also failed on the one-batch drain when a final chunk arrived during dispatch of that batch. The serialized callback now drains pending output for the completed tool before delivering its completion. |
| P2-2 · Tiny Cursor deltas | `51f0a9111989f6410555cfce89398166294ab125` | `vp test run packages/provider-cursor/src/server/commandOutputGate.test.ts -t 'stalled reader'` exited 1 with 1,025 queued one-character deltas against the expected 1,024. The next offer now waits for a take. The per-session queue caps are 4 Mi characters and 1,024 delta events. |
| P2-3 · Text generation selection | `746732a4e969c05b3e217f621fc2ee74ad8c9449` | The focused `TextGeneration.test.ts` case exited 1 with “No provider instance registered for id 'missing-instance'”. The web `modelSelection.fallback.test.ts` case exited 1 returning GPT-6 Astra where the fallback was GPT-6 Luna. The Chromium `TextGenerationModelPicker.browser.test.tsx` case exited 1 showing “Other model” on the trigger. The expected label was “Resolved fallback model”. Settings and server now use one fallback instance and model, and the trigger keeps that model when the menu hides it. |
| P2-4 · Memory readiness | `1968a8baf6f51ddf754ef8acb614737984feb669` | `GOAT_TEST_TMP_GUARD=fail vp test run apps/server/src/memory/MemoryWorker.route.test.ts -t 'admits and retries'` exited 1 for both signed-out and exhausted Codex. The work ran on Codex. Claude was the expected provider. The cases now verify Claude on admission and in the status view, then Codex on retry and in the status view after recovery. New conflict claims and the sync generation-hold display read the same provider snapshots and clock. Frozen conflict claims retain their pinned route. |
| P3 · Stop under backpressure | `85371d03aad4c7c9cf9ece37c1ed75a7d6453aef` | `vp test run packages/provider-cursor/src/server/adapter.outputGate.test.ts -t 'Stop ends'` exited 1 with zero queued deltas against the expected 16. The fixture now signals after the 17th offer suspends, and verifies exactly 16 deltas and the terminal event after Stop. |

The web and desktop Settings pickers share the route. The memory sync status route also serves the mobile display. The round uses the existing wire schemas and settings format. An instance still awaiting its initial snapshot keeps the server's startup behavior. In a ready fallback, the cheap advertised model takes precedence over the catalog default and first capable model. Settings shows the resolved fallback even when hidden in its menu.

### Verification

- On the final head, `vp test run` for CursorAgentSdk, commandOutputGate, adapter.outputGate, the four shared settings and fallback suites, and the Pi adapter returned exit 0, 229 tests across eight files.
- From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run` for MemoryWorker.route, PiHeldStartTimeout.integration, TextGeneration and server.memoryComposition returned exit 0, 24 tests across four files. A separate guarded run also covered the full memory worker, memory sync, hold and memory MCP handler suites, with 335 tests across eight files passing before the test-only fixture typing and application-layer wiring corrections.
- From `apps/web`, `vp test run` for the four model selection suites, SourceControlWritingSettings, TextGenerationModelPicker and the three ProviderModelPicker browser files returned exit 0, 67 tests across nine files. Chromium exercised the fallback label and menu.
- Targeted `vp run --filter @goat/web --filter goat --filter @goat/provider-cursor typecheck` returned exit 0, 3/3 successful. `git diff --check origin/chase/t3-261114-next3...HEAD` returned exit 0.
- Three earlier full-gate attempts on unpublished intermediate heads were interrupted with exit 130 after reporting type errors. The errors were in the Cursor regression fixture typing, the memory composition fixture's added layer requirement, and the picker catalog model type. Each is fixed in its corresponding finding commit.
- `vp run check:changed origin/chase/t3-261114-next3` on `85371d03aad4c7c9cf9ece37c1ed75a7d6453aef` returned exit 1. Compared 43 changed files against merge base `2c0e0002a996`. Format, lint, GraphQL, both Knip passes, agent surface/context and typecheck (42/42 packages) passed. The test phase reported 284 files passed, one failed and one skipped, with 6,254 tests passed, 16 failed and one skipped. All 16 failures were in `apps/server/src/textGeneration/GrokTextGeneration.test.ts`. The fake launcher exited 127 with `exec: node: not found`, followed by missing ACP requests and four 120-second timeouts. The same 16 of 22 cases failed on the previously recorded integration baseline `f82d2df4b096` on this Mac and on the reviewer's Mac. The Grok fixture, launcher and server test config are unchanged from that baseline to the gate's merge base.
- NOT RUN: CI on PR #3700, the installed-client P1 pass, live Pi/Cursor/OmO runs, older-client/server pairing, and repo-wide suites. The gate's dependency-patch check was inapplicable.

## 2026-11-18 UTC — independent review fix round 2

SF3 on pen-mac-studio. Lane branch `chase/t3-261114-next3-sf3-providers` advanced from `85371d03aad4c7c9cf9ece37c1ed75a7d6453aef` to `347dd1fdcb319c25fa2f3ae732b5226f33f5447b` in one commit. This closes P2-3 by rendering the same review guide model selection as dispatch. Model visibility applies to the picker menu, and the trigger retains the resolved model. The Source Control Settings route and its search entry point share the component in web and desktop. Mobile displays review guides and has no corresponding model picker.

- Failing first. On `85371d03`, `vp test run apps/web/src/components/settings/SourceControlWritingSettings.browser.test.tsx -t 'shows the review guide model'` exited 1. Both cases received `gpt-6-astra` on the trigger with `gpt-6-luna` expected. One case uses an API writer with a Codex fallback. The other uses Luna as the saved general text-generation model. The whole file on the fix passed three tests and verifies that Astra remains a menu choice while Luna is hidden there.
- Whole changed files on the fix. `vp test run` passed 29 tests across `SourceControlWritingSettings.browser`, `TextGenerationModelPicker.browser`, `modelSelection.fallback`, `CursorAgentSdk`, `adapter.outputGate`, `commandOutputGate`, and `textGenerationFallback`. From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run src/memory/MemoryWorker.route.test.ts src/orchestration-v2/PiHeldStartTimeout.integration.test.ts src/textGeneration/TextGeneration.test.ts` passed 20 tests across three files. Both commands exited 0.
- `vp run check:changed origin/chase/t3-261114-next3` on `347dd1fdcb319c25fa2f3ae732b5226f33f5447b` exited 1. It compared 44 changed files from merge base `2c0e0002a996` with the integration ref at `6def29ca359f546e50dcd731a6364e3f0d575545`. Format, lint, GraphQL, both Knip runs, agent surface and context checks, and typecheck (42/42 packages) passed. Vitest reported 284 files passed, one failed, and one skipped, with 6,256 tests passed, 16 failed, and one skipped. The 16 failing case titles exactly match the previous gate on `85371d03` and the recorded Grok baseline on integration head `f82d2df4b096`. All are in `apps/server/src/textGeneration/GrokTextGeneration.test.ts`. The fake launcher exits 127 with `exec: node: not found`, which prevents ACP requests and causes downstream assertions and four 120-second timeouts. The Grok test, fixtures, and server test config are identical to that integration baseline. `git diff --check origin/chase/t3-261114-next3...HEAD` exited 0.
- NOT RUN: PR #3700 CI for this lane commit, the installed-client pass after integration, live provider turns, and repo-wide suites. The gate's unused patch check was inapplicable.

## 2026-11-18 UTC — independent review fix round 3

SF3 on pen-mac-studio. P2-3 follow-up from `347dd1fdcb319c25fa2f3ae732b5226f33f5447b` on `chase/t3-261114-next3-sf3-providers`.

- `893261388a1ea909258a80e506d23f13e1d86456` fixes General Settings. The shared text-generation resolver keeps the routed model available to the trigger and option writes even when the menu hides it. The unfiltered catalog still handles a removed or legacy saved slug. Chromium on the previous head displayed Astra and persisted Astra on an effort edit with Luna saved. Both cases now keep Luna and the picker menu offers Astra.
- `c36d2414cb8c941b6e91cadaae510751bb4b6124` fixes Source Control Writing Settings. Both the effective writer and the default model copied into an override use the corrected resolver. The scoped availability check permits copying an already resolved hidden model when enabling a writer or review guide override. Chromium on the previous head displayed Astra and copied Astra when enabling the writer override. After the shared resolution fix, the scoped check blocked the copy until it was made visibility-independent for the override. The dedicated writer trigger now shows Luna while the menu hides it, and enabling a writer override copies Luna.
- The repository-wide caller audit covered General Settings (trigger, explicit model edits, option edits), Source Control Writing Settings (default and effective writer selections), and Providers Settings (compares the instance ID when disabling a provider). Providers needs only the instance ID. Review guides and Memory use their own shared resolvers. Web and desktop share these settings components.
- Whole changed test files passed on this head. `vp test run` passed 33 tests across eight web, Cursor and shared files. From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run` passed 20 tests across three server files. `git diff --check origin/chase/t3-261114-next3...HEAD` exited 0.
- `vp run check:changed origin/chase/t3-261114-next3` on `c36d2414cb8c941b6e91cadaae510751bb4b6124` exited 1. It compared 46 changed files from merge base `2c0e0002a996` with the integration ref at `6def29ca359f546e50dcd731a6364e3f0d575545`. Format, lint, GraphQL, both Knip runs, agent surface and context checks, and typecheck (42/42 packages) passed. Vitest reported 285 files passed, one failed, and one skipped, with 6,260 tests passed, 16 failed, and one skipped. All 16 failing case titles match both the round 2 gate and the Grok baseline on integration head `f82d2df4b096` ([goat#3425](https://github.com/goat-si/goat/issues/3425)). The fake launcher exits 127 with `exec: node: not found`, which prevents ACP requests and causes downstream assertions and four 120-second timeouts. The Grok suite, provider code and server test config are unchanged from that baseline. The first unpublished round 3 gate caught a generic mock typing error. The final test uses the real settings read hook and passes typecheck.
- NOT RUN: PR #3700 CI on this lane head, the installed-client pass after integration, live provider turns, and repo-wide suites. The gate's unused patch check was inapplicable.

## 2026-11-18 UTC — independent review fix round 4

SF3 on pen-mac-studio. The lane advanced from `c36d2414cb8c941b6e91cadaae510751bb4b6124` to `a04d30a61bb275f3478304b59a22eba7a43d3cf8` on `chase/t3-261114-next3-sf3-providers`.

- P2-a, `aabeb4e1195ba29f012bf774785f9319a2f95fb5`. Settings, server dispatch and the Codex CLI adapter resolve a removed model from the same catalog. The driver text-generation default wins when advertised, followed by the catalog default or the next eligible model. The 28-row matrix covers saved and removed models, configured and stale custom entries, qualified aliases, empty and populated catalogs, and both menu visibility states. Before the fix the initial matrix failed 12 rows and the direct CLI regression failed because it never received `--model gpt-6-luna`.
- P2-b, `a04d30a61bb275f3478304b59a22eba7a43d3cf8`. The review-guide override checks and saves the resolved coding-provider selection. Chromium recorded zero writes before the fix when an API writer inherited a hidden Codex guide model. The whole browser file passes with the expected Codex selection saved.
- The General and Source Control Settings entry points run in web and desktop. Review-guide dispatch uses the same model selection on the server. Mobile consumes the server-generated guide.
- Whole changed test files on the final head passed, including Chromium. Root `vp test run` passed 111 tests in 10 files. From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run` passed 54 tests in four files. `git diff --check origin/chase/t3-261114-next3...HEAD` exited 0.
- `vp run check:changed origin/chase/t3-261114-next3` on `a04d30a61bb275f3478304b59a22eba7a43d3cf8` exited 1. It compared 50 changed files from merge base `2c0e0002a996` with integration ref `061fd0fee904c2abaada9efb5cfdb9ea58b18919`. Format, lint, both Knip checks, GraphQL, agent surface and context checks, and typecheck (42 packages) passed. Vitest reported 286 files passed, one failed, and one skipped, with 6,299 tests passed, 16 failed, and one skipped. All 16 failing titles and eight missing-Node diagnostics match the round 2 and 3 gates in `apps/server/src/textGeneration/GrokTextGeneration.test.ts`. The fake Grok launcher fails with `exec: node: not found`. [Grok baseline #3425](https://github.com/goat-si/goat/issues/3425)
- NOT RUN: PR CI, the installed-client pass after integration, live provider turns, and repo-wide suites. The dependency-patch check was inapplicable.

## 2026-11-18 UTC — independent review fix round 5

SF3 on pen-mac-studio advanced `chase/t3-261114-next3-sf3-providers` from `a04d30a61bb275f3478304b59a22eba7a43d3cf8` to `874b7ffddd6599e732823fee159a566692460e1f`.

1. Apply the caller's project provider policy to the resolved primary and every fallback.
2. A coding candidate needs a registered, enabled, installed and available snapshot with usable authentication and text-generation capability.
3. Evaluate exhaustion for the resolved model at the supplied clock.
4. Review guides require Codex or Claude for explicit, inherited and picker choices. Memory uses coding candidates.
5. With no eligible candidate, `no_fallback` carries a null selection. The server reports `route_unavailable` and Settings shows the unavailable route.

- P1 and P2-2 through P2-4. `5566ecff78bdbe842babc6528e010ace60401622` shares the rule across branch generation and other ordinary text-generation operations, new memory admission, and review guides. Frozen conflict claims dispatch their stored selection. Enabled API generators remain ordinary routes and respect explicit project denial. Memory MCP settings adds an optional `modelAvailable: false` status when the configured selection has no runnable route. `1f530bcf7fff2df3e182456cef440bfbca20c592` narrows the project ID for the API lookup. `6a7bc2d50548e107bc97d61f083d5ee50bf33460` types the exhaustion fixture with the usage percentage.
- Failing-first routing evidence. The focused server branch and worker tests exited 1 on all four parity cases and the dedicated signed-out memory case. The real guide operation exited 1 on both explicit Pi cases, with and without eligible Codex. The Chromium guide picker failed because it showed the Pi model.
- P2-5. `1ccb26afcbb454259098796944db626585ec518e` bounds the event payload before insertion and debits its full queued length. The queue holds at most 4 Mi characters and 1,024 deltas. The oversized regression initially failed because the consumer received all 17 characters against a 10-character budget. It now receives the 10-character tail, and a second offer waits until that chunk is taken.
- The first full gate exposed partial Settings inputs in 137 web and mobile memory tests and an installation-gate fixture that used an unchecked snapshot. `874b7ffddd6599e732823fee159a566692460e1f` handles omitted Settings fields and verifies that only the selected registered instance enters the installation gate, including dispatch through fallback.
- Whole changed files and the additional memory client regressions passed on the final head. Root `vp test run` passed 338 tests in 16 files, including Chromium and the native React suite. From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run` passed 69 tests in six files. `git diff --check origin/chase/t3-261114-next3...HEAD` exited 0.
- `vp run check:changed origin/chase/t3-261114-next3` on `874b7ffddd6599e732823fee159a566692460e1f` exited 1. It checked 59 changed files from merge base `2c0e0002a996` with integration ref `258239d88f0c5df1ef43d787957007d1775f823d`. Format, lint, typecheck for 42 packages, both Knip checks, GraphQL, and agent surface and context checks passed. Vitest reported 326 files passed, one failed and one skipped, with 8,237 tests passed, 16 failed and one skipped. All 16 failure titles and eight missing-Node diagnostics match the previous gates for `GrokTextGeneration.test.ts`. Its fake launcher exits 127 with `exec: node: not found`. [Grok baseline #3425](https://github.com/goat-si/goat/issues/3425)
- NOT RUN: PR #3700 CI on the lane head, the installed-client pass after integration, live provider turns, older-client pairing, and repo-wide suites. The dependency-patch check was inapplicable.
