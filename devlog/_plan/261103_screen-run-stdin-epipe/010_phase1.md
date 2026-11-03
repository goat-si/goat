# 010 — Phase 1 (screen-run-stdin-epipe)

## MODIFY / NEW / DELETE map

### MODIFY apps/server/src/screenCode/ScreenRunSupervisor.ts (spawnSession, ~:189-194)

Before:
```ts
    const onProcessEnd = () => {
      session.abortActive?.("runtime_unavailable");
      close(session);
    };
    child.once("exit", onProcessEnd);
    child.once("error", onProcessEnd);
```
After:
```ts
    const onProcessEnd = () => {
      session.abortActive?.("runtime_unavailable");
      close(session);
    };
    child.once("exit", onProcessEnd);
    child.once("error", onProcessEnd);
    // A live child that closed its stdin fails the next write with EPIPE; unheard, it ends the server.
    child.stdin.on("error", onProcessEnd);
```

Why this is sufficient: all three writes (:201 boot, :381 reply, :512 cell) go through the same
`child.stdin` Socket, so one listener catches each. `on` (not `once`) because a later write
after destroy must not find the stream listener-less; onProcessEnd is idempotent (close() returns on
`session.closed`, failRun returns on `settled`, abortActive is cleared in cleanup). Existing
failRun semantics give runtime_unavailable, or unknown_outcome when an effect may have started, and
`startupFailed` when the EPIPE hits before ready. close() then SIGKILLs the captured child, deletes
the thread's session and marks it lost, so the next cell is told its values are gone. close()'s
`stdin.end()` on an errored stream is silent (probe).

## TESTS

### MODIFY apps/server/src/screenCode/ScreenRunSupervisor.startup.test.ts — one new it.live

Title: "a child that closes its stdin ends its session instead of the server".

Fake child (node -e, spawned in the test and injected with
`vi.spyOn(NodeChildProcess, "spawn").mockReturnValueOnce(child)`, as the existing tests do):
reads the boot frame synchronously from fd 0 (fs.readSync loop until "\n"), then
`fs.closeSync(0)`, writes `{"t":"ready"}\n` to stdout and stays alive (setInterval). On ready the
supervisor writes the cell frame into a pipe with no reader -> EPIPE.

Assertions: runCell fails (Effect.result) with code "runtime_unavailable", effectStarted false,
startupFailed absent/false (it was ready); `supervisor.consumeLost("thread")` is true;
`supervisor.activeCount()` is 0. Use the default deadline scheduling (no childDeadlineOnly) so that
on dev, besides vitest's unhandled EPIPE error, the cell ends by its wall-limit backstop and the
assertion reports wall_limit instead of hanging. The green path awaits only child output and the
supervisor's own events: no sleeps, polling, per-test timeouts, or wall-clock deltas.

## Verification (C)

1. Fail-first: with only the test applied (fix stashed), `vp test run apps/server/src/screenCode/ScreenRunSupervisor.startup.test.ts`
   from repo root -> non-zero, EPIPE unhandled error and/or wall_limit assertion. Capture tail.
2. With fix: same command -> exit 0.
3. `vp test run apps/server/src/screenCode/ScreenRunSupervisor.test.ts apps/server/src/screenCode/ScreenRunSupervisor.startup.test.ts apps/server/src/screenCode/ScreenRunSupervisor.deadline.test.ts` -> exit 0.
4. `vp run check:changed` -> exit 0 (after host.status placement not critical).
5. PR -> goat-ci-result SUCCESS exact head -> fresh review PASS -> `node scripts/merge-pr.ts <pr>`.

## Audit fold (A, terra NEAR-PASS)

- F1 folded: fail-first proof REQUIRES the unhandled stdin `Error: write EPIPE` (syscall write) in the dev
  run output; a bare wall_limit does not count. Green run requires runtime_unavailable + consumeLost true +
  activeCount 0 and no unhandled errors.
- F2 folded: test sets `screenRunLimits({ cellWallMs: 2000 })` explicitly (backstop 4s on dev), registers
  `Effect.addFinalizer(supervisor.dispose)` and kills its own captured fixture child in a finalizer; the
  fixture is run for real on darwin here before acceptance.
- F4: prewarm may spawn a real spare after the one-shot mock; dispose() in the finalizer closes it.
  activeCount() excludes the spare, so the assertion stays valid.
