# wp5 site table, refreshed against origin/dev 1652b968be (+ wp4 commit a4e706d32a, which touched none of these files)

Method: working tree == origin/dev for every file below (git diff --name-only origin/dev lists only wp4's
cli/server.ts, CursorSdk*, shared package.json, processErrorNet*, server-resilience.md). Line numbers from rg.
Status: U unchanged, M moved (same listener/route), C changed (table text is stale), X remove.
Notation: gE = guardErrors(<create>, route), gC = guardChild(<spawn>, route[, stdioRoute]) — see design flag F1.

## Design flags for wp5 P (decide before B)

F1 (blocker for the 030 helper as written): guardChild(child, route) puts ONE route on the child and every stdio
stream. Several rows deliberately treat stdin errors as benign while the child route ends/fails the run:
A3 (:191 stdin noop vs :115 resolve failure), A6 (both noop — fine), A12 (:257 stdin noop vs :254 Effect.fail),
A20 (:93 stdin noop vs :91 resolve "exited" — a stdin EPIPE would mark a live driver gone), A1 uses the same route
for both (fine), A2 both finish (fine), A15 both finish(error) (fine). Proposal:
guardChild(child, route, stdioRoute = route) — a second route for the piped stdio streams.
F2: routes that need the emitter itself or a later-defined handler (D3 attach(candidate), A23 two-phase, D1/D2 handler
defined after creation): give ErrorRoute a second parameter, (error, emitter) => void, and hoist handlers (pure moves)
where they only reference earlier state; a let-forwarder only for A23.
F3: B4 is not server code — packages/ssh/src/tunnel.ts:402 is REMOTE_PICK_PORT_SCRIPT, a template string run on the
remote host (it also contains http.get at :468). Remove the row; the lint rule cannot see template text.
F4: once -> on: every route below is idempotent (settled/done flags, Promise/Effect resume, flag writes, kill of an
already-killed group) except A23's post-spawn route, which enqueues one rejection per error (already 'on' today, so no
behavior change). Kill routes (A13 pty.kill, C2 kill, C3 killDriverGroup SIGKILL) may run twice: harmless (swallowed).

## A — child processes

