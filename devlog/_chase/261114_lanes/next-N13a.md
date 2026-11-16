# N13a Office previews (lane record)

Lane branch: `chase/t3-261114-n13a-office`, head `6216af373677f0f6f7b85560335fd4c7e64d37f4` (based on dev `02511156b0`, merged with dev `79a5cafe96`). Host pen-macmini (juniui-Macmini.local, macOS 27.0, 10 cores, Node 26.12.1). Rows from #3176 decided 2026-11-16 by the owner (O18-O21, option A) and the coordinator (L323 with the test edits on card 10.025 line 930). Every row is C4 (new dependency or version bump, lockfile, license notices).

## Rows and commits

Upstream order is bc3eb6d2b2, 787c59c802, c8e8b58ee6, 6464729c56, fd033dfec3, 5cff012416; the lane follows the plan's order. `84478e09c1`, which upstream lands between bc3eb6d2b2 and 787c59c802, is already in dev through #3291.

| row        | upstream                 | GOAT commit                                | result                                                                                                                |
| ---------- | ------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| L322 (O18) | `bc3eb6d2b2` fonts-cjk   | `5b1181c6a134e6177618a9ca5bbe3f3016bba40a` | ported; fonts.ts conflict, upstream's file taken whole (GOAT had only replaced `pipe`)                                |
| L324 (O19) | `c8e8b58ee6` xlsx 0.5.1  | `46705eacac9e4ae960a95882122ee4d096227d1c` | ported after two move-outs; source and test changes line for line equal to upstream                                   |
| L331       | `5cff012416` resize      | `5a95e4f434780bb93cb38270daf518aaa7211629` | ported; Spreadsheet.tsx keeps GOAT's `instanceof SupersededError` and adds upstream's pending reset; two `!` narrowed |
| L326 (O20) | `6464729c56` pptx 0.5.1  | `058a6eca48435792cb61e65810716425f55da4b2` | ported clean                                                                                                          |
| L323       | `787c59c802` WORD_LIMITS | `42665041a48671c922858da0f8a9ceaa343759af` | ported; the card's test edits carried line for line; one `!` narrowed                                                 |
| L328 (O21) | `fd033dfec3` docx 0.5.1  | `f1a5b2400289be46be834d8c4bb3f987d2e1cd0c` | ported clean                                                                                                          |

Lane commits that carry no upstream row:

- `bcdf872ad0e6cce7b02e5802f53918be46046fe4` refactor(web): move workbook bounding out of officeArchive.ts, unchanged. officeArchive.ts stood at its 1211-line entry and c8e8b58ee6 grows it to 1376. `boundedWorksheet` and `boundWorkbook` move to apps/web/src/components/files/officeArchiveWorkbook.ts, and `xmlParser`, `officeXmlDecoder`, `officeXml` to officeArchiveXml.ts. Only imports and `export` keywords change (checked by a sorted line diff). This is upstream code, so the next chase applies upstream's spreadsheet hunks of officeArchive.ts to officeArchiveWorkbook.ts; 787c59c802 and fd033dfec3 touch only the Word code that stays.
- `417b0e1a03acf86dc61845b902322b795acec3bd` test(web): move spreadsheet preview tests to their own file, unchanged. AttachmentFilePreview.browser.test.tsx (2649 of 2685) would pass its entry with c8e8b58ee6 and 787c59c802. The five spreadsheet blocks move to AttachmentFilePreview.spreadsheet.browser.test.tsx. Upstream's own split (`fcc25c8bb2`, skipped in #3176) moves every Office test to AttachmentFilePreview.office.browser.test.tsx; that file would pass the 1000-line default here once this lane lands, so only the spreadsheet tests move. No goat-rename rule or TEST_TITLES entry names the old path or the titles; goat-rename --check 0.
- `69779fb79ac114600f5eec7171b4277f042853d7` lowers the two line entries (below).
- `8a8338955a1502ce81d43e551af76b8a8205d44c`, `6216af373677f0f6f7b85560335fd4c7e64d37f4` merge dev `3182a54238` (devlog only) and `79a5cafe96` (mobile only), both clean.

## Dependencies (C4)

