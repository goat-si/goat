BLOCK 2a94ed4deb589b8e4f02b0da7e776be9f3e0588f

This verdict covers Part A only (contract, server, stored data, agent-visible text, the dependency, shared packages, mobile). The block comes from two P2s. A reply sent from a side chat or a fork silently reaches the agent as "unavailable". Typing in the Decisions inbox erases answers already typed in the thread composer. The server never trusts the client-built record, and older readers drop the record as the owner required; I reproduced both.

The head was 2a94ed4deb at the start (`git ls-remote`, before any work) and still 2a94ed4deb at the end (16:36:09 UTC).

## Findings

**P2-1. A Reply in a side chat or run fork reaches the agent as unavailable, while the person sees a normal reply card.**
- **Where:** apps/web/src/components/chat/TimelineAssistantRows.tsx:245 builds `citation: { ...threadRef, ... }` from the route thread. TimelineAssistantRows.tsx:209 takes `itemId` from `projectedItem.sourceItemId`. apps/server/src/orchestration-v2/ResponseContextCheck.ts:37-39 adds the side-chat parent and the run-fork source to the readable set. But :48-50 then looks the item up under `citation.threadId`.
- **Trigger:** side chats and run forks are both `forkedFrom: {type: "run"}` (ThreadForkService.ts:127-132). They show the source's history as inherited rows that keep the source's `sourceItemId` (ProjectionStore.ts:5511-5530). Reply appears on those rows (only `projectedItem` is required). The record that gets sent names the side chat or fork plus the parent's item id.
- **Consequence:** the server looks up (side chat, parent item), finds nothing, and projects `unavailable="true"`. The agent gets no read line, and nothing tells the person. That is the silent drop ruling 12:57:11 (i) forbids. It is also the main use of a side chat ("about that answer…"). The server's own side-chat and fork rule never matches anything the client sends; its test (ResponseContextCheck.test.ts "reads a side chat's reply…") feeds a shape the client never produces. docs/user/composer.md:177 ("The agent gets where the response is…") is untrue in those threads.
- **Smallest fix:** build `citation.threadId` from `projectedItem.sourceThreadId`. The server rule already admits it, and Go to source would land on the real source. Let `restoreStashedReply` (composerReply.tsx:68) also accept the parent. Add one web test: Reply on an inherited row names the source thread. Fork-of-fork rows (a grandparent source) still fall outside the server's one-level rule; say so or extend the rule.
- **Basis:** RAN a scratch server case in the head's own harness (reviewN14a.ResponseContextCheck.test.ts) with the record shaped the way the client builds it. The output was `<context kind="response" id="response_m1" unavailable="true"/>`, with no thread.read line. The client-side shape is READ (TimelineAssistantRows.tsx:209/:245, MessagesTimeline.tsx:414/:746, session-logic.ts:483-498).

**P2-2. An answer typed in the Decisions inbox erases answers already typed in the thread composer for the same request.**
- **Where:** apps/web/src/components/decisions/useDecisionInbox.ts:87 writes `[key]: answers`, replacing the request's whole entry. DecisionInbox.tsx:81 starts the form from the inbox's own `drafts[current.id] ?? {}` (useDecisionInbox.ts:47), never from the shared store. The composer merges per question (usePendingThreadRequests.ts:85-93).
- **Trigger:** a request with two or more questions. Claude and Codex both send multi-question requests. The person types question 1 in the thread composer, opens the Decisions inbox, and types question 2.
- **Consequence:** question 1's text disappears from the composer, and Stop returns only the inbox's text. That is a regression this lane introduced: before it, the inbox never wrote the shared store. Separately, the inbox shows an empty box for a question already answered in the composer, so typing there throws the composer's text away.
- **Smallest fix:** seed the inbox's item drafts from `usePendingUserInputAnswers[key]` (or read it directly, one source of truth), and merge per question on write. Add a test: composer answers question 1, inbox answers question 2, Stop returns both.
- **Basis:** RAN a scratch browser test using the lane's own harness (reviewN14a.unsent.browser.test.tsx). The store after the inbox edit was `{"scope":{"customAnswer":"Typed in the inbox"}}`, and the prompt after Stop was `"Typed in the inbox"`. The assertion failed: `expected 'Typed in the inbox' to contain 'Typed in the composer'`.

**P3-1. Fork-delta lines that three rulings asked for are missing.**
- **Where:** devlog/_chase/010_fork_delta.md. The lane diff touches no devlog file, and neither the head nor the records branch has these lines.
- **Rulings unmet:** 12:57:11 (ii) (subagents.environmentId), 13:15:52 (b)(5) (the Reply registry; the server check is also a GOAT-only difference), and 13:57:07 (L365's legacy jump-label difference, which belongs to Part B's row).
- **Smallest fix:** add the lines.
- **Basis:** READ (grep at 2a94ed4deb, origin/chase/t3-261114-next-records and 3a254fa1a5).

