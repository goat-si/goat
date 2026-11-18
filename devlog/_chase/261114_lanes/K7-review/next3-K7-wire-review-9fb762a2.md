I recommend holding the merge until the coordinator decides one P2 in row 8. Rows 6, 7 and 9, the move-outs, the budgets, rule 3 and the merge commit all check out. The only other findings are four P3s.

The branch head was `9fb762a2b5f969b2948b3edb22bf12b42a07d3e2` on `git ls-remote` at both the start and the end. The scratch folder is `/tmp/k7wire-review-9fb762a2`, and I left it in place: the head tree is in `./head` and notes, probes and logs are in `./notes`. The lock file there is blob 34dad940; I cloned `node_modules` from `/tmp/k10-review-4fa174d2/head`, which has the same lock file. Every scratch file I mutated was restored and checked with `cmp` against the head's own copy.

## Findings

**P2-1. Raw text from a provider CLI now goes into a stored event, the shell, a toast and the MCP thread detail.**
- **Where:** `failureMessage` in `ThreadTitleRegenerationService.ts:61-74` takes the last non-empty line of `TextGenerationError.detail`. That line is written at `Orchestrator.ts:3612-3620`, passed on at `threadShellProjection.ts:480` and `:764`, and added to the MCP thread detail at `mcp/threadListView.ts:285-291`.
- **Trigger:** a title regeneration that a person asked for fails on a provider CLI. For Codex the detail is the CLI's whole stderr, or its stdout when stderr is empty (`CodexTextGeneration.ts:615-624`). For Claude it is the CLI's error result or its stderr (`ClaudeTextGeneration.ts:384-393`). Other paths build fixed text of their own, such as `TextGeneratorApi.ts:144`, the Antigravity details and `textGenerationUtils.ts:134`.
- **Consequence:** the last line of a CLI's output is kept in the thread for good. Every client receives it in the shell, a toast shows it, and any agent can read it in the thread detail. That line can be:
  - a provider error with a request id or a URL;
  - an OpenAI-style message such as "Incorrect API key provided: sk-…abcd", which carries a masked key fragment;
  - a log line, if the person's environment makes the CLI log to stderr;
  - a line of the echoed prompt, which is conversation text, if the CLI dies mid-echo.

  GOAT already masks credentials in server logs (`redactLogText`, `observability/LogTextRedaction.ts:430`), but this path skips that. Upstream's `1c9ea568a1` has the same function byte for byte, so this is upstream's choice. GOAT's difference is that the line now also reaches the MCP detail.
- **Smallest fix:** keep the fixed messages for details GOAT builds itself. When the detail is a CLI's raw "… CLI command failed: …" output, record a fixed "‹Provider› could not generate a title." and leave the raw text in the server log, which is already redacted. The author lists this as option B. At the very least, run the line through `redactLogText` before it is stored.
- **Basis:** READ the code and upstream's hunk. What the line can contain is INFERRED from provider error formats; I did not reproduce it.

**P3-1. The 300-character cap is untested, and the contract does not limit the message.**
- **Where:** `ThreadTitleRegenerationService.ts:71-73`, and `message: Schema.optional(Schema.String)` in `threadTitle.ts:16`. The command is part of the public `OrchestrationV2Command` union (`orchestrationV2.ts:3176-3183`), which `ws.ts:1819` dispatches under `AuthOrchestrationOperateScope` (`RpcAuthorization.ts:70`).
- **Trigger:** the mutation that removes the cap passes all 10 cases. A client with the operate scope can already send this command against an armed request id, which the shell shows.
- **Consequence:** a message of any length can be stored and sent to every client. This needs operate access, which can already rename threads.
- **Smallest fix:** add `.check(Schema.isMaxLength(300))` on `message` in `threadTitle.ts`, plus one case for the cap.
- **Basis:** RAN (mutation M9) and READ.

