# 000 — screen-run-stdin-epipe: Plan

## Objective

A screen-run child that is still alive but has closed its stdin makes the next
`child.stdin.write` in `apps/server/src/screenCode/ScreenRunSupervisor.ts` fail with
EPIPE. The stdin Socket has no 'error' listener (writes at :201 boot, :381 host reply,
:512 cell), so Node raises it as an uncaught exception and the whole GOAT server exits 1.
`child.once("error", onProcessEnd)` at :194 only sees spawn/kill failures, never stdin
stream errors. Reproduced by the parent thread (/tmp/goat-ws-crash-aside/epipe2.cjs, also on
Electron-node 24.22.1) and here on node 26.12.1 (/tmp/epipe-probe.cjs: write -> "UNCAUGHT EPIPE",
bare end() with no data -> silent).

## Loop-spec

- Loop archetype: verifier-defined (failing-first vitest + CI + independent review).
- Write scope: apps/server/src/screenCode/ScreenRunSupervisor.ts and
  apps/server/src/screenCode/ScreenRunSupervisor.startup.test.ts. Nothing else.
- Out of scope (inventory evidence): every other raw node:child_process stdin writer in
  apps/server and packages/shared already listens for stdin errors —
  imessageSender.ts:80, AntigravityClientFiles.ts:257, sshRuntimeAutoUpdate.ts:191,
  driverProcess.ts:27 (covers LinuxHelperHost and ComputerUseLeaseProxyCli children),
  CuaDriverMcp.ts:93, BrowserDriverCapabilityProbe.ts:43, cuaDriverManifest.ts:584. Claude
  Agent SDK ProcessTransport attaches processStdin.on("error"). MemoryImportReaderSupport.ts:114
  only calls end() with no data (probe: no error). Desktop (NativeCaptureFeedback:50,
  StdioMcpClient:138, ComputerUseHelper:156/171) is guarded and outside apps/server.
- Tool/credential scope: local vp test / check:changed; gh push + PR to dev; goat_call
  pull_request.link/watch; scripts/merge-pr.ts. No release, no app restart, no live DB, no pattern kill.
- Budget: none stated; host limits apply.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010_phase1.md | stdin error -> onProcessEnd + failing-first test, PR, CI, review, merge | — |

## Accept criteria

- c-1 new test fails on origin/dev 21c65d8620, passes with the fix.
- c-2 all ScreenRunSupervisor*.test.ts pass; `vp run check:changed` exit 0.
- c-3 PR to dev linked, exact-head goat-ci-result SUCCESS, fresh independent review PASS.
- c-4 merged via scripts/merge-pr.ts; origin.report sent.