**P3-2. There is no test for either half of the capability gate.**
- **Where:** nothing asserts `replyToResponse: true` (ServerEnvironment.ts:347). `refuseReplyTheServerDrops` (composerReply.tsx:44, called at useComposerSend.ts:711) and `useReplyToResponseAvailable` (composerReply.tsx:23) have no test. The only coverage of the no-Reply state is the author's capture.
- **Smallest fix:** one assertion in the descriptor test, and one case that a draft reply against a config without the capability is refused with its toast and sends nothing.
- **Basis:** RAN `rg` across the tests.

**P3-3. The server check falls back to "unavailable" silently when its services are missing.**
- **Where:** BuiltInSkillText.ts:34-36 reads `ProjectionStoreV2` and `ServerEnvironmentIdentity` through `Effect.serviceOption`. If either is missing from the calling fiber, every reply goes unavailable with no log. Nothing else in the server reads either service this way.
- **Gap:** I couldn't prove statically that the effect-worker fiber has both. The lane's real-client pass shows the card but not the provider text.
- **Smallest fix:** log when either service is absent, or require both in the type. Show one live Replay transcript of the provider text with the read line.
- **Basis:** READ / INFERRED.

**P3-4. "/side" in the inbox ignores the question's attachments.**
- **Where:** DecisionUserInputForm.tsx:50 hardcodes `hasAttachmentsOrContext: false`.
- **Consequence:** a question holding attachments added from the composer treats "/side …" as a command in the inbox but as a literal answer in the composer.
- **Smallest fix:** pass whether the question's attachment draft holds files.
- **Basis:** READ.

## What checks out

**L18:**
- **Contract:** matches the plan. There's no new wire field or event, and the record rides in `context.records`.
- **Older readers:** RAN through e04442e66c's real contracts (git archive). A context with a response record and a thread record decodes to kinds `["thread"]`; the head decodes `["response","thread"]`. A stored message without the kind decodes the same on both. A 301-char opening, 21 subagents, or a missing itemId drops only the response record and keeps its sibling, on both readers.
- **One choke point:** both callers of `providerTextWithSkills` go through it: turn start (ProviderTurnStartService.ts:740) and steer (ProviderTurnControlService.ts:474). Queued, scheduled, channel, launch/fork initial messages, steer follow-ups (EffectWorker.ts:319), plan follow-ups and fan-out all end in those two calls, each checked against the receiving thread.
- **Fails closed elsewhere:** the slash-command auth path (ProviderTurnStartService.ts:356) and web's pendingUserInput.ts:74/78 pass no checked ids, so they fail closed. The check itself drops unchecked records (ResponseContextCheck.ts:48-55), and the projection drops them again (composerContextReferences.ts:432).
- **Agents can't attach a record:** MCP `thread.send` has no context parameter (agentSurface/entries/thread.ts:236-254).
- **What the agent gets:** provider text carries only client-supplied text: the opening (capped at 300 by the schema and again by the slice), a 64-char label, and subagent titles, all escaped. The read call is `goat_call {path:"thread.read", …}`. The read line can name only the receiving thread, its side-chat parent or its fork source on this server, and the agent's own thread.read authority remains the boundary, so the sender gains no read access. The server check's negative tests RAN and pass.
- **Agent surface:** no diff under apps/server/src/mcp or contracts/agentSurface. McpToolAccess.capabilities.test.ts and agentSurface.test.ts RAN, 43/43.
- **Web state:** the draft `replyTo` tests RAN. Failed send, stash and queued edit READ correct. The registry is a WeakMap keyed by form with ref-callback cleanup. The side chat panel sits after the main column (ChatView.tsx:4141 vs :3396), so Reply finds the right composer. composerReplyTarget tests RAN.
- **Banner fix:** right for every banner. Each dismissible banner's own `onDismiss` persists the dismissal, so forgetting the id only lets a new instance show. Test RAN.
- **SSH move (dd8fbe93f1):** bodies identical under `diff -w` (RAN). The refs were and still are read inside the port functions at call time. The toast's retry builds its ports at click time. ChatView.ssh.browser.test.tsx RAN and passes.
- **Guest page:** Reply stays hidden. GuestPage.tsx:363 keys its timeline by `guest-${shareId}` (environment `guest`, no server config), and TimelineAssistantRows.tsx:228 returns null.
- **Mobile:** the chip is READ correct.

**O28:**
- **Lockfile:** the diff removes morphicons' importer, package and snapshot. Three `@alchemy.run/* 2.0.0-beta.85` entries change only their peer-hash suffix, and the only removed resolution or integrity line is morphicons'.
- **Imports:** nothing in apps or packages imports morphicons or MorphIcon.
- **nodes.ts:** still used by composerInlineChip.ts:1 and contextMenuFallback.ts:3.

