# 020 — Phase 2 (wp4): server last-resort net

Branch: `fix/server-contain-teardown-errors` from origin/dev after wp3 merges. One PR.
Coordination: before B, check thread 3's PR (branch fix-backend-stop-reason-grace) — if it touched
apps/server/src/cli/server.ts or bin.ts, wait for its merge and rebase onto it.

## Design

One module owns both process-level events, because two owners do not compose: Cursor's layer
already holds a process-lifetime `unhandledRejection` listener (packages/provider-cursor/src/server/CursorSdk.ts:43-57,
installed :73-80, provided in ProviderOrchestrationAdapterInfrastructure.ts:114). While any
`unhandledRejection` listener exists Node never raises rejections as uncaught exceptions, and
Cursor's listener exits 1 itself (:55-56) unless another listener exists (:52). A net that only
listened to `uncaughtException` would never see rejections; a second `unhandledRejection` listener
would make Cursor defer and the net exit on the rejections Cursor means to contain.

NEW packages/shared/src/processErrorNet.ts (subpath `@goat/shared/processErrorNet`) owns:
- `isTeardownError(error)`: `code` in { EPIPE, ECONNRESET, ERR_STREAM_DESTROYED } or ws's exact message
  "WebSocket was closed before the connection was established". Identity only, never origin.
- `containRejections(classify)`: registers a classifier that returns a log line for rejections its
  owner knows are harmless, and holds the `unhandledRejection` listener only (refcounted). It never
  installs the `uncaughtException` side, so CLI subcommands, tests and the desktop backend before
  runServerCommand keep Node's default crash for uncaught exceptions. Cursor's two classifiers move here.
- `installProcessErrorNet()`: holds both listeners (refcounted with the rejection side) for the
  process lifetime. Called once from runServerCommand and never released: shutdown is exactly when
  teardown EPIPE/ECONNRESET cluster, and releasing at scope close would turn a requested stop into a
  crash code that thread 3's stop-reason classification would misread.
- `containedErrorCount()`: total contained since start.
- State lives on `globalThis[Symbol.for("goat.processErrorNet")]`, so two loaded copies of the module
  (source + bundle) share one listener set and one classifier list.

Handling (each event):
1. teardown error -> count, log, continue.
2. rejection matched by a registered classifier -> count, log its line, continue.
3. anything else -> if another listener for the same event exists (`process.listenerCount(event) > 1`:
   vitest workers, Electron, any embedder), return and let it decide — Node itself never exits on its
   own once a listener exists, and dev's Cursor guard defers the same way (:52). Otherwise write
   `util.inspect(error)` and exit 1: the code Node uses for an uncaught exception today, so
   DesktopBackendManager.ts:615 finalizeRun -> :629 scheduleRestart and the crash-loop budget (:194)
   see what they see now. Throwing from the handler would exit 7.

Logging: `NodeFS.writeSync(2, …)` in try/catch, first occurrence per key and every 100th. A sync
write cannot re-enter the handler through a broken stderr stream; a failed write (EPIPE, or EAGAIN on
a non-blocking pipe) is swallowed and the counter still records the event.

Known limit, stated in the code comment and PR: containing an error does not clean up the object
that raised it (example: a cell waiting on a dead child runs to its wall limit). The net only stops
one leaked emitter from ending every thread on the server; wp3/wp5 route errors to cleanup.

No steady-state cost: nothing runs until an exception or rejection is already unhandled.

## MODIFY / NEW map

