# 010 — Phase 1 (wp3): close the open gaps in apps/server

Branch: `fix/server-unheard-error-gaps` from origin/dev. One PR. Stale check at P: re-run the
rg commands in 001 for each row and confirm the line numbers below before editing.

## MODIFY / NEW / DELETE map

### 1. MODIFY apps/server/src/bootstrap.ts (C1, S — can end the server at startup)

readline.Interface subscribes to its input's 'error' and re-emits it on itself; with no listener on
the interface, a read error on the bootstrap fd is an uncaught exception even though the stream has
`once("error", handleError)` (probe in 001 §C).

Before (:97-103, :140-142):
```ts
    const cleanup = () => {
      stream.removeListener("error", handleError);
      input.removeListener("line", handleLine);
      input.removeListener("close", handleClose);
      ...
    stream.once("error", handleError);
    input.once("line", handleLine);
    input.once("close", handleClose);
```
After:
```ts
    const cleanup = () => {
      input.removeListener("error", handleError);
      input.removeListener("line", handleLine);
      input.removeListener("close", handleClose);
      ...
    // readline re-emits its input's errors on the interface; only the interface's listener is enough.
    input.on("error", handleError);
    input.once("line", handleLine);
    input.once("close", handleClose);
```
`on` (not `once`): the callback's resume is single-shot, and a second error after the first must
still be heard until cleanup removes it. Keep handleError unchanged (EBADF/ENOENT -> none,
otherwise BootstrapEnvelopeReadError).

### 2. MODIFY apps/server/src/terminal/NodePtyAdapter.ts (A13, S)

node-pty's UnixTerminal socket handler closes the pty, emits close/exit, then throws any error other
than EAGAIN/EIO unless `terminal.listeners("error").length >= 2` (unixTerminal.js:101-127, :206-209;
Terminal.listeners and Terminal.on forward to the socket, terminal.js:139-159). WindowsTerminal has
the same rule (windowsTerminal.js:90-103), so one listener covers both platforms. node-pty itself
already runs the cleanup (_close + 'close' -> onExit), so the adapter's listener only has to exist.

In the spawn Effect.try (:258-265), after `nodePty.spawn(...)`:
```ts
          const nativeProcess = nodePty.spawn(input.shell, input.args ?? [], { ... });
          // node-pty closes the pty itself and rethrows socket errors nobody else hears.
          nativeProcess.on("error", ignorePtySocketError);
```
with a module-level `const ignorePtySocketError = () => {};`. IPty declares only onData/onExit
(typings/node-pty.d.ts:117-156), so extend locally:
`type NodePtyTerminal = import("node-pty").IPty & { on(event: "error", listener: (error: Error) => void): void }`
and narrow the spawn result to it once (runtime Terminal.on exists, terminal.js:139); no casts to any.

### 3. MODIFY apps/server/src/cua/linuxHelper/CuaDriverMcp.ts (C2, X — Linux CUA helper)

Before (:101): `NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {`
After:
```ts
  const lines = NodeReadline.createInterface({ input: child.stdout });
  // A driver whose stdout breaks is as gone as one that exited.
  lines.on("error", kill);
  lines.on("line", (line) => {
```
`kill` (:134) is declared later as a const; move the readline block below `kill` or hoist kill
above it (pure move, no behavior change). SIGKILL of the group makes `exited` resolve -> gone path.

### 4. MODIFY apps/server/src/cua/ComputerUseLeaseProxyCli.ts (C3, C — per-thread lease proxy; D8 for this fast path)

(a) Before (:399): `const lines = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });`
After: add directly below it
```ts
        // A broken driver stdout ends the driver; its exit handler reports it.
        lines.on("error", () => killDriverGroup(platform, child, "SIGKILL"));
```
(b) stdout EPIPE (:774 `process.stdout.write`): in `runLeaseProxyCli` before the first write,
`process.stdout.on("error", ignoreClosedPipe)` — the provider that reads it is gone; stdin EOF then
drives the existing shutdown (drivers ended by endDriversWithProxy).

### 5. NEW packages/shared/src/closedPipe.ts + MODIFY apps/server/src/cli/server.ts (D6/D8 shared helper)

Move `ignoreClosedLauncherPipe` (cli/server.ts:42-44, its comment :39-41) to a shared subpath so fast paths reuse it:
```ts
// packages/shared/src/closedPipe.ts
/** For stdout/stderr whose reader may leave first: a closed pipe ends output, anything else still throws. */
export function ignoreClosedPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
}
```
packages/shared/package.json exports: `"./closedPipe": { "types": "./src/closedPipe.ts", "import": "./src/closedPipe.ts" }`.
cli/server.ts: delete the local function (move its 3-line comment :39-41 to the call site :83), import
`ignoreClosedPipe` from `@goat/shared/closedPipe`.

### 6. MODIFY apps/server/src/mcp/AcpMcpStdioBridge.ts (D8, long-lived per ACP session)

In `runAcpMcpBridgeFastPath` (:504) before the bridge starts writing:
`process.stdout.on("error", ignoreClosedPipe);` — the ACP agent that reads it has gone; its stdin
EOF ends the bridge through the existing Stream.fromAsyncIterable path (:493).

### 7. MODIFY apps/server/src/cli/triage.ts (C7, interactive CLI)

