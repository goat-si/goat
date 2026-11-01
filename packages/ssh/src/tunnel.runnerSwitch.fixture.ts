import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import {
  exitWithTestOwner,
  exitWithTestParent,
  killGroupWithTestOwner,
  TEST_OWNER_FILE,
} from "./testParentLifetime.fixture.ts";
import {
  remoteShell,
  ARCHIVE,
  platform,
  arch,
  encoder,
  nativeScripts,
  installArchivePsDouble,
} from "./tunnel.fixture.ts";

export const stateKey = REMOTE_RUNTIME_STATE_KEY;
export const oldVersion = "1.2.2-preview.20260910.1";
export const nextVersion = ARCHIVE.archiveVersion;

export const shell = Effect.fn("test.runnerSwitch.shell")(function* (
  home: string,
  script: string,
  args: string[] = [],
  pathValue: string = `${home}/.test/identity-bin:${process.env.PATH ?? ""}`,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    killGroupWithTestOwner(
      ChildProcess.make(remoteShell, ["-s", "--", ...args], {
        env: { HOME: home, PATH: pathValue, LC_ALL: "C" },
        extendEnv: false,
        stdin: { stream: Stream.make(encoder.encode(script)), endOnDone: true },
      }),
    ),
  );
  return yield* Effect.all(
    {
      stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      code: child.exitCode.pipe(Effect.map(Number)),
    },
    { concurrency: "unbounded" },
  );
});