**P3-2. A regeneration from the chat header never shows an outcome for archived or older settled threads.**
- **Where:** `threadTitleRegeneration.ts:26-29` looks the thread up only in the active shell snapshot. On the main stream, `archivedThreads` is always empty (`ShellStream.ts:73`, `:537`, `:564`), idle subagents are left out (`ShellStream.ts:82-101`), and older settled threads are cut off.
- **Trigger:** "Regenerate title" from the chat header (`threadActionMenu.logic.ts:249-257` has no archived check) on an archived thread, or on an older settled thread opened from search or a link.
- **Consequence:** the wait settles to null at once, so the person sees no "Title kept" and no failure toast. That is the same silence as today, so it is not a regression; the new feature just does not reach these threads. The author's notes mention only the older-settled case.
- **Smallest fix:** when the thread is not in the snapshot, settle from the open thread's own subscription, where `AppThread.lastTitleRegeneration` exists. Otherwise, write down the limit.
- **Basis:** READ.

**P3-3. After a child's run ends with a handoff still open, the push and the screens disagree.**
- **Where:** the client roll-up needs the child's run to be live (`threadShell.ts:52-60`, used by `subagentRequest` at `:63-75`). The server keeps a human handoff pending with no live run (`threadShellProjection.ts:326-334`). The push path (`SubagentWaits.ts:37` → `subagentRequestAwareness`, `agentAwareness.ts:45-69`) skips the live-run check for blocking requests.
- **Trigger:** a delegated agent opens a `human_handoff`, then its run ends.
- **Consequence:** the phone push keeps saying "Waiting for input", while the parent rows on web, desktop and mobile drop "Input needed".
- **Smallest fix:** in `pendingSubagentRequestsByThread`, skip the live-run test for `userOnly` cards, since the server already decides whether they are pending. Otherwise, rule which behavior is intended.
- **Basis:** READ; not run.

**P3-4. The "Title kept" wording is wrong for the placeholder case.**
- **Where:** `ThreadTitleRegenerationService.ts:214-218` and `threadTitleRegenerationToast.ts:44-50`.
- **Trigger:** the model returns "New thread".
- **Consequence:** the toast says "The current title already fits this thread", when in fact the model gave up. This is upstream's text.
- **Smallest fix:** keep it as upstream's text, or reword it to something like "No better title was found."
- **Basis:** READ.

## What checks out

**Row 8, title outcomes** (READ unless marked)
- **(b) Older and newer peers.** No client-side decode of the shell or the thread sets `onExcessProperty`. The only uses in client-runtime, web and mobile are in `memoryImportRecovery.ts:48`, which is unrelated. So an older client ignores `lastTitleRegeneration`, and fleet health decodes it the default way (`Health.ts:44-45`).
- **(b) Newer client on an older server.** The server sends no `lastTitleRegeneration`, so `settledOutcome` waits while `titleRegeneration` names the request and settles to null once it clears. No "kept" or "failed" toast is invented, because null gives no toast in `titleRegenerationToast`.
- **(b) Stored data.** The stored older event decodes, by the author's test; I ran the files.
- **(b) Who can dispatch the completion.** Any client with operate scope can, as before; see P3-1. No MCP tool dispatches it.
- **(e) Retries.** Kind "initial" keeps its two retries and records no outcome; kind "regenerate" has none. The retry lines did not change, and mutation M8 is caught.
- **(f) MCP.** The field appears only in the thread detail (`threadListView.ts:285-291`), not in list items. I did not run the agent surface audit or the context budget; see the author's claims.

**Row 7, user-only waits**
- **(a) A card appears and clears once.** A child's card update passes `ShellStream.ts:380-382` and the relay at `AgentAwarenessRelay.ts:131-136`. The shell recomputes the child, and the client marks every ancestor in its lineage at `threadShell.ts:91-99`; a grandchild marks each level. Answering or cancelling the card is a turn-item update that is kept, so the mark clears. The end of a run arrives as `run.updated`, which already passes. Archiving or deleting the child removes it from `threads`.
- **(b) What the filters now let through.** One card produces about two or three updates. Each costs one shell aggregate refetch and one frame per shell subscriber, plus one relay recompute, which is skipped when nothing changed (`AgentAwarenessRelay.ts:166-178`). Mutation M4 shows that no other item type gets through: four server cases fail.
- **(d) No secret on the wire.** `userOnly` is only a flag, and the handoff title stays capped at 160 characters as before.
- **(e) Stored rows.** Both projection paths call `secretRequestAsPendingInput` (`ProjectionStore.ts:6992`, `threadShellProjection.ts:326`). So the record's "no reprojection" answer holds: a card pending across the upgrade gets the flag on its first read.
- **(f) Who reads the roll-up.** Web reads it at `ThreadNotificationCoordinator.tsx:201` and `:451`, and web and mobile through the atom at `threadShell.ts:219`. Two other classifiers predate the lane and were not changed: the per-parent children list at `threadShell.ts:341`, which still lists ordinary questions, and the server's `SubagentWaits`. One side effect is worth knowing: a top-level thread's own secret card now also pushes as soon as it appears. That is an improvement.

