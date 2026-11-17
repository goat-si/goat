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
