# 030 — wp2b: the server can read why the desktop is stopping it

Previous D (wp2): PR #2418 merged 20199d2e7d. stop(reason) exists on the desktop (reasons quit, update-install,
recovery-retry, recovery-stop, instance-closed); the server logs SIGTERM receipt and phase durations but cannot tell a
quit from a restart. Thread 4 (Codex turns survive restarts) needs that distinction; interface agreed in thread messages:
file + pid check + read-then-delete; consumer rule (thread 4): keep turns for relaunch | update-install | recovery-retry.
Base origin/dev 20199d2e7d, branch feat/desktop-stop-intent. Class C3 (desktop+server+contracts, additive optional key).

## A. Contract (packages/contracts)
- NEW src/desktopStopIntent.ts:
  `DesktopStopReason = Schema.Literals(["quit","relaunch","update-install","recovery-retry","recovery-stop","instance-closed"])`;
  `DesktopStopIntent = Schema.Struct({ version: Schema.Literal(1), pid: Schema.Int, reason: DesktopStopReason, requestedAt: Schema.String })`;
  `DESKTOP_STOP_INTENT_FILE = "desktop-stop-intent.json"`. Export from src/index.ts.
- MODIFY src/desktopBootstrap.ts:33 area: `desktopStopIntentPath: Schema.optionalKey(Schema.String)` (absent = no intent channel).

