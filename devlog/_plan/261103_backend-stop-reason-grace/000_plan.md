# 000 — backend-stop-reason-grace: Plan

## Objective

On 2026-10-30 23:45:18 KST the nightly desktop wrote `pid=32846 killed by SIGKILL` to
`~/.goat/desktop-nightly/userdata/logs/server-child.log` (line 258) with no stop reason.
Make every backend stop leave its reason and timeline in server-child.log, make a forced kill
keep the server's last output, and make sure a normal stop has the budget it needs to finish
(SIGTERM, 5 s grace, SIGKILL, 1 s wait) instead of being abandoned at 5 s.

## Loop-spec

- Archetype: verifier-defined (focused tests + check:changed + exact-head CI + independent review).
- Write scope: apps/desktop/src/backend/{DesktopBackendManager,DesktopBackendProcess}.ts (+ tests),
  apps/desktop/src/app/{DesktopApp,DesktopObservability}.ts, apps/desktop/src/updates/DesktopUpdates.ts,
  apps/server/src/serverRuntimeStartup.ts and apps/server/src/cli/server.ts (shutdown timing logs).
- Out of scope: release/nightly triggers, app restarts, live ~/.goat state, pattern kills,
  repo-wide checks, changing the 5 s grace itself.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010_phase1.md | Investigation: stop-path inventory, shutdown measurement, root-cause status (docs only) | — |
| wp2 | 020_phase2.md | Desktop stop reason/outcome records, quit/update stop budget, server shutdown timing; PR→CI→review→merge | wp1 |

## Accept criteria

- c-1 investigation doc with path:line inventory and measured shutdown.
- c-2 desktop records stop reason/SIGTERM time/elapsed/forced-or-external outcome; forced kills persist output; failing-first tests.
- c-3 server logs SIGTERM receipt and shutdown phase durations; over-grace phase fixed if measured.
- c-4 PR merged via scripts/merge-pr.ts after exact-head goat-ci-result SUCCESS + fresh review PASS; origin.report sent.

