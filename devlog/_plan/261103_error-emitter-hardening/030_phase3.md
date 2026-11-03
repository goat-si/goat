# 030 — Phase 3 (wp5): guarded creation helpers + server/package migration

Branch: `refactor/guard-error-emitters-server` from origin/dev after wp4. One PR.

## Design

Two tiny helpers wrap the creation expression itself, so the listener exists before any event can
fire and the lint rule (050) can verify the shape syntactically: the creation call must be the first
argument of `guardErrors` or `guardChild`. Node's own overload typings survive because the helpers
are generic over the value they return. The route must end or fail the owner (Effect failure,
session close, kill, resolve-as-gone). A no-op route is allowed only with a one-line reason naming
the cleanup path that already runs (example: node-pty closes itself; Effect's SocketError).

### NEW packages/shared/src/errorGuards.ts
```ts
// @effect-diagnostics nodeBuiltinImport:off - Guards raw Node emitters at creation, outside Effect.
import type * as NodeChildProcess from "node:child_process";
import type * as NodeEvents from "node:events";

/** Where an emitter's 'error' goes: end or fail whatever owns the emitter. */
export type ErrorRoute = (error: Error) => void;

/** Hears 'error' from the moment the emitter exists; an unheard one ends the whole process. */
export function guardErrors<T extends NodeEvents.EventEmitter>(emitter: T, route: ErrorRoute): T {
  emitter.on("error", route);
  return emitter;
}

/** guardErrors for a child and every piped stdio stream, whose errors (EPIPE) outlive the spawn. */
export function guardChild<T extends NodeChildProcess.ChildProcess>(child: T, route: ErrorRoute): T {
  child.on("error", route);
  for (const stream of child.stdio) stream?.on("error", route);
  return child;
}
```
packages/shared/package.json exports `"./errorGuards"` (types/import -> ./src/errorGuards.ts).
NEW packages/shared/src/errorGuards.test.ts (contract): a guarded child whose stdin write hits EPIPE
routes the error and the test process survives; an emitter guarded before its first emit routes it.

### Migration rules (apply per row)

- `X.once("error", h)` / `X.on("error", h)` registered right after creation -> `guardErrors(create(), h)`
  / `guardChild(spawn(), h)` and delete the separate registration. `once` -> `on` is safe only when `h`
  is idempotent (resolve/reject/Deferred/flag); note any non-idempotent h and wrap it in a once-guard.
- Listener registered later (other function, after await) -> move it to creation; if `h` is not in
  scope yet, create a local `let onError: ErrorRoute = () => {}` forwarder only when no simpler move works.
- Effect.callback / Promise routes: a second resume or resolve is ignored by Effect and Promise, so
  `once` -> `on` is safe there; for any other route (counters, logging, kill), wrap it so it acts once.
- A3 `spawnOwnedCommand` (sshRuntimeAutoUpdate.ts:158) is a factory whose routes live in its callers
  (:115, :191, :283): give it an `onError: ErrorRoute` parameter, guardChild inside it, and pass each
  caller's existing handler.
- stdio streams already guarded inline (`child.stdin.on("error", …)`) -> removed; guardChild covers them.
  Where the old stdin route differed from the child route (e.g. driverProcess noop), keep the
  stricter of the two and say why in the PR.
- Readline consumed by `for await` / Stream.fromAsyncIterable: leave as is with
  `// oxlint-disable-next-line goat/guard-error-emitters -- async iteration rejects on 'error'`.
- Do not touch Effect-managed sites (001 §E).

### Site table (apps/server + server-runtime packages)

| row | path:line (001) | today | becomes | route |
|---|---|---|---|---|
| A1 | apps/server/src/screenCode/ScreenRunSupervisor.ts:160 | child once + stdin on (#2417) | guardChild(spawn) | onProcessEnd |
| A2 | apps/server/src/channels/imessage/imessageSender.ts:46 | child once :83, stdin once :80; callee is `(input.spawnProcess ?? NodeChildProcess.spawn)(…)` | guardChild around the whole call | existing finish handlers (merge into one route) |
| A3 | apps/server/src/cloud/sshRuntimeAutoUpdate.ts:158 | child once :115 :283, stdin on :191 | guardChild inside spawnOwnedCommand | resolve null/empty |
| A5 | apps/server/src/cloud/sshRuntimeWindowsJob.ts:187 | once :199 | guardChild | resolve failure |
| A6 | apps/server/src/cua/driverProcess.ts:20 | on noop :26-27 | guardChild(spawn, noop) + reason: consumers handle exit/close | noop (documented) |
| A7 | apps/server/src/memory/imports/MemoryImportReaderSupport.ts:104 | on :135 | guardChild | failed = true |
| A8 | apps/server/src/opencodex/ChildOpenCodexStartup.ts:64 | once :70 | guardChild | reject |
| A9 | apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:391 | SDK listeners | guardChild(spawn, noop) + reason: SDK transport + exit kill group | noop (documented) |
| A10 | ClaudeAdapterV2.ts:1012 (win32) | SDK listeners | same as A9 | noop (documented) |
| A12 | apps/server/src/provider/acp/AntigravityClientFiles.ts:229 | once :254, stdin on :257 | guardChild | Effect.fail path |
| A13 | apps/server/src/terminal/NodePtyAdapter.ts:258 | wp3 listener | stays (IPty is not an EventEmitter); disable comment with reason | node-pty self-close |
| A15 | packages/shared/src/cuaDriverManifest.ts:555 | on :581, stdin on :584 | guardChild | finish(error) |
| A20 | apps/server/src/cua/linuxHelper/CuaDriverMcp.ts:84 | once :91, stdin on :93 | guardChild | resolve exited |
| A23 | apps/server/src/serviceLauncher.ts:788 | once :797, on :800 | guardChild | existing reject/enqueue |
| A25 | apps/server/src/cli/sshRuntimeSupervisor.ts:291 | once :298 | guardChild | resolve false |
| A26 | apps/server/src/cli/triage.ts:120 | once :126 | guardChild | Effect.fail |
| A27 | apps/server/src/cli/uninstall.ts:82 | wp3 on | guardChild | onError param |
| A30 | apps/server/src/urlOpener/urlOpenerCli.ts:201 | once :211 | guardChild | exit code |
| B1 | apps/server/src/hubProxy/http.ts:375 | on noop :384 | guardErrors(new NodeWS.WebSocket, noop) + existing reason comment | Effect SocketError |
| B2 | packages/shared/src/Net.ts:49 :87 :141 | once :60 :102 :150 | guardErrors | resolve false/retry |
| B3 | packages/shared/src/codexAuthCallback.ts:39 | once :79 | guardErrors | reject |
| B4 | packages/ssh/src/tunnel.ts:414 :427 | once :416 :437 | guardErrors | resolve false |
| B5 | apps/server/src/provider/CodexManagedTokenBroker.ts:129 | server on :186 | guardErrors(server); per-connection sockets arrive via callback — keep socket.on at :130 (not a creation call) | destroy |
| B6 | apps/server/src/provider/CodexChatGptAuth.ts:481 | once :494 | guardErrors | reject |
| B7 | apps/server/src/provider/antigravityCallback.ts:76 | req once :95 | guardErrors(request); response is not created by us (keep :87) | Effect.fail |
| B8 | apps/server/src/htmlRender/publicProxy.ts:129 :165 | server on :188, track() | guardErrors(server); upstream connect -> guardErrors(connect, destroy) | destroy |
| B9 | apps/server/src/cloud/ConnectReachability.ts:180 | once :187 | guardErrors | false |
| B10 | apps/server/src/environment/DirectEndpoints.ts:99 | once :113 | guardErrors | false |
| B11 | apps/server/src/cua/CuaDisplayCapability.ts:455 :492 | once :458 :498 | guardErrors | unreachable/false |
| B12 | apps/server/src/cua/x11WindowPlacement.ts:126 | connection() on :66 | guardErrors at :126 with the same handler | fail waiters |
| B13 | apps/server/src/cua/CuaDbusProbe.ts:189 | once :219 | guardErrors | answered false |
| B14 | apps/server/src/bootstrap.ts:216 | stream once :140 (wp3 moves to rl) | guardErrors(new net.Socket, noop) + reason: read errors arrive through the readline route | readline route |
| B14b | apps/server/src/bootstrap.ts:183 :210 | createReadStream (fd), errors via readline (wp3) | guardErrors(createReadStream, noop) + reason: readline route | readline route |
| B25 | apps/server/src/server.ts:398 | NodeHttp.createServer inside guardHttpResponseWriteErrors; NodeHttpServer attaches server.on("error") (001 §E) | verify at P that the server reaches NodeHttpServer before it can emit; then guardErrors(createServer, noop) + reason naming NodeHttpServer.ts:135 | Effect server |
| B26 | apps/server/src/preview/DesktopBrowserChannel.ts:111 | new NodeNet.Socket({fd}) inside acquireRelease, read via NodeStream.fromReadable | guardErrors with the release/fail path found at P (fromReadable's once listener is removed on completion, 001 §E) | Effect failure |
| B27 | apps/server/src/resourceTelemetry/DesktopTelemetryReceiver.ts:580 | new NodeNet.Socket({fd}) inside acquireRelease | same as B26 | Effect failure |
| C12 | apps/server/src/cli/consoleStdin.ts:56 | new NodeTty.ReadStream(fd), Windows console stdin before serve (bin.ts:78-80), no listener | guardErrors(new NodeTty.ReadStream(fd), route) — route: destroy the stream (stdin ends, like a closed console) | end stdin |
| B28 | apps/server/src/cloud/CliTokenManager.ts:541 | NodeHttp.createServer passed as a value to NodeHttpServer.layer | disable comment: NodeHttpServer attaches server.on("error") (NodeHttpServer.ts:135) | Effect server |
| B15 | apps/server/src/cua/linuxHelper/atspiFocusEvents.ts:283 | on :418 | guardErrors | fail |
| B16 | apps/server/src/cua/linuxHelper/x11WindowCapture.ts:348 | connection() on :246 | guardErrors | fail |
| B17 | apps/server/src/cua/linuxHelper/humanInputSource.ts:276 | on :298 | guardErrors | close |
| B18 | apps/server/src/serviceLauncher.ts:540 | req on :578 | guardErrors(http.get) | finish |
| B19 | apps/server/src/cli/app.ts:117 | once :179 | guardErrors | reject/fallback |
| B20 | apps/server/src/cli/sshHelper.ts:16 :27 :63 | once :18 :37 :77 | guardErrors | false |
| B21 | apps/server/src/cli/sshRuntimeProbes.ts:61 :142 :382 :568 | once | guardErrors | finish |
| B22 | apps/server/src/cli/managedChatGptToken.ts:26 | on noop :29 | guardErrors(connect, destroy) | destroy |
| C1 | apps/server/src/bootstrap.ts:92 | wp3 rl on | guardErrors(createInterface, handleError) | BootstrapEnvelopeReadError |
| C2 | CuaDriverMcp.ts:101 | wp3 | guardErrors | kill |
| C3 | ComputerUseLeaseProxyCli.ts:399 | wp3 | guardErrors | kill driver group |
| C4 C5 C6 | LeaseProxyCli:757, AcpMcpStdioBridge:492, ScreenRunChild:98 | async iteration | disable comment with reason | iterator rejects |
| C7 | apps/server/src/cli/triage.ts:89 | wp3 | guardErrors | close |
| C10 | apps/server/src/cua/linuxHelperHost/helperBundle.ts:48 | stream/promises pipeline | disable comment with reason (pipeline listens and rejects) | pipeline |
| D1 | packages/shared/src/nodeSqliteWriter.ts:84 | on :135 | guardErrors(new Worker) | failPending |
| D2 | packages/shared/src/nodeSqliteClient.ts:258 | on :308 | guardErrors | stop |
| D3 | packages/shared/src/nodeSqliteClient.ts:511 :723 | attach() :655 | guardErrors with attach's handler | recover |
| D4 | apps/server/src/storage/AuxiliarySqlite.ts:60 | on :62 | guardErrors | receipts.error |

execFile/exec rows (A4 A11 A14 A16-A18 A21 A22 A24 A29) are not migrated: Node's execFile always
attaches its own 'error' listener and no site writes their stdin. The rule (050) does not flag them.
C9 (FileHandle.createReadStream consumed by for await) and C11 (publicProxy pipes, streams created by
B8) need no change.

Coordination: D1-D3 are in packages/shared/src/nodeSqlite*.ts, which thread 2 (reader admission)
edits. At P, check thread 2's PR; if open, wait for it to merge and rebase before touching those files.

## Verification (C)

1. `vp test run packages/shared/src/errorGuards.test.ts` plus the existing test file beside each
   changed source (list from `git diff --name-only`), exit 0.
2. Zero raw sites left: re-run the 001 sweep at P (sites may have been added since) and at C with the
   wp7 rule built locally against this branch (authoritative); the rg sweep in 001 is the fallback.
   Every hit is inside guardErrors/guardChild or carries the disable comment with a reason.
3. `vp run check:changed` exit 0 (large diff: may take long; run alone).
4. PR -> exact-head CI (add `ci:full` label: many packages) -> terra review -> merge-pr.ts.

## wp5 pre-P stale check (terra, /tmp/wp5-stale.md; base origin/dev 1652b968be)

56 rows: 43 unchanged, 10 moved (A26 A27 B14 B14b C2 C3 C4 C5 D2 D3), 2 changed (A13 keeps wp3's
kill filter with a disable comment — IPty is not an EventEmitter type; C7 is now readline.on feeding a
promise), 1 removed (B4: packages/ssh/src/tunnel.ts:402/:468 are remote script text), 0 new sites.
Decisions to carry into wp5 P (coordinator, pending wp5 A):
- F1: `guardChild(child, route, stdioRoute = route)`. A3, A12, A20 keep ignoring stdin EPIPE (the child's
  exit is where that failure is observed — say so in the one-line comment) while the child route ends the run.
- F2: no emitter parameter. Routes that need the emitter close over the const the guard returns
  (`const worker = guardErrors(new Worker(...), (error) => onWorkerError(worker, error))`): 'error' never fires
  synchronously inside the constructor, so the binding is initialized first. A23's post-spawn switch uses a
  `let` forwarder. Handlers defined after creation (D1, D2, A15, B2, B9, B10, B18) are hoisted (pure moves).
- A3 spawnOwnedCommand: `onError` + `onStdioError = () => {}`; callers race `Promise.withResolvers<Error>()`
  against close, removing the nextTick workaround at sshRuntimeAutoUpdate.ts:150-151.

## wp5 P (binding plan for this cycle)

Base: origin/dev 569c115e61 (adds #2424 and #2418 since the stale check; neither touches a 030 row).
Site table: 031_phase3_site_table.md (terra stale check, one rewrite line per row). Helper API:
```ts
export type ErrorRoute = (error: Error) => void;
export function guardErrors<T extends NodeEvents.EventEmitter>(emitter: T, route: ErrorRoute): T;
/** stdioRoute defaults to route; pass a separate one where a stdio failure is observed through the child's exit. */
export function guardChild<T extends NodeChildProcess.ChildProcess>(child: T, route: ErrorRoute, stdioRoute: ErrorRoute = route): T;
```
Rows A3, A12, A20 pass a stdioRoute that ignores stdin errors with a one-line reason (the child's exit
reports them); A6 driverProcess keeps both no-op with its existing reason. Per server-resilience.md an empty
route is allowed only with that one-line reason. Rows needing their emitter close over the returned
const (F2). B4 removed (remote script text). A13 and the async-iteration readlines keep disable-style
comments only in wp7; in wp5 they are left as-is with their existing listeners.
Write scope: NEW packages/shared/src/errorGuards.ts (+ test, + package.json export); every row file in 031
for apps/server/src and packages/*/src. Desktop rows stay for wp6.
Tests: errorGuards.test.ts contract (guarded child stdin EPIPE routes and the process survives; separate
stdioRoute receives stdio errors; guardErrors before first emit). Existing test files beside each changed
source run green; no new per-site tests unless a row's behavior changes (A3's race replacing the nextTick workaround gets a test in its existing file).
Verification: focused tests beside changed files; vp run check:changed (wait for a free slot); PR with
ci:full label (many packages); terra review; merge-pr.ts.

## wp5 A fold (terra NEAR-PASS; binding for B)
- API: `guardChild(child, route, stdinRoute = route)` — stdout, stderr and extra pipes always use `route`;
  only stdin may get the separate (usually no-op, one-line reason) route. A3/A12/A20 pass a stdin no-op.
- Fork-delta files (ClaudeAdapterV2, nodeSqliteClient, DesktopBrowserChannel, triage): wrap the creation
  expression only; hoist only what the route needs.
- PR states the new behavior: rows with no stdout/stderr listener before (A1, A2, A7, A15) now route a read
  error to the child route instead of crashing; A20/C2 have no test file (NOT RUN).
- A3: keep the win32 `await windowsJobCommand(...)`; remove only the POSIX nextTick yield; add a spawn-failure
  case to sshRuntimeAutoUpdate.test.ts (nonexistent command through layerHost.run -> code null, no unhandled
  error) as a regression guard (it cannot fail first on dev because the yield workaround already holds).
