BLOCK 2a94ed4deb589b8e4f02b0da7e776be9f3e0588f

This verdict covers Part B only. The code holds up: every row behaves as ruled, all move-outs are verbatim, Rule 3 is clean, the budgets match the files, and every test I ran passes. The block is for one unmet ruling condition. The lane never touches the fork delta, which three rulings told it to update. A docs-only commit clears it.

Head checked with `git ls-remote` at the start and again at the end (16:43 UTC): `2a94ed4deb589b8e4f02b0da7e776be9f3e0588f` both times. Everything ran in `/tmp/n14b-review-2a94ed4d`, which I left in place. `tree/` is a `git archive` of the head. Its node_modules were APFS-cloned from `chase-t3-261114-next2-n-8691c05d0b29374e`. No worktree had the lane's own lockfile (34dad940), so I used one with the integration head's lockfile (6d068a29). The two differ only by morphicons' three entries and three peer-hash suffixes. One missing symlink (`packages/client-runtime/node_modules/unbash`) was added in the scratch tree only. Files I swapped temporarily in the scratch tree were restored byte-identical (checked with cmp), and my probe test was moved out to `notes/`. `git fetch` updated only the integration branch's remote-tracking ref, and `merge-tree` wrote tree objects. Nothing else outside the scratch folder changed.

## Findings

**P2-1. The lane never adds the fork delta lines that three rulings required.**
- **Where:** `devlog/_chase/010_fork_delta.md` is untouched (`git diff e04442e66c 2a94ed4deb -- devlog` is empty). The differences it should name are at `apps/web/src/components/LegacySidebar.tsx:3502` and `:3631`, `apps/web/src/components/chat/composerReplyTarget.ts:11`, and the `subagents.environmentId` field in `packages/contracts/src/composerContext.ts`.
- **Trigger:** the next upstream chase of Sidebar, ChatView or composerContext.
- **Consequence:** three things the rulings ask the fork delta to name are missing from it:
  - 13:57:07 (L365, my row 6): "the fork delta names the remaining difference (the legacy jump label map still redraws once when the terminal opens)".
  - 13:15:52 (b)(5), L18: "the fork delta line describes the registry".
  - 12:57:11 (ii), L18: keep `subagents.environmentId`, never set by GOAT; "the fork delta says so".

  The next upstream port could undo these silently.
- **Smallest fix:** one docs commit adding those three lines. The two L18 lines overlap Part A.
- **Basis:** READ, plus the git diff above, RAN.

**P3-1. The record is missing the sentence the 13:57:07 ruling asked for: that default bindings are unaffected, with path:line.** I checked and the statement is true:
- The `previewFocus` defaults (`packages/shared/src/keybindings.ts:173-178`) and `chat.find` (`:249`) use keys the legacy handler ignores.
- The legacy handler acts only on `thread.previous`/`thread.next` (`:261-262`) and jumps (`:266-270`, `!modelPickerOpen && isDesktop`).
- The explicit `isWeb` and `isDesktop` equal the defaults that `resolveContext` already fills in (`apps/web/src/keybindings.ts:70-71`).

Both sidebars now use `threadShortcutContext` (`sidebar/threadJumpHints.ts:17`), so they agree. Fix: add that sentence to the record. Basis: READ.

**P3-2. The two toast chevrons now draw thinner, and their `strokeWidth` props do nothing.**
- **Where:** `apps/web/src/components/ui/toast.tsx:197-206` and `:290-300`.
- **What changed:** morphicons honoured `strokeWidth={2.25}`. Solar icons ignore it (`solar/index.tsx:38-40`) and draw at 1.75. These are the only sites whose weight changed; every other MorphIcon already drew at the wrapper's 1.75. The blank lines left inside the JSX props are leftover clutter.
- **Fix:** drop the four props and the blank lines, and note the weight change. The chevrons now match the toast's existing `XIcon` (`:695`, `:790`).
- **Basis:** READ of `morphicons/dist/react.js:139-151`.

**P3-3. ChatMarkdown checks every link's position on every render.** At `ChatMarkdown.tsx:981-984`, two string slices and a regex run for every link, though only citations and context references use the result. Upstream c0f85e7f79 does the same, so this is optional: move the computation into those two branches. Basis: READ.

**P3-4. The two Activity rows' Reset buttons keep English accessible names.** `ActivitySettingsRows.tsx:45` and `:103` feed `settingsLayout.tsx:537`, which builds "Reset … to default". Every other settings row works the same way, and the button only shows when a value differs from its default. Optional. Basis: READ.

**P3-5. Two small nits.**
- `lib/assistantCitationNavigation.ts:115` still says "Called by the routed thread view", but since d23fa3223a the reveal mounts from `routes/_chat.tsx:29`.
- `device/DeviceSetup.tsx:3` imports `CheckIcon` twice.

## What checks out