| row | path:line now | listener today (path:line) | st | rewrite |
|---|---|---|---|---|
| A1 | apps/server/src/screenCode/ScreenRunSupervisor.ts:160 | child once :194, stdin on :196 (same onProcessEnd) | U | const child = gC(NodeChildProcess.spawn(command, [...args], {...}), onProcessEnd) — hoist onProcessEnd above :160 (it only calls session.abortActive/close; session must be declared first: use a forwarder or move session creation) |
| A2 | apps/server/src/channels/imessage/imessageSender.ts:46 | stdin once :80, child once :83 (both finish, done-guarded) | U | child = gC((input.spawnProcess ?? NodeChildProcess.spawn)(...), () => finish({ outcome: started ? "unknown" : "not_sent", code: "unknown" })) — finish/started declared before :46 (move :58-63 up) |
| A3 | apps/server/src/cloud/sshRuntimeAutoUpdate.ts:158 (factory :143) | callers: collect once :115, stdin on noop :191, detached once :283 | U | spawnOwnedCommand(command, args, options, signal, onError: ErrorRoute, onStdioError: ErrorRoute = () => {}) and child: gC(NodeChildProcess.spawn(...), onError, onStdioError); caller :173 passes (e) => spawnFailure.resolve(e) with const spawnFailure = Promise.withResolvers<Error>() created before the call, and collect() races close vs spawnFailure.promise; caller :260 passes (e) => spawnFailure.resolve(e) and the :282 promise also resolves null on it. This also removes the nextTick race the :150-151 comment works around. |
| A5 | apps/server/src/cloud/sshRuntimeWindowsJob.ts:187 | once :199 (failedToStart = true) | U | const compiler = gC(NodeChildProcess.spawn(...), () => { failedToStart = true; }) — declare failedToStart before :187 |
| A6 | apps/server/src/cua/driverProcess.ts:20 | child on noop :26, stdin on noop :27 | U | const child = gC(NodeChildProcess.spawn(...), ignoreDriverError) + one-line reason (consumers observe exit/close) |
| A7 | apps/server/src/memory/imports/MemoryImportReaderSupport.ts:104 | child on :135 (failed = true) | U | child = gC(NodeChildProcess.spawn(...), () => { failed = true; }) — move let failed above :104 |
| A8 | apps/server/src/opencodex/ChildOpenCodexStartup.ts:64 | once :70 (reject) | U | const child = gC(NodeChildProcess.spawn(input.binaryPath, ["start"], {...}), reject) |
| A9 | apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:391 | none own; SDK processStdin.on + process.once (claude-agent-sdk sdk.mjs:127) | U | const child = gC(NodeChildProcess.spawn("/bin/sh", [...], {...}), ignoreSdkOwnedError) + reason (SDK transport reports; exit :402 kills the group) |
| A10 | ClaudeAdapterV2.ts:1012 (win32) | stderr data :1019; SDK listeners | U | same as A9 |
| A12 | apps/server/src/provider/acp/AntigravityClientFiles.ts:229 | child once :254 (resume fail), stdin on noop :257 | U | const child = gC(NodeChildProcess.spawn(...), (cause) => resume(Effect.fail(cause)), ignoreStdinError) — needs F1 |
| A13 | apps/server/src/terminal/NodePtyAdapter.ts:275 | nativeProcess.on :284 endPtyOnSocketError (wp3) | C | table says "node-pty self-close"; route is now kill-on-rethrown-code. IPty does expose on() (forwarded to its socket). gE(nodePty.spawn(...), endPtyOnSocketError(...)) cannot typecheck on IPty -> keep wp3 listener + oxlint-disable with reason; the rule cannot resolve node-pty here anyway (createRequire loader, NodePtyAdapter.ts:33-36) |
| A15 | packages/shared/src/cuaDriverManifest.ts:555 | child on :581, stdin on :584 (finish, settled-guarded) | U | const child = gC(NodeChildProcess.spawn(...), (error) => finish(error)) — finish is a const defined after :555: hoist finish/timer (pure move) or forwarder |
| A20 | apps/server/src/cua/linuxHelper/CuaDriverMcp.ts:84 | exited once :91 (resolve), stdin on noop :93 | U | const child = gC(NodeChildProcess.spawn(...), () => markExited(), ignoreStdinError) with markExited the exited-promise resolver — needs F1 (a stdin EPIPE must not mark a live driver gone) |
| A23 | apps/server/src/serviceLauncher.ts:788 | once :797 reject before 'spawn', then on :800 enqueue after | U | let onError: ErrorRoute = (e) => startFailure(e); const child = gC(NodeChildProcess.spawn(...), (e) => onError(e)); on 'spawn' set onError = (e) => this.#enqueue(() => Promise.reject(e)) — forwarder (F2) |
| A25 | apps/server/src/cli/sshRuntimeSupervisor.ts:291 | once :298 (resolve false) | U | const child = gC(NodeChildProcess.spawn(runner, args, {...}), () => resolve(false)) |
| A26 | apps/server/src/cli/triage.ts:127 | once :133 (resume TriageAgentSpawnError) | M (:120->:127) | const child = gC(NodeChildProcess.spawn(...), (cause) => resume(Effect.fail(new TriageAgentSpawnError({ command: input.command, cause })))) |
| A27 | apps/server/src/cli/uninstall.ts:83 | on :101 onError (wp3) | M (:82->:83) | const child = gC(NodeChildProcess.spawn(comspec, [...], {...}), onError); return child |
| A30 | apps/server/src/urlOpener/urlOpenerCli.ts:201 | once :211 (clearTimeout; resolve false) | U | const child = gC(NodeChildProcess.spawn(...), () => { clearTimeout(timer); resolve(false); }) — declare timer with let before :201 |