### NEW packages/shared/src/processErrorNet.ts
```ts
// @effect-diagnostics nodeBuiltinImport:off - Process-level handlers live outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

const TEARDOWN_CODES = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]);
const WS_CLOSED_CONNECTING = "WebSocket was closed before the connection was established";
type Classifier = (reason: unknown) => string | undefined;
interface NetState {
  readonly classifiers: Set<Classifier>;
  readonly counts: Map<string, number>;
  total: number;
  uncaughtHolds: number;
  rejectionHolds: number;
}
// Shared across module copies (source and bundle) so there is only ever one listener set.
const state: NetState = ((globalThis as { [key: symbol]: NetState | undefined })[
  Symbol.for("goat.processErrorNet")
] ??= { classifiers: new Set(), counts: new Map(), total: 0, uncaughtHolds: 0, rejectionHolds: 0 });

const errorCode = (error: Error) =>
  "code" in error && typeof error.code === "string" ? error.code : undefined;

/** A pipe or peer that went away; nothing about the process is wrong. */
export const isTeardownError = (error: unknown): error is Error =>
  error instanceof Error &&
  (TEARDOWN_CODES.has(errorCode(error) ?? "") || error.message === WS_CLOSED_CONNECTING);

const writeStderr = (text: string) => {
  try {
    NodeFS.writeSync(2, text);
  } catch {}
};
const contain = (key: string, text: string) => {
  state.total += 1;
  const count = (state.counts.get(key) ?? 0) + 1;
  state.counts.set(key, count);
  if (count === 1 || count % 100 === 0) writeStderr(`goat: contained ${key} (${count}): ${text}\n`);
};
const fatal = (event: "uncaughtException" | "unhandledRejection", error: unknown) => {
  if (process.listenerCount(event) > 1) return;
  writeStderr(`${NodeUtil.inspect(error)}\n`);
  process.exit(1);
};
const teardownKey = (error: Error) => errorCode(error) ?? "WS_CLOSED_CONNECTING";
const onUncaught = (error: unknown) => {
  if (isTeardownError(error)) return contain(teardownKey(error), error.stack ?? error.message);
  fatal("uncaughtException", error);
};
const onRejection = (reason: unknown) => {
  if (isTeardownError(reason)) return contain(teardownKey(reason), reason.stack ?? reason.message);
  for (const classify of state.classifiers) {
    const line = classify(reason);
    if (line !== undefined) return contain("rejection", line);
  }
  fatal("unhandledRejection", reason);
};
const holdRejections = () => {
  if (state.rejectionHolds++ === 0) process.on("unhandledRejection", onRejection);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--state.rejectionHolds === 0) process.off("unhandledRejection", onRejection);
  };
};

/** For the long-running server, for the rest of the process: teardown errors stay contained. */
export function installProcessErrorNet(): void {
  if (state.uncaughtHolds++ === 0) process.on("uncaughtException", onUncaught);
  holdRejections();
}

/** Contains rejections the classifier names (it returns the line to log); others behave as before. */
export function containRejections(classify: Classifier): () => void {
  state.classifiers.add(classify);
  const release = holdRejections();
  return () => {
    state.classifiers.delete(classify);
    release();
  };
}

export const containedErrorCount = () => state.total;
```
(The globalThis cast is a narrowing cast, allowed by code-budget; P may swap it for a typed helper.
Because installProcessErrorNet is process-lifetime, the module needs no reset export: tests use
subprocess fixtures.) packages/shared/package.json exports `"./processErrorNet"`.

### MODIFY packages/provider-cursor/src/server/CursorSdk.ts
Delete `onUnhandledRejection` (:43-57) and the process.on/off in the layer (:73-80). Keep
`isCursorShellSpawnFailure` and `isCursorClosedStreamWrite`. The layer becomes:
```ts
export const layer = Layer.effect(
  CursorSdk,
  Effect.acquireRelease(
    Effect.sync(() =>
      containRejections((reason) =>
        isCursorShellSpawnFailure(reason)
          ? "Cursor shell spawn failed. The server will keep running."
          : isCursorClosedStreamWrite(reason)
            ? "Cursor SDK wrote to a closed exec stream. The server will keep running."
            : undefined,
      ),
    ),
    (release) => Effect.sync(release),
  ).pipe(Effect.as(CursorSdk.of({ Agent, createAgentPlatform, SqliteLocalAgentStore }))),
);
```
The "provide once per process" comment (:69) goes: registrations compose. CursorSdk.test.ts:18-28
strips vitest's listeners to test the exit path; adapt it to the shared module (Cursor rejections
contained and logged; other rejections exit 1 when the net is the only listener). The 8 test files
that provide the Cursor layer keep vitest's own listeners, so `fatal` defers to them (no process.exit
inside a vitest worker).

### MODIFY apps/server/src/cli/server.ts
First statement of runServerCommand:
```ts
  // One unheard pipe or peer error must not take down every thread on this server, shutdown included.
  yield* Effect.sync(installProcessErrorNet);
```
The desktop-mode `process.stdout/stderr.on("error", ignoreClosedPipe)` (:83-84) stays.
Surface `containedErrorCount()` in an existing server diagnostics read only if one already reports
process-level counters (search at P); otherwise the stderr log is the surface and the PR says so.

## TESTS

NEW packages/shared/src/processErrorNet.test.ts, it.live subprocess fixtures (deterministic: await child exit):
fixture = `process.execPath --input-type=module -e "<script>"` importing the module by absolute file URL.
1. "a teardown error nothing heard leaves the server running": installProcessErrorNet, then in
   setImmediate emit 'error' with code EPIPE from a bare EventEmitter; next setImmediate prints "alive"
   and exits 0. Assert exit 0, stdout "alive", stderr "contained EPIPE".