Closing a readline/promises interface leaves a pending `question` unsettled (audit probe, node 26),
so the error must reject the awaited value itself. After createInterface (:89):
```ts
    const broken = new Promise<never>((_, reject) => readline.once("error", reject));
    ...
        const answer = (await Promise.race([readline.question(`Run triage with:\n${menu}\n> `), broken])).trim();
```
and change `pickAgent`'s `Effect.promise` to `Effect.tryPromise` mapped to the command's existing
user-facing error, so a broken terminal ends `goat triage` with a message instead of a defect.

### 8. MODIFY apps/server/src/cli/uninstall.ts (A27, `goat uninstall` on Windows)

`spawnWindowsRemoval` (:82): attach the route at creation:
```ts
  const child = NodeChildProcess.spawn(comspec, [...], {...});
  // A missing shell fails after spawn returns; the uninstall already finished without it.
  child.on("error", onError);
  return child;
```
with a new parameter `onError: (error: Error) => void`; the caller (:231) passes a handler that
writes the existing message "Could not schedule removal of <dir>. Delete it yourself once this window is closed."
to stderr with `NodeFS.writeSync(2, …)` in try/catch (the Effect has already completed).

## TESTS (failing-first where reachable)

- apps/server/src/bootstrap.test.ts — NEW it.live (it.effect runs on TestClock, so on dev the read's
  Effect.timeoutOption at bootstrap.ts:145 would never fire and the test would hang) "a read error on the bootstrap fd fails the read instead of the process":
  open a directory fd (`NodeFS.openSync(tmpDir, "r")`; fstat succeeds, read fails with EISDIR) and
  assert readBootstrapEnvelope fails with BootstrapEnvelopeReadError. On dev: the EISDIR is re-emitted
  by readline with no listener -> unhandled error in vitest (capture). EISDIR confirmed on darwin by
  the audit probe (fstat passes, stream emits EISDIR). The fd comes from an fs fixture dir, closed in a finalizer.
- apps/server/src/terminal/NodePtyAdapter.test.ts — NEW test "a pty socket error ends the
  process without escaping": capture the real IPty through the `NodePtyModuleLoader` seam
  (NodePtyAdapter.ts:30: wrap the real module's spawn to keep the returned terminal), spawn through
  the adapter (darwin/linux; skip win32 with the repo's platform guard), call
  `terminal.emit("error", Object.assign(new Error("boom"), { code: "EBADF" }))` and await the
  adapter's onExit. On dev, emit throws "boom" synchronously (terminal.js:147-156, the socket handler
  rethrows with fewer than 2 listeners) — a direct fail-first signal.
- CuaDriverMcp / lease proxy / triage / uninstall / closedPipe: no new tests unless the existing
  test file already drives that object cheaply (lease proxy has ComputerUseLeaseProxyCli.test.ts —
  add one case if a fake driver stdout can be destroyed with an error deterministically); otherwise
  these are one-line routes covered by wp7's lint rule. State each NOT RUN in the PR.

## Verification (C)

1. Fail-first logs for the bootstrap and node-pty tests on the unfixed source.
2. `vp test run apps/server/src/bootstrap.test.ts apps/server/src/terminal/NodePtyAdapter.test.ts apps/server/src/cua/ComputerUseLeaseProxyCli.test.ts apps/server/src/cli/uninstall.test.ts apps/server/src/cli/triage.test.ts` exit 0.
3. `vp run check:changed` exit 0 (host.status not critical, no concurrent heavy check).
4. PR -> exact-head goat-ci-result SUCCESS -> terra review PASS -> merge-pr.ts.

## wp3 A-phase fold (terra NEAR-PASS, binding for B)

- Write scope adds apps/server/src/terminal/NodePtyAdapter.test.ts (fake pty gains
  `on: (event, listener) => events.on(event, listener)`) and apps/server/src/cli/uninstall.test.ts:135
  (pass a noop route to spawnWindowsRemoval).
- Edit 2 typing: narrow with a type guard, no cast:
  `const hasOn = (p: IPty): p is NodePtyTerminal => "on" in p && typeof p.on === "function";`
  then `if (hasOn(nativeProcess)) nativeProcess.on("error", ignorePtySocketError);` (same style as the
  `"_socket" in process` check at NodePtyAdapter.ts:101).
- Edit 3: moving the readline block below `const kill` is mandatory (TDZ ReferenceError otherwise).
- Edit 6: install `process.stdout.on("error", ignoreClosedPipe)` before the bridge starts writing (AcpMcpStdioBridge.ts:519).
- Edit 7: map the broken-terminal failure to `TriageAgentChoiceRequiredError` (triage.ts:52; already
  used for non-TTY input at :214-215).
- Edit 8: the route also sets `process.exitCode = 1` (the CLI said the folder would be removed, :237).
- node-pty test: `NodePtyModuleLoaderRef` swap (test file :70) wrapping the real module's spawn to
  capture the terminal; pass the host platform to layerTestFor (default "win32", :63); spawn
  `/bin/sh -c read`-style blocking shell; finalizer kills the pty so a missed exit cannot hang.
- bootstrap test: it.live inside the existing it.layer(NodeServices.layer) block (:67), timeoutMs 100
  as at :83/:125. On dev: vitest unhandled EISDIR and None instead of BootstrapEnvelopeReadError.