**L353:**
- **Adapter:** imageView becomes a `view_image` dynamic_tool item with the existing `viewedImagePath`, an upsert by item id across item/started and item/completed. The test RAN.
- **Older clients:** the base already reads `viewedImagePath`, so they show the image in the expanded tool row.
- **Path safety:** opening the image goes through `media-file`, which needs the filesystem-read scope (RpcAuthorization.ts:419-425), and network paths are refused outside the thread's project (AssetAccess.ts:368-377, ws.ts:2972). The lane leaves this unchanged; the thumbnail is a new automatic request under the same scope the person already holds. Remote threads resolve the path on their own environment.
- **Untouched and moved code:** other adapters are untouched. The Codex detail, mobile itemPreview and TurnDiffStat moves are verbatim (RAN script diffs).

**C3:**
- **Scan cost:** RAN linear on ten pathological shapes up to 160k characters; the worst was 13 ms.
- **Edge cases:** nested labels, unclosed titles, escaped brackets, code spans, reference links and paren titles all match how CommonMark renders them.

**O1 (shared half):**
- **Edge cases:** RAN. An empty comment splits the text around it; adjacent citations stay separate segments; CRLF comments are joined with spaces; the quote text is not indexed.

**Addition (a):**
- **Move:** verbatim, except `questionDraftKeysForRequests`, which now takes plain keys.
- **Storage:** answers live in an in-memory zustand store (no localStorage), keyed by `[environment, thread, request]`. Another thread's or environment's answers can't land in this draft. Cancel and expiry prune through the one listener.

**Other agent-visible text:** I read every hunk under apps/server, packages, apps/mobile, docs/user and scripts. Nothing rides along beyond the named rows.

**Rule 3 and budgets:**
- **Rule 3:** the Part A test files change only on authorised lines, plus import lines and added cases.
- **Budgets:** all 27 budgeted files the lane touched equal their real line counts. No touched file is over 1000 lines, and the Part A additions add no non-null assertion or `any` cast.

## Merge state

I computed every number below with `git merge-tree` and `wc` on the merged trees. All four branches share merge-base e04442e66c.

| Branch | Conflicts | Resolution |
| --- | --- | --- |
| chase/t3-261114-next2 (3a254fa1a5) | code-budgets.json only | GitActionsControl.tsx 1375, LegacySidebar.tsx 3883; both equal the merged files' lengths. No other file changed on both sides. |
| SF1 (410daab8e6) | useComposerSend.ts: one import hunk (the lane dropped `DraftSshDestination`, SF1 dropped `UnifiedSettings`; the merged file uses neither, so drop both) | useComposerSend.ts becomes 1635 lines. ThreadFeed.tsx changed on both sides but merges cleanly at 3344. Budget entries: useComposerSend.ts 1635, ThreadFeed.tsx 3344. |
| N4c (4fa20e693f) | none | No file changed on both sides. |
| N12c (e79c46a7de) | code-budgets.json, same as the integration branch | GitActionsControl.tsx 1375, LegacySidebar.tsx 3883. |

## The author's claims

**Confirmed by my runs:**
- The decoder transcript (kinds `["thread"]`).
- The server check's negative cases, and the MCP counts unchanged.
- ChatView.ssh passing after the lazy SSH ports.
- The lockfile contents, budgets equal to real lengths, Part A Rule 3 adherence, and verbatim move-outs.
- The banner fix test, the reply draft, stash and snapshot tests, the viewed-images tests, and the inbox tests.

Focused runs: 12 unit files with 108 tests, and 6 lane browser files with 55 tests, all passed.

**Resting on the author's report:**
- Fail-first output at the lane's test commits.
- The real-client captures, including the no-Reply state against the old server.
- `vp i --frozen-lockfile` passing.
- That the live runtime delivers the read line (see P3-3).
- The mobile native views.

**CI run 44118636205** (exact head, workflow_dispatch) at 16:36 UTC: every finished job succeeded (goat-check, goat-typecheck, goat-test, goat-test-changed, goat-build, desktop, mobile, contracts, packages, shared, client-runtime, Windows and the rest). Server shards 1-4 were still in progress, with no failures.

The scratch folder stays at /tmp/n14a-review-2a94ed4d. It holds the head export, the e04442e66c contracts, merge-tree outputs, and my scratch tests and scripts. Its node_modules is APFS-cloned from chase-t3-261114-next2-p-928281268705de82, which is at e04442e66c. That install differs from the head only in that morphicons is still installed. My first clone came from a stale install that lacked `unbash`, so I replaced it.

NOT RUN: `vp i --frozen-lockfile`; local typechecks (CI's goat-typecheck is green on the head); re-running fail-first at the lane's test commits; the server shards (CI still running); a live Replay turn showing the provider text; mobile native views; desktop build; the full web and server suites.

BLOCK 2a94ed4deb589b8e4f02b0da7e776be9f3e0588f
