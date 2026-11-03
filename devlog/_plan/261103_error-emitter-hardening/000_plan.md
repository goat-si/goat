# 000 — error-emitter-hardening: Plan

## Objective

The GOAT server must not die because one Node EventEmitter emitted 'error' with no listener.
#2417 (merged 55a3236c86) fixed the reported case (ScreenRunSupervisor child stdin EPIPE). The
parent thread then asked for the whole class: survey every creation site, guard each one when it
is created, add a lint rule so new code cannot regress, and add a last-resort net in the server
that contains only teardown errors. No cost may be added to steady-state paths: guards are one
listener attached once at creation, and the net runs only when an exception is already uncaught.

Evidence base: [001_emitter_survey.md](001_emitter_survey.md) — 90 raw sites with path:line,
10 with no listener (A1 fixed in #2417, 9 open); 2 of the open ones can end the long-running
server (C1 bootstrap readline, A13 node-pty). No process-level uncaughtException handler exists
in apps/server or apps/desktop. Desktop restarts a crashed backend with backoff
(DesktopBackendManager.ts:615 :629 :645) but in-flight turns are lost.

## Loop-spec

- Archetype: verifier-defined. Each implementation phase is one PR: failing-first test where the
  bug is reachable from a test, then fix, focused tests, `vp run check:changed`, PR, exact-head
  `goat-ci-result` SUCCESS, review by the same terra reviewer, `node scripts/merge-pr.ts`.
- Write scope per phase is listed in its decade doc. Out of scope: client-runtime browser/RN
  WebSockets (EventTarget never throws on unheard errors), script text that runs inside other
  programs (Pi extension, device shims), spawnSync/execFileSync, and Effect-managed sites
  (001 §E confirms the Effect wrappers attach listeners) except the one Effect WebSocket gap.
- Tools/credentials: local vp, gh (push, PR, merge via scripts/merge-pr.ts), goat_call
  pull_request.link/watch, origin.report. No release/nightly, no app restart, no live DB writes,
  no pattern kills.
- Coordination: thread 3 (backend stop reason + 5s grace, worktree fix-backend-stop-reason-grace)
  edits apps/desktop/src/backend/DesktopBackendManager*; phases 020 and 040 must re-check its PR
  state before touching server entry or desktop backend files and rebase after it if they overlap.
  Thread 2 (reader admission, worktree perf-reader-admission-wait-priority) edits
  packages/shared/src/nodeSqliteClient.ts, which 030 rows D2/D3 also touch: wp5's D1-D3 edits wait
  for thread 2's PR to merge and rebase onto it.
- Budget: none stated; host limits apply.

## Work-phase map (one phase = one PABCD cycle = one PR)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp2 | 000, 001 (this cycle) | docs-only roadmap, no production code | wp1 |
| wp3 | 010_phase1.md | close the 9 open gaps that live in apps/server (C1, A13, C2, C3, C7, A27, D8 long-lived fast paths) | wp2 |
| wp4 | 020_phase2.md | server last-resort net: contain EPIPE / ECONNRESET / ERR_STREAM_DESTROYED / ws closed-while-connecting, log + count, everything else still exits 1 | wp3 |
| wp5 | 030_phase3.md | `@goat/shared/errorGuards` (guardErrors, guardChild, guarded ws constructor) and migrate every raw site in apps/server + server-runtime packages | wp4 |
| wp6 | 040_phase4.md | desktop main: B23, C8, migrate desktop raw sites | wp5 |
| wp7 | 050_phase5.md | oxlint rule goat/guard-error-emitters, enabled for apps/server, packages, apps/desktop (tests/fixtures exempt), zero backlog | wp6 |

Ordering rationale: wp3 removes the two known server killers first (smallest diff, highest value).
wp4 is the safety net for whatever the survey missed. wp5/wp6 make the guard structural, and wp7
lands last so it starts at zero violations instead of a backlog.

## Accept criteria (goalplan c-5 .. c-10)

- c-5 this roadmap (000, 001, 010-050) audited by terra.
- c-6 wp3 PR merged with failing-first tests for C1 and A13 and focused tests for the rest.
- c-7 wp4 PR merged; subprocess test proves contained codes keep the process alive and a TypeError still exits 1.
- c-8 wp5 PR merged; no raw creation site left in apps/server + server-runtime packages.
- c-9 wp6 PR merged; desktop main gaps fixed and migrated.
- c-10 wp7 PR merged; rule on with an empty backlog; final origin.report (status completed).

## Roadmap audit record

- Round 1 (terra): FAIL — Cursor's unhandledRejection ownership (020), missing sites (030), lint
  override order (050), plus P2/P3. Folded.
- Round 2 (terra): NEAR-PASS — fatal defers to other listeners, rejection-only hold for Cursor,
  process-lifetime install, excludeFiles gaps, type positions, node-pty untraceable by the rule. Folded.
- Each later phase's P re-verifies its doc against the then-current dev before B (stale check).