// Written into the old runtime and the tiny release archive. This is a
// behavioral double for the executable, not a duplicate of the installer.
const executable = (version: string) => `#!${process.execPath}
(async () => {
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const home = process.env.HOME;
const fixture = path.join(home, ".test");
const version = ${JSON.stringify(version)};
const config = JSON.parse(fs.readFileSync(path.join(fixture, "config.json"), "utf8"));
const state = path.join(home, ".goat/ssh-launch/${stateKey}");
const runtimeFile = path.join(home, ".goat/userdata/server-runtime.json");
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function event(type, extra = {}) {
  fs.appendFileSync(path.join(fixture, "events"), JSON.stringify({ type, version, ...extra }) + "\\n");
}
function runtime() { try { return JSON.parse(fs.readFileSync(runtimeFile, "utf8")); } catch { return null; } }
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i+1]; };
const tokenFile = path.join(home, ".goat/userdata/runtime-control.token");
if (args[0] === "--version") {
  let runner = "";
  try { runner = fs.readFileSync(path.join(state, "run-t3.sh"), "utf8"); } catch {}
  const old = runtime();
  event("version", { runner, oldAlive: Boolean(old && alive(old.pid)) });
  console.log("goat v" + version);
} else if (args[0] === "__ssh-helper") {
  if (args[1] === "protocol") {
const flag = name => {const at = args.indexOf(name); return at < 0 ? undefined : args[at+1];};
const value = args.includes("--runtime-file") ? await (await import(${JSON.stringify(new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href)})).readLiveSshRuntimeProtocol(flag("--runtime-file"), flag("--port-file"), flag("--pid-file")) : {serverVersion:version,sshRuntimeProtocolVersion: version === ${JSON.stringify(nextVersion)} || config.compatible ? ${SSH_RUNTIME_PROTOCOL_VERSION} : 99,orchestrationProtocolVersion:${ORCHESTRATION_PROTOCOL_VERSION}};
console.log((value.status ? value.status+" " : "") + [value.serverVersion ?? "unknown",value.sshRuntimeProtocolVersion ?? "unknown",value.orchestrationProtocolVersion ?? "unknown",value.pid ?? 0,value.port ?? 0].join(" "));
  } else if (args[1] === "compare-version") {
const rest = args.slice(2);
const commitFlag = name => { const at = rest.indexOf(name); return at < 0 ? undefined : Number(rest[at+1]); };
const [liveVersion, requestedVersion] = rest.filter((value, at) => !value.startsWith("--") && !(rest[at-1] ?? "").startsWith("--"));
const comparison = (await import(${JSON.stringify(new URL("../../shared/src/semver.ts", import.meta.url).href)})).compareRuntimeBuilds(
  { version: liveVersion, commitTime: commitFlag("--live-commit-time") },
  { version: requestedVersion, commitTime: commitFlag("--requested-commit-time") });
console.log(comparison === undefined ? "unknown" : comparison < 0 ? "older" : comparison > 0 ? "newer" : "equal");
  } else if (args[1] === "activity") {
console.log(await (await import(${JSON.stringify(new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href)})).readSshServerActivity(Number(args[args.indexOf("--port")+1]), Number(args[args.indexOf("--pid")+1])));
  } else if (args[1] === "compat") {
  try {
    const value = await (await import(${JSON.stringify(new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href)})).readSshRuntimeCompatibility(Number(flag("--port")));
    console.log(value.verdict + " " + (value.drainRestart ? 1 : 0) + " " + (value.instanceId ?? "-"));
  } catch { console.log("unknown 0 -"); process.exitCode = 1; }
  } else if (args[1] === "drain") {
  const value = await (await import(${JSON.stringify(new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href)})).requestSshRuntimeDrain({
    port: Number(flag("--port")), instanceId: flag("--instance-id"), targetVersion: flag("--target-version"),
    graceSeconds: Number(flag("--grace-seconds")), force: args.includes("--force"), tokenFile: flag("--token-file") });
  event("drain-request", { value, force: args.includes("--force"), grace: Number(flag("--grace-seconds")) }); console.log(value);
  } else if (args[1] === "supervise") {
  // Supervised children prove readiness through their descriptor, not the readiness FIFO.
  process.env.FIXTURE_SUPERVISED = "1";
  const result = await (await import(${JSON.stringify(new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href)})).superviseSshRuntimeReplacement({
    oldPid: Number(flag("--old-pid")), oldInstanceId: flag("--old-instance-id"), port: Number(flag("--port")),
    baseDir: flag("--base-dir"), stateDir: flag("--state-dir"), runnerFile: flag("--runner"),
    previousRunnerFile: flag("--previous-runner"), targetVersion: flag("--target-version"),
    previousVersion: flag("--previous-version"), identity: flag("--identity"), previousIdentity: flag("--previous-identity"),
    exitTimeoutMs: 10000, readyTimeoutMs: 10000, logFile: flag("--log") });
  event("supervise", { status: result.status });
  fs.writeFileSync(flag("--result"), result.status + " " + (result.pid ?? 0) + " " + (result.version ?? "-") + "\\n");
  } else if (args[1] === "runtime-port") {
const current = runtime();
if (!config.publishDefault || !current || !alive(current.pid)) process.exit(1);
console.log(current.pid + " " + current.port);
  } else if (args[1] === "pick-port") {
const socket = net.createServer();
socket.listen(0, "127.0.0.1", () => {
  const port = socket.address().port;
  socket.close(() => console.log(port));
});
  } else if (args[1] === "wait-ready") {
let current = runtime();
const accepted = current && (current.pid === config.seedPid ||
  fs.existsSync(path.join(fixture, "accepted-ready-" + current.pid)));
if (!current || !alive(current.pid) || !accepted) {
  // The new serve command writes only after listening; no test sleeps.
  const fd = fs.openSync(path.join(fixture, "ready.fifo"), "r");
  fs.readSync(fd, Buffer.alloc(32), 0, 32, null);
  fs.closeSync(fd);
  current = runtime();
  if (current) fs.writeFileSync(path.join(fixture, "accepted-ready-" + current.pid), "ready");
}
if (!current || Number(args[2]) !== current.port) process.exit(1);
const request = http.get("http://127.0.0.1:" + current.port + "/", response => {
  response.resume();
  response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
});
request.on("error", () => process.exit(1));
  } else process.exit(2);
} else if (args[0] === "auth" && args.includes("--help")) {
  // Like current builds, these runtimes can issue memory scopes.
  console.log("  --scope choice  (choices: memory:read, memory:write, orchestration:read)");
} else if (args[0] === "auth") {
  event("auth", { args });
  if (args[1] === "pairing") console.log(JSON.stringify({ credential: "fixture-pairing" }));
  else console.log(JSON.stringify({ token: "fixture-session", expiresAt: null }));
} else if (args[0] === "serve") {
  ${exitWithTestParent('args.includes("--test-seed")')}
  ${exitWithTestOwner("fixture")}
  const requested = args.indexOf("--port");
  const port = requested < 0 ? 0 : Number(args[requested + 1]);
  const fields = {serverVersion:version,sshRuntimeProtocolVersion:version === ${JSON.stringify(nextVersion)} || config.compatible ? ${SSH_RUNTIME_PROTOCOL_VERSION} : 99,orchestrationProtocolVersion:${ORCHESTRATION_PROTOCOL_VERSION}};
  const instanceId = require("node:crypto").randomUUID();
  const server = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/.well-known/goat/runtime/drain") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const input = JSON.parse(body);
        if (request.headers["x-goat-runtime-control"] !== fs.readFileSync(tokenFile, "utf8").trim()) { response.statusCode = 403; response.end("{}"); return; }
        if (input.expectedInstanceId !== instanceId) { response.end(JSON.stringify({status:"instance-changed",instanceId,forced:false})); return; }
        event("drain");
        response.end(JSON.stringify({status:"drained",instanceId,forced:false}), () => {
          event("self-stop");
          if (runtime()?.pid === process.pid) fs.unlinkSync(runtimeFile);
          server.close(() => process.exit(0)); server.closeAllConnections();
        });
      });
      return;
    }
    response.end(["/.well-known/goat/activity", "/.well-known/t3/activity"].includes(request.url) ? JSON.stringify({activity:config.activity ?? "idle", serverVersion:version, pid:process.pid}) : ["/.well-known/goat/environment", "/.well-known/t3/environment"].includes(request.url) ? JSON.stringify({environmentId:"fixture",label:"Fixture",platform:{os:"linux",arch:"x64"},capabilities:{drainRestart:true},instanceId,...fields}) : "ok");
  });
  process.on("SIGTERM", () => {
event("stop");
if (runtime()?.pid === process.pid) fs.unlinkSync(runtimeFile);
server.close(() => process.exit(0));
  });
  server.listen(port, "127.0.0.1", () => {
const record = { instanceId, version:1, startedAt:"2026-10-11T00:00:00.000Z", ...fields, pid: process.pid, port: server.address().port,
  origin: "http://127.0.0.1:" + server.address().port };
fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
fs.writeFileSync(runtimeFile, JSON.stringify(record));
fs.writeFileSync(tokenFile, "fixture-token-" + process.pid, {mode:0o600});
fs.appendFileSync(path.join(fixture, "pids"), process.pid + "\\n");
const installed = fs.existsSync(path.join(state, "run-t3.sh"))
  ? fs.readFileSync(path.join(state, "run-t3.sh"), "utf8") : "";
const marker = path.join(home, ".goat/runtime/goat/versions", version, ".install-complete");
event("start", { installed, complete: fs.readFileSync(marker, "utf8").trim() });
if (args.includes("--test-seed")) console.log(JSON.stringify(record));
else if (process.env.FIXTURE_SUPERVISED === "1") fs.writeFileSync(path.join(fixture, "accepted-ready-" + process.pid), "ready");
else {
  const fd = fs.openSync(path.join(fixture, "ready.fifo"), "w");
  fs.writeSync(fd, "ready\\n");
  fs.closeSync(fd);
}
  });
} else process.exit(2);
})().catch(error => {console.error(error);process.exitCode=1;});
`;