- apps/web/package.json, exact pins: `@betteroffice/fonts-cjk` 0.4.0 added; `@betteroffice/xlsx` 0.3.0 → 0.5.1; `@betteroffice/pptx` 0.2.0 → 0.5.1; `@betteroffice/docx` 0.4.3 → 0.5.1. `@betteroffice/fonts` stays 0.4.0.
- pnpm-lock.yaml (+26/-18 over the lane): the fonts-cjk importer, package and snapshot entries; `@betteroffice/fonts` and the docx snapshot now resolve fonts-cjk as fonts' optional peer; xlsx, pptx and docx each change only specifier, resolution and snapshot. No other package changes. `vp i --frozen-lockfile` passed after every row.
- third-party-licenses.config.json: a new `@betteroffice/fonts-cjk` 0.4.0 entry, `Apache-2.0 AND OFL-1.1`, with Adobe's two Source copyrights (upstream's text); the xlsx, pptx and docx entries move to 0.5.1, still Apache-2.0. `node scripts/sync-third-party-license-notices.ts` makes no further change. A web build (`vp build` in apps/web, exit 0) writes third-party-licenses.json with all five @betteroffice entries at these versions, fonts-cjk's notice 14,460 characters.
- Size: fonts-cjk adds five faces to the web build, 34,818,280 bytes (Noto Sans JP 4.5 MB, KR 4.6 MB, SC 8.3 MB, TC 5.7 MB, Noto Serif SC 11.6 MB). They load only when a document needs a CJK face. This is what O18 accepted.
- Older client / older server: none applies. The changes are inside the web bundle (the preview worker protocol gains `view` between the page and its own worker); no server, contract or wire message changes, and a server serves the web bundle it was built with. Negative cases come from upstream's tests: duplicate stylesheet blocks reject the workbook ("duplicate stylesheet blocks"), oversized Word bodies and expanded parts stay bounded by WORD_LIMITS, and spreadsheet cells past the limits are truncated.

## Fail-first