## B. Desktop
- DesktopBackendConfiguration.ts local primary (bootstrap object ~:510-533): `desktopStopIntentPath: join(environment.stateDir, "runtime", DESKTOP_STOP_INTENT_FILE)`.
  WSL config (~:690+) omits it (Linux server cannot read a Windows path; it reports none → today's behavior).
- DesktopBackendManager.ts: BackendStopReason = DesktopStopReason (single source; add "relaunch").
  In stop(), after the locked step marks a NEW stop request on a run with a known pid, and before closeRun, write the intent file
  atomically (mkdir 0700, tmp 0600 + rename) when config.bootstrap.desktopStopIntentPath is set. Bounded stops bound the write
  with Effect.timeoutOption(min(remaining, 1 s)); on failure/timeout write WARN "backend stop intent not written" and continue
  (never block termination). Stop requested before the pid is known: no file (server would not match a pid anyway).
- DesktopState.ts: NEW `stopReason: Ref<"quit" | "relaunch">` (default "quit"). DesktopLifecycle.relaunch (DesktopLifecycle.ts:255-268) sets it to
  "relaunch" before requestDesktopShutdownAndWait. DesktopApp.stopAllPoolInstances (:155-163) reads it: `instance.stop(reason, …)`.
  Update install keeps "update-install" (DesktopUpdates.ts:870).

## C. Server
- NEW apps/server/src/desktopStopIntent.ts: `readDesktopStopIntent = Effect.fn("DesktopStopIntent.read")(path, pid)` →
  Option<DesktopStopIntent>: read, decode, accept only intent.pid === pid, then remove the file (best effort); missing/invalid/other pid → none
  (invalid or other-pid files are removed too, they are stale). And a Context.Service `DesktopStopIntentReader { current: Effect<Option<DesktopStopIntent>> }`
  whose layer reads at most once (cached on first use) from ServerConfig.desktopStopIntentPath with process.pid; layerNone when the path is absent.
  Also remove a leftover file at server start (stale from an earlier run).
- ServerConfig: `desktopStopIntentPath?: string` threaded from bootstrap like desktopTelemetryFd (apps/server/src/cli/config.ts:380, :510; config.ts:100, :242; pair.ts:351).
- serverRuntimeStartup.ts finalizer (first statement): `Server shutdown intent` { reason | "unknown", requestedAt } via the reader, so thread 4's
  shutdown decision and the log use the same value.

## Tests (failing-first, TestClock, no sleeps)
1. apps/server/src/desktopStopIntent.test.ts: matching pid → Some and file removed; other pid → None and removed; invalid JSON → None; missing → None.
2. serverRuntimeStartup.test.ts: reader returning relaunch → "Server shutdown intent" record with reason relaunch.
3. DesktopBackendManager.test.ts: stop("update-install") on a run with pid and intent path → file content {pid, reason} written BEFORE the fake kill;
   a write that never completes → bounded stop still kills within the budget and records WARN; no intent path → no write.
4. DesktopLifecycle/DesktopApp: relaunch sets the stop reason so pooled backends stop with "relaunch" (test at the lowest seam that exists; if
   stopAllPoolInstances is not exported, export a small `stopReasonFor(state)` helper only if a test needs it — no test of private call order).
5. cli/config test (if one exists for desktopTelemetryFd threading): desktopStopIntentPath reaches ServerConfig.

## Verification
vp test run on the touched test files; vp run check:changed; PR to dev; exact-head goat-ci-result; fresh review; merge; tell thread 4 the SHA.

## Out of scope
Thread 4's consumer logic, the user setting "keep running after quit", server-internal restart intent (thread 4 owns), WSL intent channel.



## Revision 2 (audit r1 FAIL folded)

Supersedes B/C above where they differ.

1. One intent write per run, ahead of every close (r1 P1-1). ActiveBackendRun gains `intentWritten: Deferred<void>`. The stop that makes
   the NEW request forks the write and completes intentWritten when the write finishes, fails or hits its bound. Every closeRun (first
   or duplicate stop, instance-closed, retry) awaits intentWritten — bounded by INTENT_WRITE_TIMEOUT = 1 s — before Scope.close, so
   no stop can SIGTERM ahead of the record. Runs without a pid or without an intent path complete intentWritten immediately.
   Test: two concurrent stops, the write blocked on a Deferred → no kill until the write completes or 1 s passes (TestClock); kill observed after.
2. Per-run path (r1 P1-2). configResolve builds `desktopStopIntentPath = <stateDir>/runtime/desktop-stop-intent/<uuid>.json` per start
   (fresh for each run; the bootstrap is per run). The server only reads and deletes its own path; no server-side sweeping. The desktop
   deletes the run's file in finalizeRun, and sweeps the directory at primary start before spawning (one desktop owns a state dir; the
   previous run's server has already exited or been released). Test: two runs, the earlier server's read/delete never touches the later file.
3. Every write is bounded (r1 P1-3): INTENT_WRITE_TIMEOUT 1 s for bounded and unbounded stops, counted inside the stop budget
   (BACKEND_STOP_TIMEOUT stays 9 s: 1 s spawn settle and the 1 s intent wait run before SIGTERM, and the margin second absorbs it —
   update the constant comment; if review wants strict sums, raise to 10 s only with the DesktopLifecycle stall threshold above it).
   A late rename after the bound can only recreate this run's own file; finalizeRun's delete or the next start sweep removes it.
   Tests: write fails → WARN "backend stop intent not written" + kill proceeds; write exceeds 1 s → kill at 1 s.
4. Platforms (r1 P1-4), stated in the PR and to thread 4: macOS/Linux local primary — supported. Windows local primary — the file is written,
   but the spawner force-terminates (taskkill /T /F) so the server never runs its shutdown finalizers; the intent cannot change behavior there
   until Windows gets a graceful stop. WSL — no intent path (Linux server, Windows path) → server reports unknown → quit behavior.
   No new platform test beyond the existing platform-aware subprocess tests; the limits are documented.
5. Reader wiring (r1 P2). `DesktopStopIntentReader` layer is merged into layerRuntimeDependencies (apps/server/src/server.ts ~:1275) so
   ServerRuntimeStartup's finalizer and thread 4's shutdown consumer resolve the same instance. `current` = Effect.cached read-once:
   first call reads + deletes, later calls return the same Option. First reader is the shutdown finalizer's "Server shutdown intent" log;
   thread 4's consumer runs after it and gets the cached value. Absent path → layer returns Option.none without touching the filesystem.
   Test: two `current` calls → one read, same value, file deleted once.



## Revision 3 (audit r2 folded)

1. No start sweep (r2 P1-1). The desktop never deletes another run's file at start. Cleanup is per run only (item 2), plus an age-based
   sweep: at primary start remove files in runtime/desktop-stop-intent/ whose mtime is older than 24 h (no live server can still be
   waiting on a 24 h old stop). Test: a fresh file from an earlier run that timed out is untouched by the next start.
2. Delete only after the process is gone (r2 P1-2). finalizeRun deletes the run's file only on the branch where the exit was observed
   (exitObserved true) or no pid was ever known; the "pid known, exit not observed" branch (pauseRecovery) leaves it. Tests: failure with
   unobserved exit keeps the file; observed exit deletes it.
3. Read only at shutdown (r2 P2). The reader service exposes `atShutdown: Effect<Option<DesktopStopIntent>>` and nothing else; its doc
   comment states it reads once when called and caches; ServerRuntimeStartup's finalizer calls it first. To make an early call harmless,
   a call that finds no file does NOT cache None — it caches only a found intent (Some) or a terminal decode/pid mismatch; a missing file
   returns None uncached, so a later shutdown read still sees the file. Test: call before the file exists → None; write file; call → Some;
   call again → same Some, file deleted once.


## Revision 4 (audit r3 NEAR-PASS residuals)

1. Drop the 24 h sweep: no age-based deletion. Files are per run, a few hundred bytes, and removed on observed exit; a file left by a
   server whose exit was never observed stays (documented limit, at most one per such run).
2. The reader serializes calls with a Semaphore(1) around read+delete+cache, so concurrent atShutdown calls get the same result.
   Test: two concurrent atShutdown calls with the file present → both Some, one delete.
