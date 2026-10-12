# Rules for `structure/`

This file applies to `structure/` and inherits the repository-wide rules in [`AGENTS.md`](../AGENTS.md).
[`INDEX.md`](INDEX.md) is the reading order and the source-to-doc map. It is derived from
[`manifest.json`](manifest.json). Edit the manifest, then regenerate the index so the two describe
the same docs in the same order. Do not treat the index as the file you edit to record a fact.

This repository does not ship `structure:index` or `structure:check`. Adding that runner would be
source, and this folder was introduced as documentation only. The checks below are what that gate
would prove. Run them before you finish a change. If a later change adds the scripts, rewrite this
paragraph and the index header to name them, and delete the hand-maintained wording.

## What belongs here

A doc in this folder states **the contract that holds right now**, in the present tense, for one
subsystem. That is the whole job.

- Public user workflows belong in `docs/user/`.
- Constraints that span components, and traps that are hard to rediscover from the source, stay in
  `docs/internals/`. Link that page instead of pasting it.
- Open work, triage, and investigation belong in `devlog/`.
- Superseded or alternative reasoning belongs in `decisions/`, not in the doc body.

If you cannot write a sentence in the present tense about how the system behaves today, it is not a
structure doc.

## Layout rules

- File names are kebab-case, start with a letter, and sit at most one directory deep:
  `decisions/ADR-0002-orchestration.md` is the decisions folder, not a second nesting level for
  subsystem docs. `server/orchestration/commit.md` is too deep, and `04-server.md` is rejected.
- **Ordering lives in `manifest.json`, never in a filename.** Leading digits are rejected outright.
- A doc stays under `sizeBudgetLines` in `manifest.json`. Over budget, split it along a topic
  boundary and give each half its own manifest entry. A `grace.oversizeDocs` entry is for a split
  already planned.
- The budget is a line count. It bounds a runaway file. It does not bound how much prose you pack
  onto one line.

## The source-to-doc map

Each doc lists the source areas it describes, in its `documents` array. [`INDEX.md`](INDEX.md)
publishes the inverse.

- **An area can be described by more than one doc.** These docs are organised by topic. `apps/` and
  `packages/` are organised by package. Changing an area obliges the same change to review every
  doc listed for it. Update a doc when its explanation changed. A reviewed doc whose sentences are
  still true does not need copied prose.
- Describing an area means naming a path inside it, in backticks. A `documents` entry that the doc
  never names is a broken claim.
- A new top-level app or package either joins a doc's `documents` list or is recorded in
  `grace.undocumentedSourceAreas` with a reason.

The map cannot tell you that two docs describe the same behavior in contradictory words. Prefer one
statement and a link over two statements that will drift apart.

Cross-cutting authority is the optional `contracts` object in [`manifest.json`](manifest.json).
Each entry has a stable kebab-case `id`, one `owner` with a manifest document and heading anchor,
and a `dependents` array. Every dependent links the exact owner anchor. The owner is not a
dependent of itself. The registry supplements the source map. It does not narrow which documents a
source change must review.

## Decision records

`decisions/ADR-NNNN-<slug>.md` holds the reasoning: intent, prior constraints, alternatives, the
choice, why, and consequences.

- One record has exactly one owning doc, which links it with a `> Decision record:` line.
- Numbers are permanent and unique. They are not required to be contiguous.
- Records are historical. When the contract changes, edit the doc body and add a new record. Do not
  rewrite an old record to match today's tree. A record may name paths that no longer exist.
- A record's title names the doc section it was recorded under: `decision recorded under "<section>"`.
  Read the body for the choice.
- Ownership is the `> Decision record:` line and nothing else. Mentioning the path in prose does
  not make a second doc the owner.

Only record a decision you can point at in `git log`. Quote the commit hash. If the message does
not record a rejected alternative, say that. Do not invent one.

## Invariants

[`overview.md`](overview.md) is the invariant index. Each entry needs a stable `INV-<AREA>-NN` id.
A bound entry adds an `Enforced by` line naming exactly one `*.test.ts` path, and that id is
repeated in a comment inside the test.

Binding proves the test file exists and claims the id. It does not prove the assertions still cover
the rule. An invariant with no honest annotated test is listed **without** an `Enforced by` line
and with an entry in `grace.unboundInvariants`. Annotating a test is a source change. Do not add
the comment merely to make the binding look closed.

## Adding or changing a doc

1. Write or move the file. Keep every claim tied to a backtick path that exists in this checkout,
   or to a commit hash for a decision record.
2. Add or update its `manifest.json` entry: `path`, `tier`, `title`, `scope`, `documents`.
3. Update contract owners, dependents, and `grace` when the topology changes.
4. Regenerate [`INDEX.md`](INDEX.md) from the manifest using the layout below.
5. Run the checks in the next section.

## What to verify

Until a script exists, check all of the following against the git index, not against untracked
files:

- Every doc on disk except this file, [`INDEX.md`](INDEX.md), and `decisions/` is in the manifest
  once, and every manifest doc exists.
- File names are kebab-case, letter-initial, and at most one directory deep.
- No doc exceeds `sizeBudgetLines`, and no grace entry outlives the condition it names.
- Every relative link resolves, including its `#anchor`.
- Every `documents` path is named in that doc.
- Every backticked token whose first segment is a top-level file or directory in this repository
  is a real path. Runtime files that live only in a home directory (`settings.json`,
  `statev2.sqlite`) are not repository paths and are not checked.
- No doc body carries a `> Decision record:` line that points outside `decisions/`.
- Every decision record is linked from exactly one doc, and no number is reused.
- Every bound invariant names an existing test that names the id back, and every unbound one is
  recorded with a reason.
- Every `apps/*` and `packages/*` directory is described by a doc or listed in
  `grace.undocumentedSourceAreas`.
- Contract ids are unique, owner and dependent documents exist, owner anchors exist, and every
  dependent links its declared authority.
- [`overview.md`](overview.md) exists.
- [`INDEX.md`](INDEX.md) matches the layout below.

## Index layout

The index has two sections, in this order.

1. **Reading order.** For each tier in manifest order, a heading `### Tier <id> — <name>`, the
   tier's `purpose` as a paragraph, then a table of that tier's docs in manifest order. Columns are
   `Doc` and `Scope`. The doc cell links the manifest `path`. The scope cell is the manifest
   `scope`.
2. **Which doc describes which source.** One row per distinct `documents` path, sorted by path.
   The second cell lists every doc that names it, in manifest order, separated by `<br>`.

The header states that the file is derived from `manifest.json`, points here for the rules, and
says there is no generator script.