**Row 1, O1 quote card.**
- The card is a `Link` with name "Go to quoted response: …" and a `focus-visible` outline; the comment sits outside the link, so a screen reader reads it as text.
- `data-thread-find-ignore` hides the card from find; `threadFindText` returns the comment.
- The composer prop is gone, and the only chip left is in `ComposerPromptEditorTiptap.tsx:505`.
- A missing source only affects where the link lands. A long quote is clamped (`line-clamp-2`). Each card subscribes to a single quiet shell, with no observers.
- No O1 change in `apps/mobile`. `docs/user/composer.md` matches.
- ChatMarkdown matches upstream.
- Basis: READ. Tests RAN: `AssistantCitationChip` 4/4, `threadFindText` passes.

**Row 2, L357 fold.**
- `useTallEnoughToFold` is upstream's code apart from the disable rule's name.
- The ref sits on the inner, unclipped div (`TimelineUserMessageRow.tsx:914`), so folding cannot change what it measures. No loop.
- It unsubscribes on unmount through `observeResize`. The effect has a stated reason, so it needs no budget entry.
- Images loading late can fold a message once, as upstream.
- The test uses `vi.waitFor` with no frame waits. The two-cards / ten-cards case and the ×200 / 60-sentence pair follow the 14:19:09 ruling.
- Basis: READ. RAN: 3/3.

**Row 4, L373 folder drop.**
- I read both versions of `DesktopAppActivationCoordinator`. They differ only through `resolveLocalFolderTarget`: `local-off` and `not-this-machine` were unreachable on base for the desktop primary (13:48:28).
- The 2-case entry-point test passes with the head file and with the base file (RAN, 2/2 each).
- A plain browser returns `browser` before any path is read.
- Each of the four non-ready states has its own toast. Dropped files get the "Only folders" toast, several folders are added one by one, and a folder already a project opens it.
- The overlay is static, and repeated `setIsActive(true)` calls bail out without re-rendering.
- `Sidebar.tsx` and `LegacySidebar.tsx` are untouched by 8a1fbbff4d.
- RAN: `localFolderTarget` 5/5.

**Row 5, L376 side-chat reveal.** `ThreadRouteView.tsx` and its browser test equal e04442e66c (`git diff --quiet`). The test passes 9/9 (RAN). In `_chat.tsx`, `shownTarget` and `modalOpen` are exactly what `ThreadRouteView` receives (`:33`, READ).

**Row 6, L365 render isolation.**
- `Sidebar.renderIsolation` passed 5 of 5 completed runs (RAN, one process at a time). A sixth, earlier attempt never ran its test because Vite re-optimized dependencies.
- With c18c4f86cd^'s seven files swapped in, it fails: "expected 25 to be +0" (RAN).
- The baseline waits with `vi.waitFor` until the catalog is ready and network status is known, then flushes once with `act`. No sleep, tolerance or retry.
- The hook test's tail equals upstream's apart from the `@goat` import names (`diff`, RAN). `Sidebar.logic` 5/5 and `LegacySidebar.shortcuts` 1/1 (RAN).

**Row 7, translations.**
- All 9 locales have the same 83 keys, and no new value equals the English (RAN).
- A scratch probe rendered both rows in Korean. Titles, descriptions, the switch and combobox names, and the selected level were all Korean, and no English remained. The three status words came back as 승인 필요 / 입력 필요 / 작업 중 (RAN, probe removed).
- The window title is written only when it changes (`documentTitle.ts:76`), and `subscribeI18n` fires on a language switch. The desktop window takes the renderer's title (`DesktopWindow.ts:719-725`, READ).
- No setting or contract changed. `settingsSearch` 63/63 and `I18nProvider` 2/2 (RAN).

**Row 8, O28 icon swap.**
- I checked all 40 `<MorphIcon>` elements in 34 files on base. The record says 34 sites in 33 files, which undercounts, but every element was swapped.
- Each glyph maps to the same Solar glyph as before (alias → component table, RAN). The three-state and four-state sites map correctly.
- Class names, `aria-hidden`, size and the `aria-pressed`/`aria-expanded` attributes are unchanged. No CSS or motion was added.
- No `MorphIcon` or `morphicons` is left. Nothing references `ticket`. A second run of the generator leaves the tree clean (RAN, cmp).
- 17 component test files, unchanged against e04442e66c, pass with 243 tests (RAN).

**Row 9, L18 and (a) visible parts.**
- Reply is a `Button` with `size`/`variant`, no `className`, labelled "Reply to this response".
- The banner's cancel is "Cancel reply", and `replyToResponse` calls `focusComposer()` (`ChatComposer.tsx:3026`).
- The inbox form adds no UI component and no restyle.
- RAN: `ComposerBannerStack` 4/4, `composerReplyTarget` 3/3, `DecisionUserInputForm.sideChat` 1/1, `useDecisionInbox.unsent` 1/1.

**Whole lane: move-outs.** I script-diffed all 19 move-out commits. Only these lines are removed without being added back:

