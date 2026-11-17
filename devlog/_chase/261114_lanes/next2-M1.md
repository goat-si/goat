# M1 TF1 goat#3655 (lane record)

Lane branch: `fix/metro-ignore-goat-home`, head `6c4074a3e8ab0302c28022d44ab5651ea603fe4d`, cut from `origin/dev` at `6e6fcb2ad1`. Not part of #3660. Host pen-macmini (host.status at 12:3x UTC: 10 cores at 15% CPU, 21.6 GB free, one thread running, this one). Plain push, no force. PR https://github.com/goat-si/goat/pull/3679 (Closes #3655), linked; the lane did not merge.

## Rows and commits

| row | class | GOAT commit | proof |
| --- | --- | --- | --- |
| goat#3655 (Metro watches the worktree's .goat) | C1 | `6c4074a3e8ab0302c28022d44ab5651ea603fe4d` | Metro transcript before and after, run from a copy at a path containing `/.goat/` (below) |

`apps/mobile/metro.config.js`, +2: one blockList entry `${escapedWorkspaceRoot}[/\\]\.(?:goat|codexclaw)[/\\].*` and a one-line comment; the `.t3` line is byte-identical (folding `.t3` into the alternation tripped `goat-rename --check`). Folders: `.goat` (worktree dev home of `vp run dev`, setup markers), `.codexclaw` (codexclaw plugin: sessions, render-observations.jsonl); `.t3` stays. `.generated` (root and apps/mobile), src, node_modules and a nested `apps/mobile/.goat` stay watched. No test: apps/mobile has none for the blockList.

## Proof

This worktree is `/Volumes/CLIsu/goat-worktrees/...` (no `/.goat/`), so Metro ran from an APFS copy-on-write copy of the checkout at `/Volumes/CLIsu/m1-proof/.goat/desktop-nightly/worktrees/goat-m1`. A probe fetched the iOS bundle and registered on `/hot` like the app. Before (origin/dev config): writes to `.goat/userdata/settings.json` and `.codexclaw/state.json` each sent update-start/update/update-done. After (head config): bundle HTTP 200 (46135126 bytes); writes under `.goat`, `.codexclaw`, `.t3` sent nothing; a source edit to `apps/mobile/src/lib/layout.ts` sent update-start and update modified=2. Transcripts in the PR body.

Checks on the head: `vp run check:changed origin/dev` exit 0; `vp test run apps/mobile/src/reactCompilerCoverage.test.ts` (loads metro.config.js) 1356 passed.

NOT RUN: an on-device iOS or Android pass; a Windows run of the separator form.

## Cleanup (12:51:49 UTC, fresh commands)

Metro PIDs 20228, 21529, 26810 stopped by captured PID; port 8197 has no listener. `/Volumes/CLIsu/m1-proof` (the proof copy) and `/tmp/m1-proof` do not exist; this thread's TMPDIR has no metro-cache or metro-file-map entries. Nothing more pushed to the PR branch.

## Coordinator answers (verbatim)

> Coordinator to lane coordinator, 2026-11-17 12:50:34 UTC (date -u; quote in M1's record).
> 1. M1, #3679 at 6c4074a3e8: READ BY ME (gh pr diff: apps/mobile/metro.config.js only, +2: the comment and one blockList entry anchored to the workspace root with the [/\\] form for .goat and .codexclaw; the .t3 line untouched). The proof from a copy whose path contains /.goat/ is ACCEPTED: it tests the anchoring, which was the point; the record says it was a copy. The screenshot gate PASSED on its own (goat-screenshot-gate SUCCESS at 12:5x), so no waiver label. Linked and watched here; I merge on goat-ci-result SUCCESS at that head, no review task (C1, two lines). M1 pushes nothing more; it confirms the proof copy and caches are gone and stops. pen-macmini stays free until P1's pass.