2. "a teardown rejection is contained": install, reject a promise with ECONNRESET. Exit 0, "alive".
3. "a classified rejection is contained without the server net": containRejections only, reject with
   the classified error. Exit 0, "alive". And an uncaught TypeError in that same mode exits 1 through
   Node's default (the uncaught side is not held).
4. "any other uncaught error or rejection still exits 1 when the net is the only listener": TypeError
   thrown; unclassified rejection. Exit 1, no "alive", stderr contains the message.
5. "another listener decides instead of the net": a fixture adds its own uncaughtException listener
   that prints "theirs"; an unclassified TypeError yields "theirs" and no exit 1 from the net.
Fail-first, stated honestly: case 1 run without install exits 1 (dev behavior); cases 2-5 fail against
dev by import (module absent), not by behavior. CursorSdk tests adapted and passing.

## Verification (C)

1. `vp test run packages/shared/src/processErrorNet.test.ts packages/provider-cursor/src/server/CursorSdk.test.ts` exit 0.
2. `vp run check:changed` exit 0.
3. Runtime: `vp run dev` in the worktree, confirm startup unchanged; stop by the captured PID.
4. PR -> exact-head CI -> terra review -> merge-pr.ts.
NOT RUN expected: Electron-node (reference /tmp/goat-ws-crash-aside/contain.cjs showed the handler shape on Electron-node 24.22.1).

## Parent correction (binding for wp4 P/A)

Source: parent thread, citing /Users/jun/.aside/u/0/artifacts/goat-isolation-memory/report.md §2.5,
Node's "Warning: Using 'uncaughtException' correctly" (process.html#warning-using-uncaughtexception-correctly),
and /Users/jun/Developer/goat/devlog/_plan/261103_goat-hub-isolation-design/000_design.md:12.
- Priority stays: creation-time listeners (wp3, wp5-wp7) are the fix; the net is a backstop.
- (a) Every uncaught error and unhandled rejection is logged, contained or not.
- (b) The process keeps running only for entries whose harmlessness can be argued from evidence: a
  late, asynchronous EPIPE / ECONNRESET / ERR_STREAM_DESTROYED from a connection or pipe that is
  already torn down (no partially applied state). Everything else exits 1 and the desktop restarts it.
- At wp4 P, each allowlist entry (including the ws "closed before the connection was established"
  message and Cursor's two rejection classifiers) needs a written argument: where it is raised, why no
  in-memory state is left half-updated, and what a counterexample would look like. The terra review in
  wp4 A confirms or drops each entry; an entry without an argument is dropped (exit 1).
- Prior art to cite: Synara desktop catches only EPIPE and requests a clean shutdown; the ChatGPT app
  ignores only its own stdout EPIPE and rethrows the rest.

## wp4 P revision (supersedes the Design/Handling/code sketch above where they differ)

Inputs: terra allowlist evidence /tmp/wp4-allowlist.md (copied below in substance), the mandatory
rules merged in #2422 (docs/internals/server-resilience.md: one last-resort handler; it may continue
only for codes with a reviewed reason recorded in that doc; no other process handlers anywhere), and
a coordinator probe: Node marks an unheard emitted 'error' with the internal symbol
`kEnhanceStackBeforeInspector` and leaves a plain throw unmarked, on node 26.12.1 AND on the desktop
backend's Electron-node 24.22.1 (/tmp/wp4-tagprobe.cjs run with ELECTRON_RUN_AS_NODE=1 against
/Applications/GOAT (Nightly).app: emitted ["kEnhanceStackBeforeInspector"], thrown []).

