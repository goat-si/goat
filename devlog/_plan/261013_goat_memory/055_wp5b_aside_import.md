# 055 — WP5b (proposed): read-only Aside memory import profile

Status: PROPOSED follow-up to [050](050_wp5_provider_import.md). Not part of the WP5 acceptance
scope; adding Aside widens `MemoryImportFormat` and needs Jun's scope decision before any
implementation lane starts. Nothing here changes Aside memory, `aside-memory-sync`, or Aside's
own files (000 non-goal holds: GOAT only reads them).

## Why Aside, and what is worth importing

Aside keeps a curated, human-readable memory store at `~/.aside/u/<slot>/memory/` that is already
replicated across Jun's machines with Git. Its `TAXONOMY.md` makes semantic and episodic pages the
source of truth and `MEMORY.md`/`USER.md` (L1) a derived briefing. Semantic pages use
frontmatter, a `## Current` section (present understanding) and a `## History` section
(dated observations and sources).

Measured on Jun's store on 2026-10-15 (read-only):

| Part                                                                           | Files |     Bytes | Import?                                                            |
| ------------------------------------------------------------------------------ | ----: | --------: | ------------------------------------------------------------------ |
| Semantic pages (`agent/ concepts/ projects/ sites/ people/ companies/ users/`) |   134 | 2,404,153 | Current only, selected subdirectories                              |
| `routines/<id>/MEMORY.md`                                                      |    28 |   887,326 | No (watermarks and cadence are task state, not memory)             |
| `episodic/YYYY-MM-DD.md`                                                       |    57 | 7,194,839 | No (observations; GOAT keeps its own evidence)                     |
| L1 `MEMORY.md` + `USER.md`                                                     |     2 |    66,383 | No (derived from the pages above; importing both duplicates facts) |
| `.history.jsonl`, `memory-index*.json`, `.local-memory/`, `.git`               |     — |   ~2.2 GB | Never (run logs, per-device indexes and Git internals)             |

The Current sections of agent, concept, project and site pages carry most of the value: user
preferences, tool failures and their fixes, and active project decisions. History and episodic
text is mostly evidence for those statements and is cheaper to keep in Aside than to re-host.

## Profile `aside-semantic-v1`

- **Format and root.** New `MemoryImportFormat` member `aside` with one parser profile
  `aside-semantic-v1`. Root is `~/.aside/u/<slot>/memory` in the destination environment.
  The slot is chosen by the user from the registered source, never inferred from a number; Aside
  slots differ per device for the same account and must be matched on the account `userId`.
- **Readable files.** Regular `.md` files directly under the selected semantic subdirectories.
  No recursion into `routines/`, `episodic/`, dot-directories, symlinks or links followed from
  page text. Read through the existing filesystem reader; do not copy Git objects (the store's
  objects measured 163.6 MiB, above the omo snapshot limit, and are not needed).
- **Item unit.** One item per H3 subsection inside the page's leading `## Current` section, or
  the whole leading Current when it has no H3. Key
  `<relativePath>#current:<NFC normalized H3 path>`. Never key by line number, byte offset,
  ordinal, mtime or commit.
- **Fences and structure.** The parser tracks code fences. Only the first `## Current` before
  the first `## History` is current. A page with no frontmatter or no Current, a second Current
  section, an unexpected H2 between Current and History, or duplicate H3 titles inside Current
  returns a per-file `unsupported_format` reason; it is never merged, guessed or partially
  imported. (Measured: 1 page lacks Current, 10 pages repeat Current/History headings, one page
  repeats Current 51 times with run-completion text inside it.)
- **Frontmatter.** `title` becomes the preview title. `aliases` and `host` are search hints
  only; aliases never become `MemorySourceKey` aliases. No scope, confidence or provider fields
  are invented. Anything other than scalar `title`/`host` and a string-array `aliases` is
  rejected rather than parsed as general YAML.
- **Scope.** `agent/` and `concepts/` default to user scope. `sites/`, `people/`,
  `companies/` and `users/` default to user scope and are opt-in, never part of a default
  bulk selection. `projects/` requires an explicit destination project binding chosen by the
  user; unmapped project pages stay in preview as unmapped. Assertion kind is `inference`, as
  for every import (050 §4.3).
- **Provenance.** `commitOid` is recorded only when the reader verified the bytes against that
  commit; otherwise it is omitted. Commit is never part of identity or fingerprint.
- **One importer.** Import Aside in one environment and let the GOAT hub distribute the result.
  Importing the same Git-replicated store on every device creates per-device source IDs for the
  same text and gains nothing.

## Limits the real store hits

The 050 budgets stay as they are. The Aside corpus exceeds them in known places, so the profile
must report rather than fail silently:

- 23 of 133 leading Current sections exceed the 16 KiB item body limit; H3 splitting leaves 2
  over. Oversized items reject with a size reason and are listed in preview; never truncated.
- One page is 323,208 bytes, above the 256 KiB per-file read limit; it returns a per-file reason.
- 133 whole-page candidates (617 after H3 split) exceed the 128-item preview cap. The preview
  pages by subdirectory selection; the 32-item apply chunk does not solve preview size.
- 56 Current sections exceed the 6,000-character turn-start injection frame. Preview shows
  "stored but too large to inject automatically" separately from "cannot import".

## Forget and lineage

Reuse 050's lineage and suppression unchanged. A parser revision, H3 rename or split-boundary
change keeps old keys and suppression or stops with `unsupported_format`; it never silently
creates new keys that would resurrect a forgotten statement.

## Acceptance (future, NOT RUN)

Synthetic fixtures only, never Jun's store: a page with fenced `## Current` inside code, a
repeated Current, duplicate H3 titles, an oversized subsection, an unmapped project page, L1 and
episodic files present but ignored, and a forgotten item that stays suppressed after an H3 is
renamed. Focused tests run on macmini-cf and PR CI.