- bc3eb6d2b2 (upstream fonts.browser.test.ts on `02511156b0`): 3 failed of 3, "draws Yu Gothic / MS Gothic / the Japanese fallback with Noto Sans JP": `expected undefined to be 4533028`. After: 3 passed.
- c8e8b58ee6 (tests only): 7 failed, 6 passed: five "preserves %sworksheet metadata with relationship target %s" (`expected 'error' to be 'xlsx'`), two "shows workbook formats and underline %s" (`expected '<styleSheet>…' to contain '<font><u/>'`); fonts.browser.test.ts failed to import (`does not provide an export named 'sheetFace'`). After: 132 passed.
- 5cff012416 (tests only): both files fail to import (`Cannot find module './sheet-viewport'`; the feature's modules are new). After: 38 passed.
- 6464729c56: 1 failed, "lays slide text out with heavy stand-ins and script fallbacks, and draws text no bundled face covers whole": `expected 'slide-0' not to be 'slide-0'`. After: 23 passed.
- 787c59c802 (tests only): officeArchive.test.ts 3 failed, 4 passed ("counts only the text a paragraph lays out", "keeps a document whose table follows a long one", "keeps the list and style definitions of a long document": `expected true to be false`); AttachmentFilePreview.browser.test.tsx fails to import (no `WORD_LIMITS`). After: 118 passed.
- fd033dfec3 (tests only): 2 failed, 7 passed ("keeps the lists of a document with picture bullets, with their text bullets": `expected undefined to be '<w:numbering …'`; "asks the window to rasterize SVG pictures at their drawn size, and draws the bitmaps it returns": `expected OffscreenCanvas{} to be null`); word-document.browser.test.ts fails to import (new module). After: 161 passed.
- Final head: `vp test run src/components/files` in apps/web, 45 files, 447 tests passed.

## Non-null assertions

Upstream adds three `!` the budget forbids; they are narrowed: `offsets[i]!` and `offsets[i - 1]!` in Spreadsheet.tsx `resizeHit` (skip a missing offset) and `paragraphText.at(-1)!` in officeArchive.ts `countText` (return when there is none, the same condition upstream checks). Moved assertions keep their count: 4 go with the workbook code (officeArchive.ts 12 → 8, officeArchiveWorkbook.ts 4) and 2 go with fd033dfec3's move of the layout code (office/document.worker.ts 2 → entry removed, office/word-document.ts 2). The two new entries are hand-written, since update-code-budgets.ts never adds a file; the total stays the same.

## Code budgets

| entry                                                                        | before    | after | real length   |
| ---------------------------------------------------------------------------- | --------- | ----- | ------------- |
| `apps/web/src/components/files/officeArchive.ts` lines / nonNull             | 1211 / 12 | — / 8 | 965 / 8       |
| `apps/web/src/components/files/officeArchiveWorkbook.ts` nonNull             | —         | 4     | 445 lines / 4 |
| `apps/web/src/components/files/office/document.worker.ts` nonNull            | 2         | —     | 51 lines / 0  |
| `apps/web/src/components/files/office/word-document.ts` nonNull              | —         | 2     | 430 lines / 2 |
| `apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx` lines | 2685      | 2357  | 2357          |

New files under the default: AttachmentFilePreview.spreadsheet.browser.test.tsx 382, officeArchiveXml.ts 25, sheet-fonts.ts, sheet-sizing.ts, sheet-viewport.ts, vector-pictures.ts, word-glyphs.ts. update-code-budgets.ts was run only to read lengths; its changes to files outside this lane were reverted.

## Gate

- `8a8338955a` (dev `3182a54238` merged): goat-rename --check 0; `vp run check:changed` with pipefail exit 0: unused patches, format, lint, knip 1/2 and 2/2, agent surface audit, agent context budget, typecheck (42 packages), test (10 files, 2094 tests). Load 2.5 on 10 cores.
- `6216af3736` (dev `79a5cafe96` merged, mobile only): goat-rename --check 0; `check:changed` exit 0 with the same steps. No known issue (goat#3238 and the rest) came up.
- The browser tests of the changed files are not in check:changed's selection here; they ran directly (Fail-first above).

## Surfaces

Captures in /tmp/n13a-captures on pen-macmini, kept outside the worktree until the coordinator gives the PR number. Fixtures are /tmp/n13a-fixtures/{report-ja.docx, sales-ja.xlsx, launch-ja.pptx}, made by make.py there with python-docx, openpyxl and python-pptx.

- Harness renders (a throwaway browser test rendering OpenXmlOfficeViewer, run on `02511156b0` and on the lane head; not committed): `before-word.png` shows every Japanese character as an empty box, `after-word.png` draws them with Noto Sans JP. `before-sheet.png` draws gridlines the workbook hides and no double underline; `after-sheet.png` hides them and underlines "Total". `before-slide.png` renders. On the lane head the slide fails in this harness only (`harness-after-slide-worker-import-error.png`): pptx 0.5.1 starts with a top-level `import()`, and inside a worker run by the Vitest browser runner that call goes through Vitest's `wrapDynamicImport`, which the worker lacks.
- Real client (`vp run dev` in this worktree with its own empty .goat, GOAT's browser panel, Files panel of a project at /tmp/n13a-fixtures): `after-client-slide.png`, `after-client-word.png`, `after-client-sheet.png` all render with Japanese text, no console errors; `after-client-sheet-resized.png` shows column B widened by dragging its header edge (5cff012416). The dev server was stopped afterwards.
- Entry points: Office files open through the Files panel and attachments, which share OpenXmlOfficeViewer. Mobile has no Office renderer in this code. Desktop wraps the same web bundle. No provider, setting, agent tool or contract changes. No user doc describes these previews' fonts or limits.

## Known limits

- The Vitest browser runner cannot run the presentation worker with pptx 0.5.1 (above). No committed test renders a slide through that worker, so nothing fails today; a future test that does will hit it.
- The two move-outs carry upstream code into GOAT modules (officeArchiveWorkbook.ts, officeArchiveXml.ts, AttachmentFilePreview.spreadsheet.browser.test.tsx). The next chase maps upstream's hunks of officeArchive.ts and AttachmentFilePreview(.office).browser.test.tsx onto them. Not recorded in 010_fork_delta.md, which is on dev.

NOT RUN: CI (ci:full), the desktop app, mobile (no Office preview there), Windows and Linux hosts, a build of the desktop artifact.