## B — sockets, servers, requests, ws

| row | path:line now | listener today | st | rewrite |
|---|---|---|---|---|
| B1 | apps/server/src/hubProxy/http.ts:375 | on noop :384 (+ reason :383) | U | const socket = gE(new NodeSocket.NodeWS.WebSocket(...), ignoreAfterEffectDetaches) keeping the :383 reason |
| B2 | packages/shared/src/Net.ts:49 :87 :141 | once :60 settle(...) (guarded :52-56), once :102 settle(false), once :150 closeServer+settle | U | gE(NodeNet.createServer(), (cause) => settle(isAddressUnavailable(cause))) / gE(NodeNet.createConnection({ host, port }), () => settle(false)) / gE(NodeNet.createServer(), (cause) => { closeServer(probe); settle(fail) }) — settle is defined after :49/:87/:141: hoist |
| B3 | packages/shared/src/codexAuthCallback.ts:39 | once :79 inside the listen promise (reject) | U | server = gE(NodeHttp.createServer(...), (error) => listenFailure(error)) — listener lives in a later Promise: forwarder resolved by the listen promise, or keep a permanent route that rejects the listen and is a no-op afterwards |
| B4 | packages/ssh/src/tunnel.ts:414 :427 (+ :468) | — | X | remote script text (REMOTE_PICK_PORT_SCRIPT, :402) |
| B5 | apps/server/src/provider/CodexManagedTokenBroker.ts:129 | server on noop :186, listen once :199; per-socket on :130 | U | const server = gE(NodeNet.createServer((socket) => {...}), ignoreBrokerServerError) — keep socket.on at :130 (callback-delivered, not a creation call) and the listen-phase once :199 |
| B6 | apps/server/src/provider/CodexChatGptAuth.ts:481 | once :494 (reject) | U | const server = gE(NodeHttp.createServer(...), reject) |
| B7 | apps/server/src/provider/antigravityCallback.ts:76 | request once :95; incoming once :87 | U | const request = gE(NodeHttp.request(...), () => resume(Effect.fail(failed()))) — incoming stays (not created by us) |
| B8 | apps/server/src/htmlRender/publicProxy.ts:129 :165 | server on :188 (fail before listening); track() on :126 | U | const server = gE(NodeNet.createServer(...), (error) => { if (!listening) resume(Effect.fail(error)); }) (declare listening first); upstream: track(gE(NodeNet.connect({...}), () => upstream.destroy())) or route (_e, socket) => socket.destroy() with F2 |
| B9 | apps/server/src/cloud/ConnectReachability.ts:180 | once :187 finish(false) | U | const socket = gE(NodeNet.connect({ host, port }), () => finish(false)) — hoist finish |
| B10 | apps/server/src/environment/DirectEndpoints.ts:99 | once :113 settle(false) (guarded :105) | U | const socket = gE(NodeNet.connect({...}), () => settle(false)) — hoist settle |
| B11 | apps/server/src/cua/CuaDisplayCapability.ts:455 :492 | once :458 finish("unreachable"), once :498 finish(false) | U | gE(NodeNet.createConnection(socketPath), () => finish("unreachable")) / (..., () => finish(false)) — finish already precedes :455 |
| B12 | apps/server/src/cua/x11WindowPlacement.ts:126 | connection() on :66 (fail) | U | const socket = gE(NodeNet.createConnection(...), ...) needs connection()'s fail: route the error to a forwarder connection() installs, or make connection(socket) the guard (F2) |
| B13 | apps/server/src/cua/CuaDbusProbe.ts:189 | once :219 finish({ answered: false }) | U | const socket = gE(NodeNet.createConnection(socketPath), () => finish({ answered: false })) |
| B14 | apps/server/src/bootstrap.ts:217 | none on stream; errors via readline :141 | M (:216->:217) | const stream = gE(new NodeNet.Socket({...}), ignoreReadThroughReadline) + reason |
| B14b | apps/server/src/bootstrap.ts:184 :211 | none; errors via readline :141 | M | gE(NodeFS.createReadStream("", {...}), ignoreReadThroughReadline) + reason |
| B15 | apps/server/src/cua/linuxHelper/atspiFocusEvents.ts:283 | on :418 fail(error) | U | gE(NodeNet.createConnection({ path }), (error) => fail(error)) — fail defined at :293 after :283: hoist |
| B16 | apps/server/src/cua/linuxHelper/x11WindowCapture.ts:348 | connection() on :246 | U | as B12 |
| B17 | apps/server/src/cua/linuxHelper/humanInputSource.ts:276 | on :298 close | U | gE(NodeNet.createConnection(...), close) — hoist close (:287) |
| B18 | apps/server/src/serviceLauncher.ts:540 | request on :578, response on :552 | U | const request = gE(NodeHttp.get(...), () => finish("request-error")) — hoist finish |
| B19 | apps/server/src/cli/app.ts:117 | once :179 (fallback or finish; settled-guarded) | U | gE(NodeNet.createConnection(input.address.address), onSocketError) with the :179 body as a named const defined first |
| B20 | apps/server/src/cli/sshHelper.ts:16 :27 :63 | once :18 :37 :77 resolve(false) | U | gE(..., () => resolve(false)) ×3 |
| B21 | apps/server/src/cli/sshRuntimeProbes.ts:61 :142 :382 :568 | request once :96 :417 :607, socket once :153, response once :80 :398 :588 | U | gE(NodeHttp.get(...), finish) etc.; response listeners stay |
| B22 | apps/server/src/cli/managedChatGptToken.ts:26 | on noop :29 | U | Effect.sync(() => gE(NodeNet.createConnection(endpoint), destroyOnError)) |
| B25 | apps/server/src/server.ts:398 | guardHttpResponseWriteErrors(NodeHttp.createServer()); NodeHttpServer.ts:135 server.on | U | guardHttpResponseWriteErrors(gE(NodeHttp.createServer(), ignoreUntilEffectListens)) + reason naming NodeHttpServer.ts:135 (verify NodeHttpServer.layer attaches before listen) |
| B26 | apps/server/src/preview/DesktopBrowserChannel.ts:111 | NodeStream.fromReadable once (removed on completion) | U | Effect.sync(() => gE(new NodeNet.Socket({ fd: inputFd, readable: true, writable: false }), ignoreAfterStreamEnds)) + reason: fromReadable fails the stream while reading; after release the socket is destroyed |
| B27 | apps/server/src/resourceTelemetry/DesktopTelemetryReceiver.ts:580 | same | U | same as B26 |
| B28 | apps/server/src/cloud/CliTokenManager.ts:541 | value passed to NodeHttpServer.layer | U | // oxlint-disable-next-line goat/guard-error-emitters -- NodeHttpServer attaches server.on("error") (NodeHttpServer.ts:135) |

