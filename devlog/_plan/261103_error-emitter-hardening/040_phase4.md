# 040 — Phase 4 (wp6): desktop main process

Branch: `fix/desktop-guard-error-emitters` from origin/dev after wp5 (uses @goat/shared/errorGuards;
apps/desktop already depends on @goat/shared). One PR. Coordination: thread 3 edits
apps/desktop/src/backend/DesktopBackendManager* — this phase does not touch those files; if its PR
is still open at P, confirm no overlap with `gh pr diff` and proceed.

Desktop main restarts nothing for itself: an unheard error here quits the app. No last-resort net in
desktop main in this goal (the parent asked for the server); main.ts:3-6 already ignores its own
stdout/stderr EPIPE.

## MODIFY map

### 1. apps/desktop/src/app/DesktopAppActivation.ts (B23)
`listen()` (:176-189) removes its only server 'error' listener once listening (:184), so a later
accept error (EMFILE) on the activation server is uncaught.
After:
```ts
      const server = guardErrors(NodeNet.createServer(handleConnection), (error) => {
        if (!server.listening) return reject(error);
        // A listening activation server that fails stops taking requests; the app keeps running.
        server.close();
      });
      server.once("listening", () => resolve(server));
      server.listen(address);
```
(onError/onListening pair collapses into one permanent route; reject before listening, close after.
Verify at P that the caller tolerates a closed activation server — it already handles close at
shutdown — and whether it should log; keep behavior minimal.)

### 2. apps/desktop/src/cua/ComputerUseHelper.ts (C8)
Before (:303): `const lines = NodeReadline.createInterface({ input: process.stdout });`
After:
```ts
  // A broken helper stdout ends the helper like its exit does.
  const lines = guardErrors(NodeReadline.createInterface({ input: process.stdout }), () => lines.close());
```
`lines.on("close", finish)` (:325) then resolves pending calls with helper_exited and marks ended.
(`process` here is the helper handle, not Node's process.)

### 3. Migrate desktop raw sites (same rules as 030)

| row | path:line (001) | today | becomes | route |
|---|---|---|---|---|
| A31 | apps/desktop/src/permissions/MacSettingsWindow.ts:106 | on :136 | guardChild | onExit |
| A39 | apps/desktop/src/snapShot/SnapShotAccessibilityProcess.ts:51 | once :112 | guardChild(fork) | finish |
| A40 | apps/desktop/src/snapShot/MacModifierPairShortcutProcess.ts:41 | once :85 | guardChild | stop |
| A41 | apps/desktop/src/snapShot/RegionSnapShot.ts:34 | once :44 via onExit :98 | guardChild(fork) at creation; fixes the residual 2nd error (send on closed channel) | finish |
| A42 | apps/desktop/src/snapShot/NativeCaptureFeedback.ts:22 | stdin on :50, once :51 | guardChild | close |
| A43 | apps/desktop/src/snapShot/GlobalShiftShortcutProcess.ts:14 | once :54 | guardChild(fork) | reject |
| A44 | apps/desktop/src/cua/McpHelperHost.ts:31 | once :41 + StdioMcpClient :137-138 | guardChild | io_error |
| A45 | apps/desktop/src/cua/agentRouteProbe.ts:88 | on :127 | guardChild | settle failed |
| A46 | apps/desktop/src/cua/ComputerUseHelper.ts:147 | once :153, stdin on :156 | guardChild | resolve null |
| A47 | apps/desktop/src/cua/ComputerUseHelper.ts:161 | once :167, stdin on :171 | guardChild | resolve null |
| B24 | apps/desktop/src/snapShot/NiriSnapShot.ts:65 | on :88 | guardErrors | close |
| D5 | apps/desktop/src/electron/WindowsForegroundFocusThread.ts:78 | once :102 | guardErrors(new Worker) | reset |
| W1 | apps/desktop/src/app/DesktopAppActivation.ts:252 | NodeFS.watch, listener :255 | guardErrors(NodeFS.watch(...), existing handler) | existing |

execFile rows A32-A38 unchanged (Node attaches its own listener).

## TESTS
- DesktopAppActivation test (existing file beside it at P): failing-first — after listen resolves,
  `server.emit("error", Object.assign(new Error("x"), { code: "EMFILE" }))` must not throw and the
  server must close. On dev: throws (no listener).
- ComputerUseHelper: if its test file has a fake helper with a controllable stdout, destroy stdout with
  an error and assert pending calls resolve helper_exited; otherwise NOT RUN with reason.

## Verification (C)
1. Fail-first log for activation; focused tests beside changed desktop files exit 0.
2. `vp run check:changed` exit 0. 3. PR -> CI -> terra review -> merge-pr.ts.
NOT RUN expected: a live Electron run (app restart is forbidden in this goal).