**Row 9, terminal history**
- **(a) The cut is correct.** I RAN a probe in `notes/retainedProbe.mts`. Over 20,000 random histories, trimming on the server and then on the client gave exactly the old client trim run on the full history. That held with the same bound and with a smaller client bound, the result was idempotent, and it never went over the bound. The targeted cases all come out right:
  - cuts inside CSI, OSC ending in BEL, OSC ending in ST, DCS, a lone ESC followed by a letter, and ESC `[` all give `"tail"`;
  - a cut inside a surrogate pair moves to the next code point;
  - a lone surrogate in the retained part keeps the index arithmetic right, because U+FFFD is one UTF-16 unit, the same as the surrogate it replaces;
  - a BOM at the cut is kept;
  - a bound of 0 gives an empty string, and a bound above the size returns the history unchanged.
- **(e) Manager.ts.** It counts 3103 lines with `countLines`, which equals its entry, and `e0e43c15bf` is a verbatim move.

**Row 6, `hostOnly`**
- **(a) Older and newer peers.** The decode test runs against a copied older struct (`assets.hostOnly.test.ts:7-14`), not dev's real schema. That is still valid, because Effect structs ignore extra keys by default and no server asset decoder sets `onExcessProperty`.
- **(b) The fallback.** The local fallback only runs when a local environment exists and is not the thread's own (`state/assets.ts:291-305`).
  - A local thread is always served by its environment.
  - A remote thread whose relative file is missing now shows the error (mutation M12 is caught).
  - An absolute path outside the workspace still falls back.
  - Mobile builds its own resource with the flag (`markdownMedia.ts:116-125`).
- **(c) What counts as relative.** `./a.png`, `a.png` and `../a.png` are relative (`markdownImages.ts:84`). `~/a.png` is blocked. A Windows drive path or a `file:` URL is treated as a host path, not as relative. The server resolves media-file paths as before (`AssetAccess.ts:554-575`): a `../` that leaves the workspace was not refused before and is not refused now. I did not read `finalizeAbsoluteMediaFileAsset`.

**Move-outs, budgets, merge and tests**
- **Move-outs.** In all five, the removed lines equal the added lines once `export`, imports, the re-export and the budget line are set aside. Former importers resolve through the re-exports in `orchestrationV2.ts` and `Orchestrator.ts`; the other three symbols were private. The `executeAtomQuery` move is byte for byte apart from one trailing blank line.
- **Budgets.** All 11 changed entries (22 lines) equal `countLines` at the head, none was raised, and every new file is under 1,000 lines. The largest is `server.updateResume.test.ts` at 516.
- **The merge commit.** The combined diff of `9fb762a2b5` is empty. Its tree equals `git merge-tree` of `1e1518f039` and `259883c788` except for `code-budgets.json`, which was resolved to the lane's side (Manager.ts 3103).
- **New tests.** None has sleeps, polling, per-test timeouts, retries or wall-clock deltas, and none is a static-markup or callback-wiring test.
- **Fork delta.** Both new entries in `010_fork_delta.md` are accurate and short.

