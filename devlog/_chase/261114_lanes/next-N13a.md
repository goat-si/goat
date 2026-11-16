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

## Review of `6216af3736` (APPROVE WITH NITS)

A fresh C4 review found no P0 or P1, and three P2s, none a code defect. The coordinator ruled on each; the head stays `6216af373677f0f6f7b85560335fd4c7e64d37f4`.

### O18 (`bc3eb6d2b2`): where the 34.8 MB lands (N13A-P2-2)

The 34,818,280 bytes of CJK faces ship in every copy of the web client, not only the web build (reviewer's figures, from `gh release view` on v0.1.10-nightly.20261115.371 and the staging code; compression ratio inferred, the OTF faces barely compress):

- CLI archives stage the whole client (scripts/build-cli-archive.ts:592, :634): each grows by about 33-35 MB, from 120-169 MB today.
- Desktop installers bundle three SSH runtime archives plus the app's own copy, and the WSL runtime on Windows (scripts/build-desktop-artifact.ts:3080, .github/workflows/goat-nightly.yml:599, :832-834): each installer (700-840 MB today) grows by about 140-175 MB.
- Every SSH runtime install uploads about 35 MB more.
- The 256 MiB SSH runtime cap (scripts/build-desktop-artifact.ts:3360) still holds: linux-x64 goes from about 161 MiB to about 194 MiB.

The decision is the owner's; the coordinator asked him. Until he answers, `bc3eb6d2b2` stays as ported. If he prefers to hold the fonts, the lane takes `5b1181c6a1` out in a follow-up commit when the coordinator says so.

### WORD_LIMITS before and after (`787c59c802`, P3-1)

Checked against officeArchive.ts on `02511156b0` and on the head (officeArchive.ts:10).

| limit                                 | before                                   | after                     |
| ------------------------------------- | ---------------------------------------- | ------------------------- |
| body bytes kept                       | 3 MiB                                    | 4 MiB                     |
| body elements                         | 5,000                                    | 50,000                    |
| body tags                             | 100,000                                  | 1,000,000                 |
| tags per element                      | 2,000 (and a 128 KiB window per element) | 100,000                   |
| paragraph text                        | none                                     | 128 KiB                   |
| styles                                | 1,024                                    | 8,192                     |
| style bytes / units                   | 1 MiB / 20,000                           | 16 MiB / 400,000          |
| style visits / property visits        | 8,192 / 100,000                          | 131,072 / 2,000,000       |
| numbering references / bytes / markup | 2,000 / 128 KiB / 2,000                  | 20,000 / 32 MiB / 400,000 |
| auxiliary part bytes / markup         | 1 MiB / 50,000                           | 8 MiB / 1,000,000         |
| expanded bytes / markup               | 3 MiB / 100,000                          | 64 MiB / 4,000,000        |

Upstream's comment puts a 40K-character paragraph at about 2 s and growing with the square, so a paragraph at the 128 KiB limit takes about 20 s in the document worker; each worker call either finishes or ends with a message after 30 s, off the main thread. The preparation bounds are unchanged: 50 MB input (officeArchive.ts:681), 2,048 entries (:689), streamed expansion caps (:729) and the 30 s preparation timer (OpenXmlOfficeViewer.tsx:67).

### More known limits

- Slow links (N13A-P2-1, goat#3513): over a slow link a first CJK preview can end in "This document took too long to preview". The faces (Japanese 4.5 MB, Korean 4.6 MB, Traditional Chinese 5.7 MB, Simplified sans 8.3 MB; up to 20 MB for a document with two Chinese families) must arrive inside the 30-second per-call limit of office/worker-rpc.ts:123 together with the engine's start, and a terminated worker cannot resume the download. Before this lane those documents showed empty boxes. Upstream's own behaviour; thresholds inferred, not measured. Follow-up: https://github.com/goat-si/goat/issues/3513.
- SVG pictures (P3-2, goat#3514): an SVG picture from a Word file (or a WMF/EMF picture the engine turns into SVG) decodes on the main thread through office/vector-pictures.ts:17-41 with no time or input-size bound; output is capped at 2,560 px and nothing external loads. Follow-up: https://github.com/goat-si/goat/issues/3514.
- Font serving (P3-3): the desktop protocol (apps/desktop/src/electron/ElectronProtocol.ts:272) and the server's asar fallback (apps/server/src/http.ts:846) read a whole font file per request; existing behaviour, the files are now larger (up to 11.6 MB).
- Fork map (P3-4): devlog/_chase/010_fork_delta.md gains an `office-archive-split` block for officeArchiveWorkbook.ts, officeArchiveXml.ts and AttachmentFilePreview.spreadsheet.browser.test.tsx.

### Captures for the PR (P3-5)

In /tmp/n13a-captures on pen-macmini until the coordinator sends the PR number. Before images are the harness renders on `02511156b0`; after images are the real-client renders on the lane head. `harness-after-slide-worker-import-error.png` is not an after image.

| preview               | before           | after                  |
| --------------------- | ---------------- | ---------------------- |
| Word (Japanese)       | before-word.png  | after-client-word.png  |
| Excel                 | before-sheet.png | after-client-sheet.png |
| PowerPoint (Japanese) | before-slide.png | after-client-slide.png |

### PowerPoint in the built web app (N13A-P2-3)

Run on the lane head `6216af3736`, pen-macmini, after lane N16's gate had finished (load 2.2). `vp run dev --share --built` (the runner accepts `--built` only with `--share`, scripts/dev-runner.ts:643) built apps/web with `vp build --watch` ("built in 34382ms") and the backend served apps/web/dist from this worktree's own .goat; GOAT's browser panel opened the tailnet URL, paired, and opened decks from a project at /tmp/n13a-fixtures in the Files panel.

- review-en.pptx (python-pptx default Office theme, Calibri Light and Calibri, two slides, a filled shape): both slides render.
- launch-ja.pptx (Yu Gothic and Meiryo runs with Japanese text): the slide renders with Japanese glyphs.
- Network, from opening the decks on: no failed request. Each returned 200: `presentation.worker-0SNkwrL-.js`, `chunk-3TTZUGDD-Bz8jjJxr.js` (pptx 0.5.1's top-level `import()`, which the Vitest harness could not load in a worker), `pptx_wasm_bg-CJHE01bI.wasm`, `Carlito-Regular-BkJcQkis.ttf` and, for the Japanese deck, `NotoSansJP-Regular-Drz8BAUN.otf`.
- Console and page errors after opening the decks: none. Before pairing, the first load got 502s from the tailnet proxy while the backend was still starting ("Unable to preload CSS"; a reload fixed it) and the WebSocket refused the unpaired page; neither involves the previews.
- Captures: `built-web-slide-en.png`, `built-web-slide-ja.png`, and `built-web-sheet-resize.mp4` (11.7 s: a column edge drag in sales-ja.xlsx, then a row edge drag).
- The dev server was stopped through its own session; the tailnet mapping it left for port 7149 was removed with `tailscale serve --https=7149 off`; apps/web/dist was removed.

Desktop NOT RUN: the built renderer loads only in a production run (`isDevelopment` is false when `VITE_DEV_SERVER_URL` is empty), and there `GOAT_DEV_INSECURE_SECRET_STORAGE` does not apply (apps/desktop/src/app/DesktopDevSecretStorage.ts:27-32), so the unsigned app would open the macOS keychain's shared safe-storage item and macOS would prompt for the login password; `vp run dev:desktop` loads the Vite dev renderer instead of the built one, and apps/desktop has no package build script (its `dist-electron/main.cjs` comes from the vite `build` task or the artifact build). The coordinator carries the desktop PowerPoint check before stable promotion.

## Coordinator rulings (2026-11-16)

Quoted verbatim from the coordinator, relayed by the lane coordinator.

### Rule 3 authorisation

Coordinator authorisation, 2026-11-16, rule 3, lane N13a. I read upstream c8e8b58ee6's diff of apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx before answering; both edits are upstream's own and are authorised as upstream wrote them: (1) in "bounds spreadsheet cells at %s before padding", the case list gains "XFD300" and expect(result.truncated).toBe(ref !== "AX500") becomes toBe(ref === "XFD200" || ref === "XFD300"); (2) in "preserves %sworksheet metadata with relationship target %s", expect(columns).toHaveLength(1) and its two min/max checks are replaced by upstream's toEqual of the [min, max, width] spans, with upstream's comment that the engine ignores defaultColWidth. The 787c59c802 (WORD_LIMITS) test edits are covered by the ruling at line 933 of the closed card devlog/_chase/_fin/10/10.025_t3_chase_cycle_261114.md ("upstream's own commit edits these ... all to read its new WORD_LIMITS"); the fresh review of 6216af3736 confirmed each named edit is present and matches upstream. No other expectation in an existing dev test may change in this lane.

### State

- Review at 6216af3736: APPROVE WITH NITS. P2-3 closed by the built-web pptx smoke (PASS, pen-macmini). P2-1 recorded, goat#3513. P3-2 goat#3514. Desktop built-renderer check: carried by the coordinator as a pre-stable check on the first nightly that contains N13a.
- OPEN: the owner's answer on whether O18 covers the installer growth (P2-2). N13a and N13b do not merge before it.