### Contained set (each needs the emit tag = "an 'error' event nobody heard", never a throw from our frames)
| key | predicate | reason it is safe to continue |
|---|---|---|
| EPIPE | code "EPIPE", syscall "write", tagged | raised by stream_base afterWriteDispatched -> destroy -> emitErrorNT on nextTick; the socket is destroyed before the emit and the GOAT write() already returned. writeSync EPIPE is a throw (untagged) and stays fatal. |
| ECONNRESET | code "ECONNRESET", syscall "read" or "write", tagged | peer reset: onStreamRead/afterWrite destroy then emit on nextTick. Excludes http's "socket hang up" (ECONNRESET without syscall, raised on a ClientRequest whose owner still awaits a response). |
| WS_CLOSED_CONNECTING | message exactly "WebSocket was closed before the connection was established", no code, tagged | ws abortHandshake on close()/terminate() of a CONNECTING socket, emitted on nextTick together with 'close'; the owner already dropped the socket (typically Effect's finalizer, Socket.ts:1079/:915). |
| rejection: Cursor WriteIterableClosedError | name "WriteIterableClosedError" and message "WritableIterable is closed" | the SDK throws it as the first statement of write() on a closed iterable: nothing mapped or written. |
| rejection: Cursor shell spawn failure | existing isCursorShellSpawnFailure | spawn error of a child that never ran (nextTick); kept as today's behavior. Evidence partial (SDK site not located in the minified bundle) — A must confirm or drop. |
Dropped: ERR_STREAM_DESTROYED (a write after destroy emits no 'error'; it only escapes when code rethrows/rejects it on its own path) — it stays only in the stdout/stderr ignoreClosedPipe filter. Rejections carrying teardown codes exit 1 (no tag; the async producer may be mid-update).

### Behavior
- Every uncaught exception and unhandled rejection is logged with `writeSync(2)` (try/catch) and a
  per-key count, contained or not; no rate limit (after wp3/wp5 a flood is itself the signal).
- Fatal: log, then `process.exit(1)` unless another listener for that event exists (then return and
  let it decide — Node's own rule, and today's Cursor guard :52).
- No graceful shutdown on a contained error (one dead peer must not end every thread; GOAT's own
  controlling pipes are already handled by desktop-mode stdout/stderr listeners + awaitLauncherLoss).
- installProcessErrorNet() in runServerCommand before acquireServerOwnerLock, process lifetime, never
  released (shutdown is when teardown errors cluster). containRejections() holds only the rejection side.
- State on globalThis[Symbol.for("goat.processErrorNet")]; the tag is matched by symbol description
  (Node internal) and pinned by a test that fails if Node stops tagging (entries then fall back to exit 1).
- docs/internals/server-resilience.md "Never resume after an uncaught exception": replace the example
  codes with the reviewed table above (key, predicate, one-line reason) and name the module as the
  single handler; ERR_STREAM_DESTROYED removed from the list with its reason.

### Tests (packages/shared/src/processErrorNet.test.ts, it.live subprocess fixtures, await exit)
1. emitted EPIPE(write) unheard -> exit 0, "alive", log line. 2. emitted ECONNRESET(read) -> exit 0.
3. thrown EPIPE (untagged, same object shape) -> exit 1. 4. http-style ECONNRESET without syscall -> exit 1.
5. ws closed-while-connecting emitted -> exit 0. 6. rejection with EPIPE -> exit 1. 7. Cursor classified
rejection with containRejections only -> exit 0; same mode, uncaught TypeError -> exit 1 (uncaught side not held).
8. another uncaughtException listener present -> net does not exit. 9. tag pin: emitted error carries a
symbol described "kEnhanceStackBeforeInspector" (fails loudly if Node changes).
Fail-first: dev has no module (import failure) — honest; behavioral fail-first is case 1 without install (exit 1).
CursorSdk.test.ts adapted (its process-listener stripping exercises the shared module).

### Coordination
Thread 3 PR #2418 (open) restructures cli/server.ts runServerCommand. Develop on origin/dev now; before
merging, wait for #2418 to merge, rebase onto it (installing inside its restructured function), rerun
focused tests + check:changed.

## wp4 A fold (terra NEAR-PASS; binding for B)

- Allowlist decided: KEEP EPIPE(write, tagged), ECONNRESET(read|write, tagged), WS_CLOSED_CONNECTING
  (exact message, no code, tagged), rejection Cursor WriteIterableClosedError (name + message).
  DROP ERR_STREAM_DESTROYED and the Cursor shell-spawn classifier: in @cursor/sdk 1.0.38 every executor
  routes child 'error' into its iterable and every writer catches, so no unawaited SDK rejection exists;
  the same error reaches GOAT's Cursor adapter, where containing it would hide a GOAT failure. Behavior
  change: such a rejection now logs and exits 1 (desktop restarts). isCursorShellSpawnFailure and its
  marker list are deleted with the classifier (search consumers first).
- Defer-to-other-listener applies ONLY to unhandledRejection (dev's Cursor behavior, in-process vitest).
  uncaughtException never defers: a non-contained uncaught error always logs and exits 1, matching the
  single-handler rule (server-resilience.md:35-40). Test 8 becomes: an extra unhandledRejection listener
  defers; an extra uncaughtException listener does not stop exit 1.
- docs/internals/server-resilience.md "Never resume after an uncaught exception": list entries as
  key | predicate | reason, list dropped ones (ERR_STREAM_DESTROYED, Cursor shell spawn) with reasons,
  and name @goat/shared/processErrorNet as the only module that registers these process listeners.
- Test 5 is real: a net server that accepts but never answers the upgrade, a ws client, then close()
  while CONNECTING, with no error listener on the ws. Test 7 classifier list = WriteIterableClosedError only.
