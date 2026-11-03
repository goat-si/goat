# Survey: unheard 'error' emitters (EPIPE class) — GOAT server, runtime packages, desktop main

Base: origin/dev 55a3236c86 (A1 ScreenRunSupervisor stdin fix merged in #2417). Read-only survey; one Node probe run (below).
Process column: **S** long-running GOAT server · **X** helper/child process GOAT spawns (Linux CUA helper, screen-run child) · **L** service launcher (`goat service` supervisor) · **C** short-lived CLI subcommand · **D** desktop Electron main.

Packages covered (server runtime imports from apps/server/package.json): shared, ssh, provider-core, provider-acp, provider-acp-registry, provider-claude-cloud, provider-cursor, provider-devin-cloud, provider-fx, provider-grok, provider-muse, provider-opencode, provider-pi, tailscale, source-control-{core,github,gitlab,forgejo,gitcafe,bitbucket,azure-devops,definitions}, effect-acp, effect-codex-app-server (transitive), contracts (no emitters). client-runtime: desktop dependency only; its 3 `new WebSocket` sites are browser/RN EventTarget sockets, not imported by apps/server. Excluded: provider-testing, source-control-testing, *.test.ts, *.testkit.ts, fixtures, testing/, testkit/, testUtils/, scripts/.

Key probe (node v26.12.1): readline.createInterface({input}) re-emits the input's 'error' on the Interface; with no rl 'error' listener it is an uncaught exception **even when the input stream has its own listener** (`UNCAUGHT boom` in both variants). Readlines consumed by async iteration are safe (iterator listens for 'error').

execFile note: node's execFile always attaches its own child 'error' handler (callback or not) and never writes stdin, so execFile/promisify(execFile) rows are safe. spawnSync/execFileSync are synchronous (n/a).

## A. child_process (raw)

| id | path:line | API | emitter(s) | verdict | cleanup today | risk |
|---|---|---|---|---|---|---|
| A1 | apps/server/src/screenCode/ScreenRunSupervisor.ts:160 | spawn | child, stdin (writes :201 :381 :512), stdout, stderr | child once error :194; **stdin MISSING on dev**, fixed here :195-196 (stdin.on error -> onProcessEnd) | onProcessEnd -> abortActive + close (SIGKILL, lost) | S — the reported crash; fixed in this branch |
| A2 | apps/server/src/channels/imessage/imessageSender.ts:46 | spawn | child, stdin(end script :102) | child once error :83; stdin once error :80 | finish unknown/not_sent | S |
| A3 | apps/server/src/cloud/sshRuntimeAutoUpdate.ts:158 | spawn (spawnOwnedCommand) | child, stdin(end :192) | child once error :115 :283; stdin on error :191 | resolve null/empty | S |
| A4 | apps/server/src/cloud/sshRuntimeGitBash.ts:109 | execFile | child | execFile internal + cb :118 | undefined | S (win32) |
| A5 | apps/server/src/cloud/sshRuntimeWindowsJob.ts:187 | spawn stdio ignore | child | once error :199 | resolve failure | S (win32) |
| A6 | apps/server/src/cua/driverProcess.ts:20 (helper spawnDriverProcess) | spawn | child, stdin | child.on error :26; stdin.on error :27 | noop; consumers handle exit | S/C — used by BrowserDriverCapabilityProbe.ts:28 (adds :42 :43), LinuxHelperHost.ts:675, ComputerUseLeaseProxyCli.ts:386 |
| A7 | apps/server/src/memory/imports/MemoryImportReaderSupport.ts:104 | spawn | child, stdin(end() no data :114) | child.on error :135; stdin no listener but no data written (probe: silent) | fail source_unreadable | S |
| A8 | apps/server/src/opencodex/ChildOpenCodexStartup.ts:64 | spawn stdio ignore/log fd | child | once error :70 | reject | S |
| A9 | apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:391 | spawn /bin/sh group, fd3 pipe | child, stdin, stdout, fd3 | handed to Claude Agent SDK: processStdin.on error + process.once error (claude-agent-sdk sdk.mjs:127); fd3 never written | SDK transport failure -> turn error; exit :402 kills group | S (residual: SDK 'error' is once; signal abort emits 'error') |
| A10 | apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1012 | spawn (win32) | child, stdin, stdout, stderr(data :1019) | same SDK listeners (sdk.mjs:127) | same | S (win32) |
| A11 | apps/server/src/provider/DocumentText.ts:66 | execFile | child | execFile internal + cb | reject | S |
| A12 | apps/server/src/provider/acp/AntigravityClientFiles.ts:229 | spawn | child, stdin(end :258) | once error :254; stdin.on error :257 | Effect.fail | S |
| A13 | apps/server/src/terminal/NodePtyAdapter.ts:258 | node-pty spawn | pty socket | **MISSING**: node-pty rethrows any socket error except EAGAIN/EIO unless the terminal has its own 'error' listener (node_modules/.pnpm/node-pty@1.2.0-beta.15_*/node_modules/node-pty/lib/unixTerminal.js:101-127, :206-209); adapter attaches none (only Windows readiness socket.once error :128) | throw -> uncaught | S — low probability, whole server |
| A14 | packages/provider-core/src/server/windowsTaskkill.ts:24 | execFile | child | execFile internal | — | S (win32) |
| A15 | packages/shared/src/cuaDriverManifest.ts:555 | spawn | child, stdin(write :580) | on error :581; stdin.on error :584 | finish(error) | S |
| A16 | packages/shared/src/cuaDriverManifest.ts:714 | execFile | child | execFile internal | — | S |
| A17 | packages/shared/src/shell.ts:348 | execFile | child | execFile internal | — | S/D (:161 :295 execFileSync n/a) |
| A18 | packages/shared/src/macosGit.ts:12 | execFile | child | execFile internal | — | S |
| A19 | packages/provider-muse/src/server/sdk.ts:158 | @muse-code/sdk spawnMspConnection | child, stdin | SDK stdin.on error (…/@muse-code/sdk/dist/src/connection/spawn.js:182), child.once error (:185) | SDK reject | S (residual: child 'error' once) |
| A20 | apps/server/src/cua/linuxHelper/CuaDriverMcp.ts:84 | spawn | child, stdin(write :115, end :143), stdout(readline) | once error :91; stdin.on error :93; readline see C2 | resolve gone | X (Linux CUA helper, spawned via LinuxHelperHost.ts:675) |
| A21 | apps/server/src/cua/linuxHelper/atspiFocus.ts:456 | execFile | child | execFile internal | — | X |
| A22 | apps/server/src/cua/linuxHelper/gnomeVersion.ts:16 | execFile | child | execFile internal | — | X |
| A23 | apps/server/src/serviceLauncher.ts:788 | spawn inherit+ipc | child | once error :797; on error :800 | enqueue reject; exit :819 | L |
| A24 | apps/server/src/serviceLauncher.ts:168 | execFile cp | child | execFile internal | — | L |
| A25 | apps/server/src/cli/sshRuntimeSupervisor.ts:291 | spawn ignore/log fd | child | once error :298 | resolve false | C (remote-host supervisor; :156 spawnSync n/a) |
| A26 | apps/server/src/cli/triage.ts:120 | spawn inherit | child | once error :126 | Effect.fail | C |
| A27 | apps/server/src/cli/uninstall.ts:82 (spawnWindowsRemoval) | spawn detached ignore | child | **MISSING** (caller :231 only .unref()) | spawn failure (bad COMSPEC) -> uncaught | C (`goat uninstall`, win32) |
| A28 | apps/server/src/cua/ComputerUseLeaseProxyCli.ts:386 | spawnDriverProcess | child, stdin(write :446, end :463), stdout(readline) | via driverProcess.ts:26-27; readline see C3 | exit :395 | C (cua-lease-proxy, lives per thread) |
| A29 | apps/server/src/cua/ComputerUseLeaseProxyCli.ts:813 | execFile | child | execFile internal + cb :824 | resolve | C |
| A30 | apps/server/src/urlOpener/urlOpenerCli.ts:201 | spawn ignore | child | once error :211 | exit code | C |
| A31 | apps/desktop/src/permissions/MacSettingsWindow.ts:106 | spawn | child, stdout(data :116) | on error :136 | onExit | D |
| A32 | apps/desktop/src/snapShot/ActiveWindow.ts:83 | execFile | child | execFile internal | — | D |
| A33 | apps/desktop/src/snapShot/HyprlandSnapShot.ts:52 | execFile | child | execFile internal | — | D |
| A34 | apps/desktop/src/snapShot/MacSnapShot.ts:24 | execFile | child | execFile internal | — | D |
| A35 | apps/desktop/src/snapShot/KdeSnapShot.ts:48 | execFile | child | execFile internal | — | D |
| A36 | apps/desktop/src/cua/appIcons.ts:33 | execFile | child | execFile internal | — | D |
| A37 | apps/desktop/src/snapShot/CaptureShortcutConfig.ts:23 | promisify(execFile) | child | execFile internal | reject | D |
| A38 | apps/desktop/src/cua/ComputerUseHelperInstall.ts:253 | promisify(execFile) | child | execFile internal | reject | D |
| A39 | apps/desktop/src/snapShot/SnapShotAccessibilityProcess.ts:51 | fork ipc | child, IPC | once error :112; send with cb :92 | finish | D |
| A40 | apps/desktop/src/snapShot/MacModifierPairShortcutProcess.ts:41 | spawn | child, stderr(data :68) | once error :85 | stop | D |
| A41 | apps/desktop/src/snapShot/RegionSnapShot.ts:34 | fork ipc | child, IPC | once error :44 (registered by onExit :98); send() without cb :40 :115 | finish | D (residual: a 2nd 'error', e.g. send on closed channel after the once fired, is unheard) |
| A42 | apps/desktop/src/snapShot/NativeCaptureFeedback.ts:22 | spawn | child, stdin(write :101) | stdin.on error :50; once error :51 | close | D |
| A43 | apps/desktop/src/snapShot/GlobalShiftShortcutProcess.ts:14 | fork ipc | child | once error :54 | reject | D |
| A44 | apps/desktop/src/cua/McpHelperHost.ts:31 | spawn | child, stdin, stdout | once error :41; stdin/stdout on error in StdioMcpClient.ts:137-138 | io_error | D |
| A45 | apps/desktop/src/cua/agentRouteProbe.ts:88 | spawn | child, stdout | on error :127 | settle failed | D (:64 is probe-script text with :65 :67 listeners) |
| A46 | apps/desktop/src/cua/ComputerUseHelper.ts:147 | spawn | child, stdin | once error :153; stdin.on error :156 | resolve null | D |
| A47 | apps/desktop/src/cua/ComputerUseHelper.ts:161 | spawn | child, stdin(write :380), stdout(readline :303) | once error :167; stdin.on error :171; readline see C8 | resolve null | D |

Not counted (n/a): spawnSync/execFileSync at sshRuntimeSupervisor.ts:156, DeviceService.ts:604, shell.ts:165 :303, DesktopPreReadyPlatform.ts:137. Script text executed elsewhere: device/AgentDeviceShim.ts:37, device/sshDeviceScript.ts:183, device/deviceToolMaintenance.ts:70, packages/provider-pi/src/server/mcpExtensionSource.ts:323 (runs inside Pi's process; writes stdin :367 with no stdin listener — would crash Pi, not GOAT).
Category-wide residual: raw children whose stdout/stderr pipes have only 'data' listeners (A2 A7 A15 A31 A40 …) would crash on a pipe *read* error; such errors are rare on Unix pipes, not counted as MISSING.

## B. ws / net / tls / http (raw)

| id | path:line | API | emitter(s) | verdict | cleanup today | risk |
|---|---|---|---|---|---|---|
| B1 | apps/server/src/hubProxy/http.ts:375 | ws WebSocket via Socket.makeWebSocket | ws | on error noop :384 (comment :383 documents the Effect gap) | Effect SocketError | S |
| B2 | packages/shared/src/Net.ts:49 :87 :141 | net server/connection probes | server, socket | once error :60 :102 :150 | resolve false/retry | S |
| B3 | packages/shared/src/codexAuthCallback.ts:39 | http.createServer | server | once error :79 (kept while listening) | reject | S |
| B4 | packages/ssh/src/tunnel.ts:414 :427 | net server / connect | server, socket | once error :416 :437 | resolve false | S |
| B5 | apps/server/src/provider/CodexManagedTokenBroker.ts:129 | net.createServer | server, sockets | socket.on error noop :130; server.on error noop :186 | destroy | S |
| B6 | apps/server/src/provider/CodexChatGptAuth.ts:481 | http.createServer | server | once error :494 | reject | S |
| B7 | apps/server/src/provider/antigravityCallback.ts:76 | http.request | request, incoming | once error :95, :87 | Effect.fail | S |
| B8 | apps/server/src/htmlRender/publicProxy.ts:129 :165 | net server + upstream connect, pipe :178-179 | server, client, upstream | server.on error :188; track() on error->destroy :126 for client and upstream (:164) | destroy | S |
| B9 | apps/server/src/cloud/ConnectReachability.ts:180 | net.connect | socket | once error :187 | false | S |
| B10 | apps/server/src/environment/DirectEndpoints.ts:99 | net.connect | socket | once error :113 | false | S |
| B11 | apps/server/src/cua/CuaDisplayCapability.ts:455 :492 | net.createConnection | socket | once error :458 :498 | unreachable/false | S |
| B12 | apps/server/src/cua/x11WindowPlacement.ts:126 | net.createConnection | socket | connection() on error :66 | fail waiters | S |
| B13 | apps/server/src/cua/CuaDbusProbe.ts:189 | net.createConnection | socket | once error :219 | answered false | S |
| B14 | apps/server/src/bootstrap.ts:216 | new net.Socket({fd}) | socket | stream.once error :140 — but read through readline, see C1 | — | S |
| B15 | apps/server/src/cua/linuxHelper/atspiFocusEvents.ts:283 | net.createConnection | socket | on error :418 | fail | X |
| B16 | apps/server/src/cua/linuxHelper/x11WindowCapture.ts:348 | net.createConnection | socket | connection() on error :246 | fail | X |
| B17 | apps/server/src/cua/linuxHelper/humanInputSource.ts:276 | net.createConnection | socket | on error :298 | close | X |
| B18 | apps/server/src/serviceLauncher.ts:540 | http.get | request, response | request on error :578; response on error :552 | finish | L |
| B19 | apps/server/src/cli/app.ts:117 | net.createConnection | socket | once error :179 | reject/fallback | C |
| B20 | apps/server/src/cli/sshHelper.ts:16 :27 :63 | net server/connect, http.get | server, socket, request | once error :18 :37 :77 | false | C |
| B21 | apps/server/src/cli/sshRuntimeProbes.ts:61 :142 :382 :568 | http.get/request, net | request, response, socket | request once error :96 :417 :607; socket :153; response once error :80 :398 :588 | finish | C |
| B22 | apps/server/src/cli/managedChatGptToken.ts:26 | net.createConnection | socket | on error noop :29 | destroy | C |
| B23 | apps/desktop/src/app/DesktopAppActivation.ts:178 | net.createServer | server, sockets | socket.on error :169; **server once error :187 is removed at :184 after listen -> listening server has no listener: MISSING (low)** | accept error (EMFILE) -> uncaught | D |
| B24 | apps/desktop/src/snapShot/NiriSnapShot.ts:65 | net.createConnection | socket | on error :88 | close | D |

Not counted: apps/server/src/outboundHttp.ts:44 patches Socket.prototype.setTypeOfService (guard, not an emitter); client-runtime/src/device/stream.ts:1099 :1183 and preview/serverBrowserStream.ts:298 (browser/RN EventTarget WebSocket, onerror :1177 — EventTarget never throws on unheard errors).

## C. fs streams / readline / zlib / pipe

| id | path:line | API | emitter(s) | verdict | cleanup today | risk |
|---|---|---|---|---|---|---|
| C1 | apps/server/src/bootstrap.ts:92 | readline over fd stream (createReadStream :183 :210 or Socket :216) | rl, stream | **MISSING**: stream.once error :140 only; rl has line/close listeners :141-142, no 'error' -> readline re-emits stream error (probe) | uncaught | S — server startup bootstrap read (it expects fd errors, see isUnavailableBootstrapFdError :106) |
| C2 | apps/server/src/cua/linuxHelper/CuaDriverMcp.ts:101 | readline on child.stdout | rl | **MISSING** (only 'line') | uncaught | X |
| C3 | apps/server/src/cua/ComputerUseLeaseProxyCli.ts:399 | readline on driver stdout | rl | **MISSING** (line :402, close via :408) | uncaught | C (cua-lease-proxy) |
| C4 | apps/server/src/cua/ComputerUseLeaseProxyCli.ts:757 | readline over process.stdin | rl | Stream.fromAsyncIterable (iterator listens 'error') + catchCause :759 | stream ends | C |
| C5 | apps/server/src/mcp/AcpMcpStdioBridge.ts:492 | readline over input | rl | Stream.fromAsyncIterable :493 | bridgeError | C |
| C6 | apps/server/src/screenCode/ScreenRunChild.ts:98 | readline over stdin | rl | asyncIterator :99 | rejects | X (screen-run child) |
| C7 | apps/server/src/cli/triage.ts:89 | readline/promises over stdin/stdout | rl | **MISSING (low)** | uncaught | C (interactive) |
| C8 | apps/desktop/src/cua/ComputerUseHelper.ts:303 | readline on helper stdout | rl | **MISSING** (line :304, close :325) | uncaught | D |
| C9 | apps/server/src/usage/usageTranscriptReader.ts:257 (+ compose zstd :264) | FileHandle.createReadStream | stream | consumed by for await :265 (rejects) | Effect failure | S |
| C10 | apps/server/src/cua/linuxHelperHost/helperBundle.ts:48 | createReadStream -> stream/promises pipeline | stream, hash | pipeline rejects | reject | S |
| C11 | apps/server/src/htmlRender/publicProxy.ts:178-179 | .pipe both directions | client, upstream | both tracked with on error :126 | destroy | S |

Not counted: zlib sync/crc only (ThreadHistoryArchive.ts:357 :401, linuxSession.ts:326, x11WindowCapture.ts:210 :222, desktop preview/Manager.ts:336). Effect-wrapped streams in E.

Audit additions (A phase): apps/server/src/cli/consoleStdin.ts:56 `new NodeTty.ReadStream(fd)` (Windows
console stdin, no listener — C12, S on win32); apps/server/src/bootstrap.ts:183 :210 createReadStream
(errors via C1); apps/server/src/server.ts:398 NodeHttp.createServer (Effect NodeHttpServer listens);
preview/DesktopBrowserChannel.ts:111 and resourceTelemetry/DesktopTelemetryReceiver.ts:580
`new NodeNet.Socket({fd})` in acquireRelease; apps/desktop/src/app/DesktopAppActivation.ts:252
NodeFS.watch (listener :255).

## D. worker_threads / utilityProcess / process stdio

| id | path:line | API | emitter(s) | verdict | cleanup today | risk |
|---|---|---|---|---|---|---|
| D1 | packages/shared/src/nodeSqliteWriter.ts:84 | Worker | worker | on error :135 | failPending | S |
| D2 | packages/shared/src/nodeSqliteClient.ts:258 | Worker | worker | on error :308 | stop | S |
| D3 | packages/shared/src/nodeSqliteClient.ts:511 :723 | Worker (checkpoint) | worker | attach() on error :655-656, called :761 and :737 | recover | S |
| D4 | apps/server/src/storage/AuxiliarySqlite.ts:60 | Worker | worker | on error :62 | receipts.error | S |
| D5 | apps/desktop/src/electron/WindowsForegroundFocusThread.ts:78 | Worker | worker | once error :102 | reset | D |
| D6 | apps/server/src/cli/server.ts:83-84 | process.stdout/stderr | stdio | on error ignoreClosedLauncherPipe (EPIPE, ERR_STREAM_DESTROYED; rethrows others) :42-43 | ignore | S (`goat serve`/desktop backend; attached inside runServerCommand, so pre-command writes are unguarded) |
| D7 | apps/desktop/src/main.ts:3-6 | process.stdout/stderr | stdio | on error, EPIPE ignored | ignore | D |
| D8 | CLI stdout/stderr writes: ComputerUseLeaseProxyCli.ts:774, sshRuntimeSupervisor.ts:218 :424, AcpMcpStdioBridge.ts:508, urlOpenerCli.ts:225-226, managedChatGptToken.ts:41 :45, sshHelper.ts:52, ssh/tunnel.ts:445 | process.stdout/stderr | stdio | **MISSING (low)**: no stdio 'error' listener | EPIPE -> that subprocess exits 1 | C only |

Electron utilityProcess: no sites in apps/desktop/src.

## E. Effect-managed sites ("Effect handles")

Spot-checks (node_modules/.pnpm):
- ChildProcessSpawner: @effect+platform-node-shared@4.0.5_*/…/src/NodeChildProcessSpawner.ts:397 handle.on("error"); :88-92 handleInputErrors keeps a noop stdin 'error' listener until close; :285 :351 :362 stdout/stderr on error -> passThrough.destroy. **Confirmed.**
- NodeHttpServer: @effect+platform-node@4.0.5_*/…/src/NodeHttpServer.ts:135 server.on("error"); :310 socket.on("error", () => {}). Confirmed.
- NodeStream.fromReadable: platform-node-shared …/src/NodeStream.ts:397 readable.once("error") (removed :426 on completion). Confirmed.
- NodeSocket (net): platform-node-shared …/src/NodeSocket.ts:118 :259 :445 conn.on("error"). Confirmed.
- **Gap**: effect@4.0.5 src/socket/Socket.ts:1071 adds the WebSocket 'error' listener with {once:true} and :1079 removes it in the scope finalizer. With a ws-library WebSocket (EventEmitter), a later 'error' (e.g. closed while CONNECTING) is unheard -> crash. hubProxy/http.ts:384 patches this. platform-node …/src/NodeSocket.ts:45-53 layerWebSocketConstructor uses globalThis.WebSocket (undici EventTarget, safe) unless headers are passed (Socket.ts:909-911 -> makeWebSocketWS). DeviceHubProxy.ts:96 passes no headers -> safe today; any future caller passing headers or using layerWebSocketConstructorWS needs the hubProxy guard.

Files using Effect ChildProcessSpawner (one-line verdict: Effect handles): apps/server — assets/NativeAppIconResolver, cli/browser, cloud/ConnectReachability, cloud/ManagedEndpointRuntime, cua/CuaDisplayCapability, cua/CuaDriver, cua/CuaDriverInstallation, device/LocalDeviceHost, device/SshDeviceHost, environment/DirectEndpoints, environment/RemoteOpenTargets, fleet/goals/GoalWorkerRuntime, htmlRender/HtmlRender, htmlRender/headlessChrome, opencodex/CodexReadyProbe, orchestration-v2/Adapters/{ClaudeAdapterV2,CodexAdapterV2}, preview/{PreviewBrowserHost,ServerBrowser}, process/externalLauncher, processRunner, provider/{AntigravityInstallation,ClaudeProvider,CodexInstallation,CodexProvider,OpenCodexRoute,ProviderDiagnosis,ProviderDiagnosisService,ProviderHostSync,antigravityAuthSupport,providerMaintenanceRunner}, provider/Drivers/{AntigravityDriver,ClaudeAuth,ClaudeCloudDriver,ClaudeDriver,CodexDriver,CodexManagedHomeProvider,CodexManagedProvider}, provider/acp/AntigravityAcpSupport, resourceTelemetry/{HostResources,NativeTelemetryClient}, server, sshRemote/{SshHostSetup,dispatchFailure}, textGeneration/{ClaudeMemoryIsolation,ClaudeTextGeneration,CodexTextGeneration}, vcs/{GitVcsDriver,GitVcsDriverCore,VcsProcess}. packages — effect-acp (_internal/stdio, client), effect-codex-app-server (_internal/stdio, client), provider-acp-registry (AcpRegistrySupport, adapter, auth, driver, probe), provider-acp (AcpSessionRuntime, adapter, clientTerminals), provider-claude-cloud (cli, sessionRead), provider-core (maintenanceResolver, snapshotProbe, providerLoginTerminal via pty), provider-devin-cloud (cli, driver, relay), provider-fx, provider-grok, provider-muse/driver, provider-opencode (OpenCodeRuntime, OpenCodeServerLedger, driver), provider-pi (adapter, driver, rpc, status, textGeneration), shared/relayClient, source-control-core/SourceControlHost, source-control-forgejo/ForgejoCli, ssh (appServer, command, hostKey, master, preflightProcess, remoteSessions, runtimeArchiveGh, tunnel), tailscale (tailscale, tailscaleExecutable). apps/desktop — app/{DesktopCliCommand,DesktopLinuxUrlHandler,DesktopSafeStorageSiblingKeys}, backend/{DesktopBackendManager,DesktopBackendPool,DesktopBackendProcess,DesktopHeadlessServer,DesktopServerExposure,tailscaleEndpointProvider}, preview/BrowserImport/{BrowserImport,ChromiumCookies,ChromiumKeys,Sources}, shell/DesktopShellEnvironment, ssh/DesktopSshEnvironment, wsl/DesktopWslEnvironment.
Effect socket/http/stream: server.ts:395 (NodeHttpServer + guardHttpResponseWriteErrors), cloud/CliTokenManager.ts:541, device/DeviceHubProxy.ts:96 (see gap note), preview/DesktopBrowserChannel.ts:111 :150 (NodeStream.fromReadable, NodeSocketServer.makeWebSocket), resourceTelemetry/DesktopTelemetryReceiver.ts:580, preview/ServerBrowserStream.ts, assets/MediaFile.ts:124, wsIdleTimeout.ts, httpResponseErrorGuard.ts.

## Counts

| category | raw rows | MISSING | MISSING in long-running server (S) |
|---|---|---|---|
| A child_process | 47 | 3 (A1 fixed in branch, A13, A27) | A1 (fixed), A13 |
| B ws/net/http | 24 | 1 (B23, low) | 0 |
| C streams/readline | 11 | 5 (C1, C2, C3, C7, C8) | C1 |
| D worker/stdio | 8 | 1 (D8, low, CLI only) | 0 |
| **total** | **90** | **10** (9 open) | **3** (2 open: C1, A13) |
By process: S 3 (A1 fixed, A13, C1) · X 1 (C2) · D 2 (B23, C8) · C 4 (A27, C3, C7, D8).

Reconciliation with parent's "~15 server files spawn / 3 create websockets": apps/server/src has exactly 15 files with raw async spawn/fork — imessageSender, sshRuntimeSupervisor, triage, uninstall, sshRuntimeAutoUpdate, sshRuntimeWindowsJob, driverProcess, CuaDriverMcp, MemoryImportReaderSupport, ChildOpenCodexStartup, ClaudeAdapterV2, AntigravityClientFiles, serviceLauncher, urlOpenerCli, ScreenRunSupervisor (+7 execFile/spawnSync-only files and 3 script-text files). Server WebSocket creation sites are 3: hubProxy/http.ts:375 (raw ws, guarded), device/DeviceHubProxy.ts:96 (Effect + globalThis.WebSocket), preview/DesktopBrowserChannel.ts:150 (Effect server). The 3 raw `new WebSocket` in client-runtime are client-side.

## Wrapper candidates

- Child processes: existing `spawnDriverProcess` (apps/server/src/cua/driverProcess.ts:10-27: child.on error + stdin.on error noop) and Effect's handleInputErrors (NodeChildProcessSpawner.ts:88-92) are the shape. A shared `spawnGuarded` in packages/shared (child 'error', stdin 'error', optional stdout/stderr 'error' routed to one onEnd) would cover A1 (now inline), A27, and give the raw A-rows one pattern. Existing Effect helpers: processRunner.ts:296, process/externalLauncher.ts:270 :739, vcs/VcsProcess.ts:277, sshRuntimeAutoUpdate.ts spawnOwnedCommand :158.
- readline: a `readLines(stream, onLine, onError)` helper that always sets rl.on("error") — or prefer async iteration / Stream.fromAsyncIterable as ScreenRunChild.ts:99 and AcpMcpStdioBridge.ts:493 do. Covers C1, C2, C3, C7, C8.
- WebSocket: hoist hubProxy/http.ts:374-384 (constructor wrapper adding socket.on("error", noop)) into a shared guarded ws constructor layer; required for any makeWebSocket caller that passes headers or uses layerWebSocketConstructorWS.
- node-pty: attach an 'error' listener on the IPty in NodePtyAdapter after spawn (check node-pty's `listeners('error').length < 2` rule, unixTerminal.js:125, before choosing how many).
- net servers: keep a permanent server.on("error") after listen (DesktopAppActivation.ts:184 removes it).
- CLI stdio: reuse cli/server.ts ignoreClosedLauncherPipe (:42) for long-lived CLI subprocesses (cua-lease-proxy, acp-mcp-bridge).

## Last-resort net

- Server entry: apps/server/src/bin.ts:15-80 dispatches fast paths (incl. __screen-run-child :56, cua-lease-proxy :62, acp-mcp-bridge :59) and otherwise the full CLI, which runs under NodeRuntime.runMain at apps/server/src/binCli.ts:152; `goat serve` is cli/server.ts:46 runServerCommand.
- No process.on("uncaughtException"|"unhandledRejection") in apps/server or apps/desktop (rg). Only packages/provider-cursor/src/server/CursorSdk.ts:74 adds a scoped unhandledRejection handler. Effect NodeRuntime installs only SIGINT/SIGTERM (platform-node-shared …/src/NodeRuntime.ts:77-78). So any unheard 'error' ends the server with exit 1.
- Desktop supervision: backend spawned through Effect ChildProcessSpawner (apps/desktop/src/backend/DesktopBackendProcess.ts:322); on exit DesktopBackendManager.ts:615 finalizeRun -> scheduleRestart :629 with restartDelayMs backoff :645 (DesktopBackendRecoveryPolicy) and a recovery budget makeRecoveryBudget :194 that pauses on crash loops (DesktopBackendRecovery.ts:20 pause "crash-loop"). A crash therefore restarts the backend after backoff, but in-flight turns/sessions are lost.
- Standalone service: serviceLauncher.ts:788 supervises the server child (exit handler :819; restart policy not verified in this survey).