**Runs and mutations** (all RAN)
- Focused files, whole, one vitest process at a time: server 6 files and 69 tests; contracts 2 and 25; shared 1 and 29; client-runtime 8 and 142; web 1 and 3; mobile 2 and 138. All passed. Contracts holds no `retainedTerminalHistory` case: those live in `Manager.retainedHistory.test.ts` and `terminalSession.test.ts`.
- Mutations:
  - M1, dropping the sequence step: "starts a bounded snapshot after a control sequence its cut lands in" fails, as does the client case "does not retain the tail of a control sequence whose introducer was trimmed".
  - M2, dropping the code point loop: the server case "sends bounded attach streams only the history the client retains" fails; the client cases pass.
  - M3, returning the listener unchanged: all 3 retained-history cases fail.
  - M4, the keep rule always true: 4 server cases fail; shared passes.
  - M5, the keep rule false for `human_handoff`: the ShellStream case and the relay handoff case fail.
  - M6, dropping `userOnly`: both `ProjectionPendingRequest` cases fail.
  - M7, dropping the `userOnly` condition in `threadShell.ts`: "flags the parent while a live subagent waits on a secret card" fails.
  - M8, sending the outcome for "initial" too: "records no outcome for a first-message title" fails.
  - M9, dropping the 300-character cap: **nothing fails** (P3-1).
  - M10, dropping the request id comparison: "resolves with the outcome recorded for its own request" fails.
  - M11, dropping the disconnect branch: "settles without an outcome when the environment disconnects while waiting" fails.
  - M12, dropping the `hostOnly` condition in `state/assets.ts`: "keeps a relative image that leaves the workspace on the thread's environment" fails.

## The open questions

- **1(a), the provider error text.** The line can be raw CLI output with request ids, URLs, masked key fragments, log lines or echoed conversation text, and it is upstream's choice. I recommend mapping a CLI's raw output to a fixed message per provider and keeping the detail in the redacted server log (P2-1).
- **1(c), the wait with no deadline.**
  - Every way out of `execute` records a completion, including the two-minute deadline. A server restart or worker interruption disconnects the client, which settles to null; the effect then reruns. A superseding request, a deletion, a fork or a manual rename clears the marker, which also settles to null.
  - Only an effect whose completion dispatch fails all five worker attempts (`EffectWorker.ts:875-900`), or a worker that is backed up, leaves the marker armed. That was already true before this lane. In that case the promise and its two subscriptions live until the page closes or the connection drops, the menu shows "Regenerating…", and a multi-select toast waits for the slowest thread (`Promise.all`).
  - The snapshot's lists are partial; see P3-2.
- **1(d), entry points.** Every entry point that exists either reports the outcome or, in the MCP tool's case, leaves it readable afterwards; none was missed. The command palette, the mobile thread screen and scheduled tasks have no regenerate entry. MCP `regenerate_title` (`ThreadMetadataMcpService.ts:84-89`) returns at once, and the outcome shows up later in the thread detail.

  | Entry point | Reports the outcome? |
  |---|---|
  | Web sidebar row menu (`Sidebar.tsx:2614`) | Yes, toast |
  | Web multi-select (`Sidebar.tsx:2170`) | Yes, one toast for the batch |
  | Chat header menu (`ChatHeader.tsx:247` → `useThreadActionMenu.ts:276`) | Yes, toast |
  | Keybinding `thread.regenerateTitle` (`useThreadLifecycle.tsx:713`) | Yes, toast |
  | Desktop | Same as web |
  | Mobile list menus (`HomeRouteScreen.tsx:358`, `ThreadNavigationSidebar.tsx:629`) | Failure alert only; "unchanged" is silent, as upstream does |
  | MCP `regenerate_title` | No wait; readable later in the thread detail |