| Commit | Lines not added back | Why |
| --- | --- | --- |
| 9c382f510d | `Button`, `ARTIFACT_TEMPLATE_ICON_BY_KIND` imports | No uses left in ChatMarkdown |
| 5a81919cbb, f6fc2f3953 | Imports | Repointed to the new module |
| a8b477d2f4 | `EnvironmentId`, `serializeAssistantCitation` | The two unused imports allowed at 12:59:47 |
| cb87ceb8f1 | `normalizeModelSlug`, `UnifiedSettings` | 0 uses left; `ProviderOptionSelectionsByProvider` becomes an export |
| 5813cb40c7 | `CommandId`, `environmentThreadDetails` | 0 uses left |
| dd8fbe93f1 | Three SSH type imports | 0 uses left; the toast is now built lazily, as accepted 13:15:52; bodies identical |
| b37a88bf59 | Three icons, `ActivityShimmerOverlay` | 0 uses left |
| 2396a5a4b3 | `parseSideChatCommand` import | Now re-exported; the call site maps keys to `DraftId` |
| 23789a0612 | `ScreenReaderAnnouncements` | 0 uses left |
| c14d9778de | `FILE_LINK_REVEAL_ATTRIBUTE` | 0 uses left |
| 3c27a1759a, 73fcec4842, 864dabcfb7, fc57930f00, dfe99ad44c, 98eaec2742 | none | Only `export` added to the moved declaration |
| 38a54d1aec | none | Nothing removed beyond the move |

I counted each dropped name in the file afterwards (READ and RAN).

**Whole lane: Rule 3.** Every changed expectation in a pre-existing test file matches an authorised line:
- 12:59:47 (1) `threadFindText`, (2) `MessagesTimeline.logic`, (3) `AssistantCitationChip`.
- 12:57:11 (iii) `composerContext`: one row, plus new cases.
- 13:21:07 `stashFailedSend`.
- 13:57:07 `Sidebar.logic.browser`.
- Import lines only: five files.
- Additions only: five files.

Nothing is unmatched (whitespace-insensitive diff, RAN).

**Whole lane: budgets.**
- All 20 changed entries equal the real line counts. None was raised, and the `nonNull` counts match.
- The largest new file is 184 lines, and nothing is over 1000. No new non-null assertions or `any` casts outside tests.
- On the effect budget, only `shortcutModifierState` changed (1 → 0, entry removed). The two new effects state their reasons.
- No restyled ui exports and no repainting animation in added code.
- `apps/web` `tsc --noEmit` exits 0 with 21 suggestions and no errors (RAN).

## Merge state

**Against 3a254fa1a5:** only `oxlint-plugin-goat/code-budgets.json` conflicts, in one hunk. No budget entry is changed by both sides, so every value comes straight from one side:

| Entry | Merged value | From |
| --- | --- | --- |
| `GitActionsControl.tsx` | `{"lines":1375}` | integration |
| `LegacySidebar.tsx` | `{"lines":3883,"nonNull":2}` | lane |
| `ThreadComposer.tsx` | `1126` | integration |
| `PublishRepositoryDialog.tsx` | `{"nonNull":1}` | integration |

Every entry equals the merged tree's real count (RAN on tree 2117c4cc35). The lane does not touch `GitActionsControl.tsx` or `PublishRepositoryDialog.tsx`, and neither held a MorphIcon. The merged tree has none. Its only `solar/nodes` imports (`Box`, `iconSvgMarkup`, `CONTEXT_MENU_ICONS`) still exist, so by reading the lane's removals break no integration code.

**Integration moved during the review.** The integration branch moved during review to d12958d037 (SF1 and dev merged in). Against it there are now two conflicts. `useComposerSend.ts` has one import hunk: the lane drops the `DraftSshDestination` import and SF1 drops the `UnifiedSettings` import. Dropping both lines should resolve it (INFERRED). `code-budgets.json` has three hunks. I did not resolve these further.

**CI run 44118636205** at 16:43 UTC: in progress, with only `goat-test-server 2/4` left. Every finished job is green, including `goat-test`, `goat-test-changed`, `goat-build`, `goat-check`, `goat-typecheck`, `goat-test-desktop` and server shards 4/4. Nothing has failed.

## The author's claims

**Confirmed by my runs:**
- "goat <dir>" 2/2 on base and head.
- Render isolation 0 at the head, 25 before the port.
- The ThreadRouteView test file is unchanged and passes.
- The translations, all nine locales.
- The generator runs clean.
- The budgets and the Rule 3 list.
- The O28 component tests pass unchanged.

**Resting on the author's report:**
- The 27 captures (not opened).
- The fail-first order of 147026a1d9, c967da6f92, f1d4685826, 89a9eacd0e and 70ff936299.
- The count of 209 O28 tests.
- `vp i --frozen-lockfile`.

NOT RUN: desktop build, mobile, a real-client pass, local lint/knip/format/check:changed, Part A's server and contract tests, `vp i --frozen-lockfile`, fail-first runs other than L365's, and resolving or building either merge.

BLOCK 2a94ed4deb589b8e4f02b0da7e776be9f3e0588f