## C — readline / fs / tty

| row | path:line now | listener today | st | rewrite |
|---|---|---|---|---|
| C1 | apps/server/src/bootstrap.ts:92 | input.on :141 handleError (wp3) | U | const input = gE(NodeReadline.createInterface({...}), (error) => handleError(error)) — handleError is a const at :105: forwarder arrow (as written) avoids TDZ |
| C2 | apps/server/src/cua/linuxHelper/CuaDriverMcp.ts:131 | on :133 kill | M (:101->:131) | const lines = gE(NodeReadline.createInterface({ input: child.stdout }), kill) |
| C3 | apps/server/src/cua/ComputerUseLeaseProxyCli.ts:402 | on :404 killDriverGroup SIGKILL; iterator :406 also listens | M (:399->:402) | const lines = gE(NodeReadline.createInterface({...}), () => killDriverGroup(platform, child, "SIGKILL")) |
| C4 | apps/server/src/cua/ComputerUseLeaseProxyCli.ts:762 | Stream.fromAsyncIterable | M (:757->:762) | disable comment: async iteration rejects on 'error' |
| C5 | apps/server/src/mcp/AcpMcpStdioBridge.ts:493 | Stream.fromAsyncIterable :494 | M (:492->:493) | disable comment |
| C6 | apps/server/src/screenCode/ScreenRunChild.ts:98 | asyncIterator :99 | U | disable comment |
| C7 | apps/server/src/cli/triage.ts:90 | readline.on :95 -> broken promise (wp3 P3 fold) | M/C | const readline = gE(NodeReadlinePromises.createInterface({...}), (error) => brokenReject(error)) with broken = Promise.withResolvers<never>() created first |
| C10 | apps/server/src/cua/linuxHelperHost/helperBundle.ts:48 | stream/promises pipeline | U | disable comment: pipeline listens and rejects |
| C12 | apps/server/src/cli/consoleStdin.ts:56 | none | U | const stdin = gE(new NodeTty.ReadStream(fd), () => stdin.destroy()) or (_e, s) => s.destroy() with F2 |