- **2(c), upstream's `waitsForInput`.** Upstream's field only chooses the push phase (waiting for input or for approval), and GOAT's `SubagentRequestAwareness.phase` already does that (`agentAwareness.ts:33`, `:66`), so nothing is lost. Neither version tells the coordinating agent. GOAT's MCP lists already count waiting cards (`threadListView.ts:104-123`), and an agent has no runtime request it could answer for a secret card; I did not run the respond tool against that id.
- **3(b), cost.** The server holds up to 8 MiB or 5,000 lines per terminal (`BoundedTerminalHistory.ts:7`, `Manager.ts:150`). The `Math.min` at `Manager.ts:2190` bounds only the history a new session inherits. Measured per call on this busy Mac: 2.79 ms at 8 MiB of ASCII, 1.73 ms at about 8 MB of CJK, and 0.06 ms at 512 KiB. A reconnect of one client with ten terminals makes ten attach snapshots, plus one resync snapshot for any stream that passes its output budget, so about 28 ms in the worst case, spread over ten slices. In exchange each snapshot sends up to about 7.5 MiB less over the wire. Keep it; the author's encode-skip guard is a cheap optional extra.
- **3(c), identity.** Nothing is keyed on `maxHistoryBytes`: the client adds it inside the subscribe effect (`state/terminal.ts:69-78`), and the server's viewers are keyed on the session (`Manager.ts:2752`). An older server's non-strict struct ignores the field. I did not re-read the T1c lease pins (`terminalLeaseOrder.ts`); that part rests on the author's answer.
- **3(d), who gets less.** No client keeps more than 512 KiB: both reducers use the default (`terminalSession.ts:161-164`, `state/terminal.ts:63` and `:84`). `terminalObserve` and agent reads pass no bound and get the full history.

## Rule 3

Every changed existing line matches upstream's own hunk and the quote in the record, so there is no unmatched line.
- `mediaSource.test.ts:136` gains `hostOnly: true`.
- `markdownImages.test.ts` gains upstream's one added line.
- `ShellStream.test.ts` changes the `stored` helper and the idle literal; the new assertions are in a new case.
- `threadCommands.test.ts` changes the harness the way upstream did; only an import differs in shape.
- Mobile `useThreadListActions.test.ts` changes the mock return and one `mutationCases` row.
- `terminalSession.test.ts` changes the import and adds the BOM-case assertions.
- `runtime.test.ts` changes its five expectations and adds an import and the `sent` constant, plus the `executeAtomQuery` move that the lane coordinator ruled in under IV (vi).
- `ThreadTitleRegenerationService.test.ts`, `threadShell.test.ts`, `orchestratorMcp.test.ts`, `assets.test.ts` and `markdownMedia.test.ts` only add new cases.

## Merge state

- **Integration branch:** the head against `259883c788` is a fast-forward.
- **K5 at `18c6644ea8`:** merges clean.
- **K10 at `4fa174d23c`:** conflicts in two files.
  - `010_fork_delta.md`: both sides add a section at the same spot; keep both.
  - `code-budgets.json`: both sides changed `ChatMarkdown.tsx` (K7 1675, K10 1662; the merged file is 1658 lines by `wc -l`) and `orchestrationV2.ts` (K7 4421, K10 4399; merged 4382). The same conflict hunk also carries K7's `orchestratorMcp.ts` 1073, which K10 left at 1083, so the resolution keeps 1073.
- **K10 auto-merges:** `ChatMarkdown.tsx` and `orchestrationV2.ts` merge correctly. The two sides' hunks do not overlap, the merged file compared with K10 shows exactly K7's hunks, and there are no conflict markers.

## The author's claims

- **Confirmed:**
  - goat-ci quick run 44200102994 on the exact head completed SUCCESS: goat-check, goat-typecheck and goat-ci-result all passed.
  - The row 7 counts I re-ran match: shared 29, `threadShell` 15, and the server files I ran.
  - `environmentConnectionAtom` and `waitsForInput` did not ship.
  - The new modules of my rows exist as listed. READY's "not in section 3" list leaves out `apps/web/.../chatMarkdownLinkHref.ts`, which is a nit.
- **Resting on the report:** `check:changed` (42 packages, 478 files, 9,646 tests), the 10 web files with 43 tests, the agent surface audit and the context budget.

NOT RUN: `check:changed` and repo-wide checks; the 10 web browser test files; the agent surface audit and context budget; any real-client pass (web toasts, mobile alert, row 6 images, row 7 marks); mobile native; an older GOAT binary; a slow-link attach; reproducing a real provider CLI failure message; the MCP respond tool against a secret card id; re-reading `terminalLeaseOrder.ts` and `finalizeAbsoluteMediaFileAsset`; the "conn" half (rows 1 to 5).
