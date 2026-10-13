import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import { exitWithTestParent } from "./testParentLifetime.fixture.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  remoteShell,
  remoteShellCommand,
  makeSuccessfulProcess,
  makeRunningProcess,
  ARCHIVE,
  uploadTarget,
  platform,
  arch,
  encoder,
  nativeScripts,
  installArchivePsDouble,
} from "./tunnel.fixture.ts";

export const protocolExecutable = (
  version: string,
  signals: {
    ssh?: number;
    orchestration?: number;
    missingCommand?: boolean;
    missingComparison?: boolean;
    ownTokens?: string;
    liveTokens?: string;
    descriptor404?: boolean;
    nodeReadiness?: boolean;
    /** Advertise `drainRestart` with a per-start instance id and answer the drain endpoint. */
    drain?: boolean;
    /** Build commit time answered by `__ssh-helper commit-time`; unstamped when absent. */
    commitTime?: number;
  },
  state: string,
) => {
  const helperUrl = new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href;
  // From packages/ssh/src, ../../../apps resolves the repository apps directory.
  return `#!${process.execPath}
(async () => {
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const version = ${JSON.stringify(version)};
const fields = { serverVersion: version,
  ...${JSON.stringify(signals.ssh === undefined ? {} : { sshRuntimeProtocolVersion: signals.ssh })},
  ...${JSON.stringify(signals.orchestration === undefined ? {} : { orchestrationProtocolVersion: signals.orchestration })} };
const home = process.env.HOME;
const state = ${JSON.stringify(state)};
const test = path.join(home, ".test");
const runtimeFile = path.join(home, ".goat/userdata/server-runtime.json");
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i+1]; };
const drainCapable = ${JSON.stringify(signals.drain ?? false)};
const tokenFile = path.join(home, ".goat/userdata/runtime-control.token");
function event(type, extra = {}) { fs.appendFileSync(path.join(test, "events"), JSON.stringify({type, version, ...extra}) + "\\n"); }
if (args[0] === "--version") {
  event("version", { published: fs.existsSync(path.join(state, "run-t3.sh")) ? fs.readFileSync(path.join(state, "run-t3.sh"), "utf8") : "" });
  console.log("goat v" + version);
} else if (args[0] === "__ssh-helper" && args[1] === "protocol") {
  if (${JSON.stringify(signals.missingCommand ?? false)}) process.exit(2);
  const at = args.indexOf("--runtime-file");
  const value = at < 0 ? fields : await (await import(${JSON.stringify(helperUrl)})).readLiveSshRuntimeProtocol(args[at+1], flag("--port-file"), flag("--pid-file"));
  event("protocol", { live: at >= 0, status: value.status });
  if (args.includes("--shell")) {
const injected = at < 0 ? ${JSON.stringify(signals.ownTokens ?? null)} : ${JSON.stringify(signals.liveTokens ?? null)};
if (injected !== null) { console.log(injected); return; }
console.log((value.status ? value.status + " " : "") + [value.serverVersion ?? "unknown",
  value.sshRuntimeProtocolVersion ?? "unknown", value.orchestrationProtocolVersion ?? "unknown",
  value.pid ?? 0, value.port ?? 0].join(" "));
  } else console.log(JSON.stringify(value));
} else if (args[0] === "__ssh-helper" && args[1] === "compare-version") {
  if (${JSON.stringify(signals.missingComparison ?? false)}) process.exit(2);
  const rest = args.slice(2);
  const commitFlag = name => { const at = rest.indexOf(name); return at < 0 ? undefined : Number(rest[at+1]); };
  const [liveVersion, requestedVersion] = rest.filter((value, at) => !value.startsWith("--") && !(rest[at-1] ?? "").startsWith("--"));
  const comparison = (await import(${JSON.stringify(new URL("../../shared/src/semver.ts", import.meta.url).href)})).compareRuntimeBuilds(
    { version: liveVersion, commitTime: commitFlag("--live-commit-time") },
    { version: requestedVersion, commitTime: commitFlag("--requested-commit-time") });
  console.log(comparison === undefined ? "unknown" : comparison < 0 ? "older" : comparison > 0 ? "newer" : "equal");
} else if (args[0] === "__ssh-helper" && args[1] === "commit-time") {
  const commitTime = ${JSON.stringify(signals.commitTime ?? null)};
  if (commitTime === null) process.exit(1);
  console.log(commitTime);
} else if (args[0] === "__ssh-helper" && args[1] === "activity") {
  const value = await (await import(${JSON.stringify(helperUrl)})).readSshServerActivity(Number(args[args.indexOf("--port")+1]), Number(args[args.indexOf("--pid")+1]));
  event("activity", { value }); console.log(value);
} else if (args[0] === "__ssh-helper" && args[1] === "compat") {
  try {
    const value = await (await import(${JSON.stringify(helperUrl)})).readSshRuntimeCompatibility(Number(flag("--port")));
    console.log(value.verdict + " " + (value.drainRestart ? 1 : 0) + " " + (value.instanceId ?? "-"));
  } catch { console.log("unknown 0 -"); process.exitCode = 1; }
} else if (args[0] === "__ssh-helper" && args[1] === "drain") {
  const value = await (await import(${JSON.stringify(helperUrl)})).requestSshRuntimeDrain({
    port: Number(flag("--port")), instanceId: flag("--instance-id"), targetVersion: flag("--target-version"),
    graceSeconds: Number(flag("--grace-seconds")), force: args.includes("--force"), tokenFile: flag("--token-file") });
  event("drain-request", { value, force: args.includes("--force"), grace: Number(flag("--grace-seconds")) }); console.log(value);
} else if (args[0] === "__ssh-helper" && args[1] === "supervise") {
  // Supervised children prove readiness through their descriptor, not the readiness FIFO.
  process.env.FIXTURE_SUPERVISED = "1";
  const result = await (await import(${JSON.stringify(helperUrl)})).superviseSshRuntimeReplacement({
    oldPid: Number(flag("--old-pid")), oldInstanceId: flag("--old-instance-id"), port: Number(flag("--port")),
    baseDir: flag("--base-dir"), stateDir: flag("--state-dir"), runnerFile: flag("--runner"),
    previousRunnerFile: flag("--previous-runner"), targetVersion: flag("--target-version"),
    previousVersion: flag("--previous-version"), identity: flag("--identity"), previousIdentity: flag("--previous-identity"),
    exitTimeoutMs: 10000, readyTimeoutMs: 10000, logFile: flag("--log") });
  event("supervise", { status: result.status });
  fs.writeFileSync(flag("--result"), result.status + " " + (result.pid ?? 0) + " " + (result.version ?? "-") + "\\n");
} else if (args[0] === "__ssh-helper" && args[1] === "pick-port") {
  const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => {
const port = socket.address().port; socket.close(() => console.log(port));
  });
} else if (args[0] === "__ssh-helper" && args[1] === "wait-ready") {
  // Fixture readiness uses an event, not polling or a delay.
  let record = fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile, "utf8")) : null;
  if (!record || !fs.existsSync(path.join(test, "accepted-ready-" + record.pid))) {
const fd = fs.openSync(path.join(test, "ready.fifo"), "r");
fs.readSync(fd, Buffer.alloc(32), 0, 32, null); fs.closeSync(fd);
record = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
fs.writeFileSync(path.join(test, "accepted-ready-" + record.pid), "ready");
  }
  const req = http.get("http://127.0.0.1:" + args[2] + "/", res => {
res.resume(); res.on("end", () => process.exit(res.statusCode === 200 ? 0 : 1));
  }); req.on("error", () => process.exit(1));
} else if (args[0] === "auth") {
  event("auth", { args });
  if (fs.existsSync(path.join(test, "pairing-fail"))) process.exit(2);
  if (args.includes("--runtime-mode-ceiling") && fs.existsSync(path.join(test, "reject-ceiling"))) process.exit(2);
  console.log(JSON.stringify(args[1] === "pairing" ? {credential: version} : {token: version, expiresAt: null}));
} else if (args[0] === "serve") {
  ${exitWithTestParent('args.includes("--test-seed") || process.env.T3_TEST_SEED === "1"')}
  if (fs.existsSync(path.join(test, "fail-start-" + version))) { event("failed-start"); process.exit(3); }
  const at = args.indexOf("--port"); const requested = at < 0 ? 0 : Number(args[at+1]);
  const instanceId = drainCapable ? require("node:crypto").randomUUID() : undefined;
  const descriptor = {environmentId: "fixture", label: "Fixture", platform: {os: "linux", arch: "x64"},
    capabilities: drainCapable ? {drainRestart: true} : {}, ...fields, ...(instanceId ? {instanceId} : {})};
  const stopSelf = () => {
    if (fs.existsSync(runtimeFile) && JSON.parse(fs.readFileSync(runtimeFile, "utf8")).pid === process.pid) fs.unlinkSync(runtimeFile);
    server.close(() => process.exit(0)); server.closeAllConnections();
  };
  const server = http.createServer((req, res) => {
res.setHeader("content-type", "application/json");
if (req.method === "POST" && req.url === "/.well-known/goat/runtime/drain" && drainCapable) {
  let body = ""; req.on("data", c => { body += c; }); req.on("end", () => {
    const request = JSON.parse(body);
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    if (req.headers["x-goat-runtime-control"] !== token) { res.statusCode = 403; res.end("{}"); return; }
    if (request.expectedInstanceId !== instanceId) { res.end(JSON.stringify({status: "instance-changed", instanceId, forced: false})); return; }
    const file = path.join(test, "drain");
    const mode = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "drained";
    const status = mode === "cancelled" && request.force !== true ? "cancelled" : "drained";
    event("drain", { status, targetVersion: request.targetVersion, force: request.force === true, grace: request.graceSeconds });
    res.end(JSON.stringify({status, instanceId, forced: status === "drained" && mode === "cancelled"}), () => { if (status === "drained") { event("self-stop"); stopSelf(); } });
  });
  return;
}
if (["/.well-known/goat/environment", "/.well-known/t3/environment"].includes(req.url) && (${JSON.stringify(signals.descriptor404 ?? false)} || fs.existsSync(path.join(test, "descriptor404")))) {
  res.statusCode = 404; res.end("{}"); return;
}
if (["/.well-known/goat/activity", "/.well-known/t3/activity"].includes(req.url)) {
  const file = path.join(test, "activity");
  const values = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(",") : ["unknown"];
  const countFile = path.join(test, "activity-requests");
  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
  fs.writeFileSync(countFile, String(count+1));
  const activity = values[Math.min(count, values.length-1)];
  if (activity !== "idle" && activity !== "busy") { res.statusCode=404; res.end("{}"); return; }
  const pidFile = path.join(test, "activity-pid");
  const activityPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : process.pid;
  res.end(JSON.stringify({activity, serverVersion: version, pid: activityPid})); return;
}
res.end(["/.well-known/goat/environment", "/.well-known/t3/environment"].includes(req.url) ? JSON.stringify(descriptor) : "ok");
  });
  process.on("SIGTERM", () => {
event("stop");
if (fs.existsSync(runtimeFile) && JSON.parse(fs.readFileSync(runtimeFile, "utf8")).pid === process.pid) fs.unlinkSync(runtimeFile);
server.close(() => process.exit(0));
  });
  server.listen(requested, "127.0.0.1", () => {
const record = {version: 1, pid: process.pid, port: server.address().port,
  origin: "http://127.0.0.1:" + server.address().port, startedAt: new Date().toISOString(), ...fields, ...(instanceId ? {instanceId} : {})};
fs.mkdirSync(path.dirname(runtimeFile), {recursive: true}); fs.writeFileSync(runtimeFile, JSON.stringify(record));
if (drainCapable) fs.writeFileSync(tokenFile, "fixture-token-" + process.pid + "\\n", {mode: 0o600});
fs.appendFileSync(path.join(test, "pids"), process.pid + "\\n");
event("start", { runner: fs.readFileSync(path.join(state, "run-t3.sh"), "utf8") });
if (args.includes("--test-seed") || process.env.T3_TEST_SEED === "1") {
  fs.writeFileSync(path.join(test, "accepted-ready-" + process.pid), "ready");
  console.log(JSON.stringify(record));
}
else if (process.env.FIXTURE_SUPERVISED === "1") fs.writeFileSync(path.join(test, "accepted-ready-" + process.pid), "ready");
else if (!${JSON.stringify(signals.nodeReadiness ?? false)}) { const fd = fs.openSync(path.join(test, "ready.fifo"), "w"); fs.writeSync(fd, "ready\\n"); fs.closeSync(fd); }
  });
} else process.exit(97);
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
};

export const makeProtocolFixture = Effect.fn("test.protocol.fixture")(function* (input: {
  live: boolean;
  kind: "managed" | "external";
  oldVersion: string;
  ssh?: number;
  orchestration?: number;
  missingCommand?: boolean;
  missingComparison?: boolean;
  ownTokens?: string;
  liveTokens?: string;
  descriptor404?: boolean;
  nodeMode?: boolean;
  /** The live server drains for a replacement (servers before #119 do not). */
  drain?: boolean;
  /** Commit time of the installed old build; unstamped when absent. */
  commitTime?: number;
  candidateSignals?: { ssh: number; orchestration: number; drain?: boolean; commitTime?: number };
}) {
  const fs = yield* FileSystem.FileSystem;
  const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-protocol-" });
  const key = REMOTE_RUNTIME_STATE_KEY;
  const state = `${home}/.goat/ssh-launch/${key}`;
  const test = `${home}/.test`;
  const old = `${home}/.goat/runtime/goat/versions/${input.oldVersion}`;
  const cache = `${home}/cache`;
  for (const dir of [state, test, old, cache]) yield* fs.makeDirectory(dir, { recursive: true });
  // Node-mode launches pick a port from the production default (3773). Parallel test files and
  // concurrent CI jobs on one host would race for it, so start this fixture's pick at its own
  // reserved port. The shim only rewrites that argument; argv0 stays "node" for ps checks.
  const pickPort = yield* NetService.make().reserveLoopbackPort();
  const portShim = `${test}/port-shim`;
  yield* fs.makeDirectory(portShim);
  yield* fs.writeFileString(
    `${portShim}/node`,
    `#!/bin/bash
if [ "$#" -eq 4 ] && [ "$1" = - ] && [ "\${2##*/}" = port ] && [ "$3" = 3773 ] && [ "$4" = 200 ]; then
  printf '%s\\n' "$3" >> "$HOME/.test/pick-port-defaults"
  set -- "$1" "$2" ${pickPort} "$4"
fi
exec -a node '${process.execPath.replaceAll("'", "'\\''")}' "$@"
`,
  );
  yield* fs.chmod(`${portShim}/node`, 0o700);
  const inherited = process.env.PATH ?? "";
  // Insert the shim where the inherited PATH starts, so test-provided bins still win and
  // tests that replace PATH entirely (e.g. "/usr/bin:/bin") are untouched.
  const withPortShim = (path: string) =>
    inherited !== "" && path.endsWith(inherited)
      ? path.slice(0, path.length - inherited.length) + `${portShim}:${inherited}`
      : path;
  yield* fs.writeFileString(`${test}/events`, "");
  // A ready modern fixture has no work; tests can explicitly make activity busy or unavailable.
  yield* fs.writeFileString(`${test}/activity`, "idle");
  yield* fs.writeFileString(`${test}/pids`, "");
  const fifo = yield* realSpawner.spawn(ChildProcess.make("mkfifo", [`${test}/ready.fifo`]));
  assert.equal(Number(yield* fifo.exitCode), 0);
  yield* fs.writeFileString(`${old}/goat`, protocolExecutable(input.oldVersion, input, state));
  yield* fs.chmod(`${old}/goat`, 0o700);
  yield* fs.writeFileString(`${old}/.install-complete`, input.oldVersion + "\n");
  const nodeEntry = `${home}/old dev's entry.cjs`;
  if (input.nodeMode)
    yield* fs.writeFileString(
      nodeEntry,
      protocolExecutable(input.oldVersion, { ...input, nodeReadiness: true }, state),
    );
  const oldRunner =
    (yield* nativeScripts(
      input.nodeMode ? { nodeScriptPath: nodeEntry } : { archiveVersion: input.oldVersion },
    )).runner + "\n";
  yield* fs.writeFileString(`${state}/run-t3.sh`, oldRunner);
  yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
  yield* Effect.addFinalizer(() =>
    fs.readFileString(`${test}/pids`).pipe(
      Effect.flatMap((data) =>
        Effect.sync(() => {
          for (const pid of data.trim().split("\n").filter(Boolean).map(Number)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* captured fixture child already exited */
            }
          }
        }),
      ),
      Effect.ignore,
    ),
  );
  let pid = 0;
  let port = 0;
  if (input.live) {
    const nodePort = input.nodeMode ? yield* NetService.make().reserveLoopbackPort() : 0;
    const child = yield* realSpawner.spawn(
      ChildProcess.make(
        input.nodeMode ? process.execPath : `${old}/goat`,
        input.nodeMode
          ? [
              nodeEntry,
              "serve",
              "--host",
              "127.0.0.1",
              "--port",
              String(nodePort),
              "--base-dir",
              `${home}/.goat`,
            ]
          : ["serve", "--test-seed"],
        {
          env: {
            HOME: home,
            PATH: process.env.PATH ?? "",
            ...(input.nodeMode ? { T3_TEST_SEED: "1" } : {}),
          },
          extendEnv: false,
        },
      ),
    );
    const ready = JSON.parse(
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.mkString,
      ),
    ) as { pid: number; port: number };
    assert.equal(ready.pid, Number(child.pid));
    pid = ready.pid;
    port = ready.port;
    if (!input.nodeMode) yield* installArchivePsDouble(home, pid, port, input.oldVersion);
    yield* fs.writeFileString(`${state}/pid`, `${pid}\n`);
    yield* fs.writeFileString(`${state}/port`, `${port}\n`);
    yield* fs.writeFileString(`${state}/managed`, input.kind + "\n");
    if (input.kind === "managed")
      yield* fs.writeFileString(
        `${state}/identity`,
        `${old}/goat serve --host 127.0.0.1 --port ${port} --base-dir ${home}/.goat\n`,
      );
  }
  const stem = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}`;
  const stage = `${home}/stage/${stem}`;
  yield* fs.makeDirectory(stage, { recursive: true });
  yield* fs.writeFileString(
    `${stage}/goat`,
    protocolExecutable(
      ARCHIVE.archiveVersion,
      input.candidateSignals ?? {
        ssh: SSH_RUNTIME_PROTOCOL_VERSION,
        orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        drain: true,
      },
      state,
    ),
  );
  yield* fs.chmod(`${stage}/goat`, 0o700);
  const packed = yield* realSpawner.spawn(
    ChildProcess.make("tar", ["-czf", `${cache}/${stem}.tar.gz`, "-C", `${home}/stage`, stem]),
  );
  assert.equal(Number(yield* packed.exitCode), 0);
  const crypto = yield* Crypto.Crypto;
  const sha = Hex.encode(
    yield* crypto.digest("SHA-256", yield* fs.readFile(`${cache}/${stem}.tar.gz`)),
  );
  yield* fs.writeFileString(`${cache}/${stem}.tar.gz.sha256`, `${sha}  ${stem}.tar.gz\n`);
  const runner = { ...ARCHIVE, archiveDirectory: cache };
  const retainedPrepared: SshTunnel.PreparedRemoteRuntime = {
    runner: {
      ...runner,
      archiveVersion: input.oldVersion,
      refreshOwnedRuntimeOnFirstConnection: true,
    },
    version: input.oldVersion,
    requestedVersion: ARCHIVE.archiveVersion,
    source: "retained",
    requireInstalled: true,
    mayUpgradeOwnedServer: true,
    retainedRunnerSha256: Hex.encode(yield* crypto.digest("SHA-256", encoder.encode(oldRunner))),
    refreshIfIdle: true,
    expectedLiveVersion: input.oldVersion,
  };
  const remoteCommands: ChildProcess.Command[] = [];
  let uploads = 0;
  let gh = 0;
  let cacheReads = 0;
  const observedFs = FileSystem.FileSystem.of({
    ...fs,
    exists: (file) => {
      if (file.startsWith(cache)) cacheReads++;
      return fs.exists(file);
    },
    readFile: (file) => {
      if (file.startsWith(cache)) cacheReads++;
      return fs.readFile(file);
    },
    readFileString: (file) => {
      if (file.startsWith(cache)) cacheReads++;
      return fs.readFileString(file);
    },
  });
  let remotePath = `${home}/.test/identity-bin:${process.env.PATH ?? ""}`;
  const setRemotePath = (value: string) => {
    remotePath = value;
  };
  let scriptPrefix = "";
  const setScriptPrefix = (value: string) => {
    scriptPrefix = value;
  };
  let beforeCommand: ((script: string) => ReturnType<typeof fs.writeFileString>) | undefined;
  const setBeforeCommand = (callback: typeof beforeCommand) => {
    beforeCommand = callback;
  };
  const fixtureScope = yield* Scope.Scope;
  const remoteSpawn = (command: ChildProcess.Command) =>
    realSpawner.spawn(command).pipe(Effect.provideService(Scope.Scope, fixtureScope));
  const transport = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") return remoteSpawn(command);
    if (command.command === "gh") {
      gh++;
      return Effect.die("unexpected gh acquisition");
    }
    const at = command.args.indexOf("sh");
    if (at < 0) {
      if (command.args.includes("-G"))
        return Effect.succeed(
          makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n"),
        );
      if (command.args.includes("-N")) return Effect.succeed(makeRunningProcess(() => undefined));
      return Effect.die("Unexpected test transport command; real SSH is prohibited");
    }
    remoteCommands.push(command);
    const args = command.args.slice(at + 1).filter((arg) => arg !== "-l");
    if (args.includes("-c")) uploads++;
    // Capture actual submitted bytes; inject races only at an observed command boundary.
    return Effect.gen(function* () {
      const stdin = command.options.stdin;
      if (
        args.includes("-c") ||
        stdin === undefined ||
        typeof stdin !== "object" ||
        !("stream" in stdin) ||
        !Stream.isStream(stdin.stream)
      ) {
        return yield* remoteSpawn(
          ChildProcess.make(remoteShell, ["-c", [remoteShellCommand, ...args].join(" ")], {
            env: { HOME: home, PATH: withPortShim(remotePath), LC_ALL: "C" },
            extendEnv: false,
            ...(stdin === undefined ? {} : { stdin }),
          }),
        );
      }
      const script = yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString);
      if (beforeCommand !== undefined) yield* beforeCommand(script);
      return yield* remoteSpawn(
        ChildProcess.make(remoteShell, ["-c", [remoteShellCommand, ...args].join(" ")], {
          env: { HOME: home, PATH: withPortShim(remotePath), LC_ALL: "C" },
          extendEnv: false,
          stdin: { ...stdin, stream: Stream.make(new TextEncoder().encode(scriptPrefix + script)) },
        }),
      );
    });
  });
  const run = (
    entry: "launch" | "pairing" | "mcp",
    secondary = false,
    options: SshTunnel.RemoteGoatRunnerOptions = {},
    prepared?: SshTunnel.PreparedRemoteRuntime,
  ) => {
    const inputRunner = { ...runner, ...options, keepExistingRunner: secondary };
    const action =
      entry === "launch"
        ? SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, inputRunner).pipe(
            Effect.map((result) => ({
              status: result.status,
              pending: result.pending,
              version:
                result.status === "ready"
                  ? result.selectedRuntime.version
                  : result.pending.liveVersion,
              port: result.status === "ready" ? result.remotePort : 0,
              refresh: result.status === "ready" ? result.refresh : undefined,
            })),
          )
        : entry === "pairing"
          ? SshTunnel.issueRemotePairingToken(uploadTarget, {}, inputRunner, prepared).pipe(
              Effect.map((result) => ({
                status: "ready" as const,
                pending: undefined,
                version: result.credential,
                port: 0,
                refresh: undefined,
              })),
            )
          : SshTunnel.issueRemoteMcpClientSession(
              uploadTarget,
              { label: "fixture", ttl: "1h", runtimeModeCeiling: null },
              {},
              inputRunner,
              prepared,
            ).pipe(
              Effect.map((result) => ({
                status: "ready" as const,
                pending: undefined,
                version: result.token,
                port: 0,
                refresh: undefined,
              })),
            );
    return action.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, transport),
      Effect.provideService(FileSystem.FileSystem, observedFs),
      Effect.result,
    );
  };
  const snapshot = Effect.gen(function* () {
    const files = ["run-t3.sh", "pid", "port", "managed", "identity"];
    const values: Record<string, string | null> = {};
    for (const file of files)
      values[file] = (yield* fs.exists(`${state}/${file}`))
        ? yield* fs.readFileString(`${state}/${file}`)
        : null;
    const runtime = `${home}/.goat/userdata/server-runtime.json`;
    values.runtime = (yield* fs.exists(runtime)) ? yield* fs.readFileString(runtime) : null;
    values.oldExecutable = yield* fs.readFileString(`${old}/goat`);
    values.oldMarker = yield* fs.readFileString(`${old}/.install-complete`);
    return values;
  });
  return {
    home,
    state,
    test,
    old,
    nodeEntry,
    pickPort,
    withPortShim,
    pid,
    port,
    run,
    snapshot,
    fs,
    realSpawner,
    setBeforeCommand,
    setScriptPrefix,
    setRemotePath,
    counters: () => ({ uploads, gh, cacheReads }),
    remoteCommands,
    transport,
    runner,
    observedFs,
    retainedPrepared,
  };
});