export const fixture = Effect.fn("test.runnerSwitch.fixture")(function* (
  failure: "none" | "missing-release" | "bad-checksum" | "broken-executable" | "wrong-version",
  options: {
    seed?: boolean;
    identical?: boolean;
    publishDefault?: boolean;
    compatible?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-switch-" });
  const state = `${home}/.goat/ssh-launch/${stateKey}`;
  const previous = options.identical ? nextVersion : oldVersion;
  const oldRuntime = `${home}/.goat/runtime/goat/versions/${previous}`;
  const test = `${home}/.test`;
  yield* fs.makeDirectory(state, { recursive: true });
  yield* fs.makeDirectory(test, { recursive: true });
  yield* fs.writeFileString(`${test}/${TEST_OWNER_FILE}`, String(process.pid));
  yield* fs.writeFileString(`${test}/events`, "");
  yield* fs.writeFileString(`${test}/pids`, "");
  const upstream = `${home}/.t3/runtime/versions/${previous}`;
  yield* fs.makeDirectory(upstream, { recursive: true });
  yield* fs.writeFileString(`${upstream}/t3`, "upstream executable sentinel\n");
  yield* fs.writeFileString(`${upstream}/.install-complete`, `${previous}\n`);
  yield* fs.writeFileString(
    `${test}/config.json`,
    JSON.stringify({
      publishDefault: options.publishDefault !== false,
      compatible: options.compatible === true,
    }),
  );
  const fifo = yield* spawner.spawn(ChildProcess.make("mkfifo", [`${test}/ready.fifo`]));
  assert.equal(Number(yield* fifo.exitCode), 0);
  // Register last-created server cleanup before any server is started.
  // Every PID below is emitted by this fixture's executable, not searched.
  yield* Effect.addFinalizer(() =>
    fs.readFileString(`${test}/pids`).pipe(
      Effect.flatMap((data) =>
        Effect.sync(() => {
          for (const pid of data.trim().split("\n").filter(Boolean).map(Number)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* already exited */
            }
          }
        }),
      ),
      Effect.ignore,
    ),
  );
  const mirror = `file://${home}/mirror`;
  const runner = { ...ARCHIVE, releaseBaseUrl: mirror };
  let scripts = yield* nativeScripts(runner);
  const oldScripts = yield* nativeScripts({ archiveVersion: previous, releaseBaseUrl: mirror });
  let oldProcess: ChildProcessSpawner.ChildProcessHandle | null = null;
  if (options.seed !== false) {
    yield* fs.makeDirectory(oldRuntime, { recursive: true });
    yield* fs.writeFileString(`${oldRuntime}/goat`, executable(previous));
    yield* fs.chmod(`${oldRuntime}/goat`, 0o700);
    yield* fs.writeFileString(`${oldRuntime}/.install-complete`, `${previous}\n`);
    yield* fs.writeFileString(`${state}/run-t3.sh`, oldScripts.runner + "\n");
    yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
    oldProcess = yield* spawner.spawn(
      ChildProcess.make(`${oldRuntime}/goat`, ["serve", "--test-seed"], {
        env: { HOME: home, PATH: process.env.PATH ?? "" },
        extendEnv: false,
      }),
    );
    const ready = JSON.parse(
      yield* oldProcess.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.mkString,
      ),
    ) as { pid: number; port: number };
    assert.equal(ready.pid, oldProcess.pid);
    yield* installArchivePsDouble(home, ready.pid, ready.port, previous);
    yield* fs.writeFileString(
      `${test}/config.json`,
      JSON.stringify({
        publishDefault: options.publishDefault !== false,
        compatible: options.compatible === true,
        seedPid: ready.pid,
      }),
    );
    yield* fs.writeFileString(`${state}/pid`, `${ready.pid}\n`);
    yield* fs.writeFileString(`${state}/port`, `${ready.port}\n`);
    yield* fs.writeFileString(`${state}/managed`, "managed\n");
    yield* fs.writeFileString(
      `${state}/identity`,
      `${oldRuntime}/goat serve --host 127.0.0.1 --port ${ready.port} --base-dir ${home}/.goat\n`,
    );
  }
  const stem = `goat-${nextVersion}-${platform}-${arch}`;
  const release = `${home}/mirror/v${nextVersion}`;
  const stage = `${home}/stage/${stem}`;
  yield* fs.makeDirectory(stage, { recursive: true });
  yield* fs.makeDirectory(release, { recursive: true });
  yield* fs.writeFileString(
    `${stage}/goat`,
    failure === "broken-executable"
      ? "#!/bin/sh\nprintf 'wrong architecture\\n' >&2\nexit 95\n"
      : executable(failure === "wrong-version" ? oldVersion : nextVersion),
  );
  yield* fs.chmod(`${stage}/goat`, 0o700);
  const packed = yield* spawner.spawn(
    ChildProcess.make("tar", ["-czf", `${release}/${stem}.tar.gz`, "-C", `${home}/stage`, stem]),
  );
  assert.equal(Number(yield* packed.exitCode), 0);
  const crypto = yield* Crypto.Crypto;
  const sum = Hex.encode(
    yield* crypto.digest("SHA-256", yield* fs.readFile(`${release}/${stem}.tar.gz`)),
  );
  yield* fs.writeFileString(
    `${release}/SHA256SUMS`,
    `${failure === "bad-checksum" ? "0".repeat(64) : sum}  ${stem}.tar.gz\n`,
  );
  if (failure === "missing-release") yield* fs.remove(release, { recursive: true });
  const snapshot = Effect.gen(function* () {
    const files = ["run-t3.sh", "pid", "port", "managed", "identity"];
    const values: Record<string, unknown> = {};
    for (const file of files)
      if (yield* fs.exists(`${state}/${file}`)) {
        values[file] = yield* fs.readFileString(`${state}/${file}`);
      }
    if (yield* fs.exists(`${state}/run-t3.sh`)) {
      const info = yield* fs.stat(`${state}/run-t3.sh`);
      values.runnerMetadata = { ino: info.ino, mode: info.mode, mtime: info.mtime };
    }
    if (yield* fs.exists(oldRuntime)) {
      values.oldExecutable = yield* fs.readFileString(`${oldRuntime}/goat`);
      values.oldMarker = yield* fs.readFileString(`${oldRuntime}/.install-complete`);
      for (const file of ["goat", ".install-complete"]) {
        const info = yield* fs.stat(`${oldRuntime}/${file}`);
        values[`oldMetadata:${file}`] = { ino: info.ino, mode: info.mode, mtime: info.mtime };
      }
    }
    const descriptor = `${home}/.goat/userdata/server-runtime.json`;
    if (yield* fs.exists(descriptor)) values.descriptor = yield* fs.readFileString(descriptor);
    values.upstreamExecutable = yield* fs.readFileString(`${upstream}/t3`);
    values.upstreamMarker = yield* fs.readFileString(`${upstream}/.install-complete`);
    return values;
  });
  const events = fs.readFileString(`${test}/events`).pipe(
    Effect.map((data) =>
      data
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              version: string;
              runner?: string;
              oldAlive?: boolean;
              installed?: string;
              complete?: string;
            },
        ),
    ),
  );
  const cleanCandidates = Effect.gen(function* () {
    assert.deepEqual(
      (yield* fs.readDirectory(state)).filter((name) => name.startsWith("run-t3.next.")),
      [],
    );
  });
  if (options.compatible) {
    const probe = yield* shell(home, scripts.probe);
    assert.equal(probe.code, 0, probe.stderr);
    const observed = JSON.parse(probe.stdout);
    assert.equal(observed.retainedSignals.sshRuntimeProtocolVersion, SSH_RUNTIME_PROTOCOL_VERSION);
    const selectedRunner = { ...runner, archiveVersion: previous };
    scripts = yield* nativeScripts(selectedRunner, {
      runner: selectedRunner,
      version: previous,
      requestedVersion: nextVersion,
      source: "retained",
      requireInstalled: true,
      mayUpgradeOwnedServer: false,
      retainedRunnerSha256: observed.retainedRunnerSha256,
    });
  }
  return { home, state, runner, scripts, oldProcess, snapshot, events, cleanCandidates, fs };
});