## D — worker_threads (thread 2 #2419 merged: b6c764179a)

#2419 changed packages/shared/src/nodeSqliteClient.ts (+35/-?), readerAdmission.ts (new), workerRecovery test;
none of its changed lines touch Worker creation or 'error'/'exit' listeners — rows only moved (+7 lines).

| row | path:line now | listener today | st | rewrite |
|---|---|---|---|---|
| D1 | packages/shared/src/nodeSqliteWriter.ts:84 (inside Effect.try in acquireRelease :81) | on :135 failPending (stopped-guarded), exit :136 | U | gE(new NodeWorkerThreads.Worker(writerWorkerSource, {...}), (cause) => failPending(cause)) — failPending (:124) is defined after creation and uses state declared :111-123: hoist those declarations above :81 (pure move) |
| D2 | packages/shared/src/nodeSqliteClient.ts:265 | on :315 stop(...), init-time onError :231 | M (:258->:265) | gE(new NodeWorkerThreads.Worker(readerWorkerSource, {...}), (cause) => stop(...)) — stop (:285) uses pending/current: hoist (pure move) |
| D3 | packages/shared/src/nodeSqliteClient.ts:518, :730 | attach() :662 (error :663 + exit), called :768 for :518 and :744 for :730 | M (:511/:723->:518/:730) | gE(new NodeWorkerThreads.Worker(checkpointWorkerSource, {...}), (cause, candidate) => onCheckpointError(candidate, cause)) where attach's error body becomes onCheckpointError — needs F2 (route receives the emitter: the body compares candidate === worker); :518's listener is otherwise ~250 lines after creation |
| D4 | apps/server/src/storage/AuxiliarySqlite.ts:60 | on :62 receipts.error | U | const worker = gE(new NodeWorkerThreads.Worker(source, { eval: true, workerData: input }), receipts.error) |

Coordinate D1-D3 with thread 2 (sqlite owners): #2419 is merged; re-check open PRs touching nodeSqlite*.ts at wp5 P.

## Sweep (001 categories) for sites added since the survey

rg over apps/server/src and packages/*/src (excluding tests, testkits, fixtures, testUtils, Harness, scripts) for
child spawn/fork, net/tls/http(s) creation, ws, net.Socket/tty/Worker constructors, fs streams/watch, readline,
node-pty: every hit maps to a row above. Not rows: apps/server/src/device/sshDeviceScript.ts:81 and
packages/ssh/src/tunnel.ts:402-499 (remote script text). New rows: 0.

## Counts

56 table rows: unchanged 43, moved 10 (A26 A27 B14 B14b C2 C3 C4 C5 D2 D3), changed 2 (A13 route/typing, C7 route
shape after wp3 P3), removed 1 (B4 script text), new 0. Design flags: F1 (blocker), F2, F3, F4.

