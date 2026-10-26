import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
// @effect-diagnostics nodeBuiltinImport:off - Loopback servers stand in for the two remote runtimes.
import * as NodeHttp from "node:http";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  remoteShell,
  makeSuccessfulProcess,
  makeRunningProcess,
  TEST_NODE_ENGINE_RANGE,
  testHttpClient,
  testNetService,
  ARCHIVE,
  uploadTarget,
  nativeScripts,
} from "./tunnel.fixture.ts";
import { protocolExecutable, makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const startOwner = (environmentId: string, token: string) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly server: NodeHttp.Server;
      readonly port: number;
      readonly sessions: string[];
    }>((resume) => {
      const sessions: string[] = [];
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/.well-known/goat/environment") {
          response.end(
            JSON.stringify({
              environmentId,
              serverVersion: ARCHIVE.archiveVersion,
              sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
              capabilities: { runtimeSessions: true },
            }),
          );
          return;
        }
        if (request.url === "/.well-known/goat/runtime/session") {
          sessions.push(String(request.headers["x-goat-runtime-control"]));
          response.statusCode = request.headers["x-goat-runtime-control"] === token ? 200 : 403;
          response.end(JSON.stringify({ token: `${environmentId}-session`, expiresAt: null }));
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          Effect.succeed({
            server,
            port: typeof address === "object" && address !== null ? address.port : 0,
            sessions,
          }),
        );
      });
    }),
    ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime protocol selection",
  () => {
    it.live("uses an app sidecar while a managed server remains primary", () =>
      Effect.gen(function* () {
        const fixture = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        let localPort = 41773;
        const net = NetService.NetService.of({
          ...testNetService,
          reserveLoopbackPort: () => Effect.sync(() => localPort++),
        });
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fixture.transport),
          Layer.succeed(FileSystem.FileSystem, fixture.observedFs),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, net),
          SshAuth.SshPasswordPrompt.disabledLayer,
        ).pipe((base) =>
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed({ ...fixture.runner, attachAppServer: true }),
            leaveRemoteServerRunning: true,
          }).pipe(Layer.provideMerge(base)),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const primary = yield* manager.ensureEnvironment(uploadTarget);
          assert.isFalse("type" in primary);
          if ("type" in primary) return;
          assert.equal(primary.remoteServerKind, "managed");
          const appId = EnvironmentId.make("app-owner");
          const app = yield* startOwner(appId, "app-control");
          const appDir = `${fixture.home}/.goat/desktop/userdata`;
          yield* fixture.fs.makeDirectory(appDir, { recursive: true });
          yield* fixture.fs.writeFileString(`${appDir}/environment-id`, `${appId}\n`);
          yield* fixture.fs.writeFileString(`${appDir}/runtime-control.token`, "app-control\n");
          yield* fixture.fs.writeFileString(
            `${appDir}/server-runtime.json`,
            JSON.stringify({
              version: 1,
              pid: process.pid,
              port: app.port,
              origin: `http://127.0.0.1:${app.port}`,
            }),
          );
          const sidecar = yield* manager.existingEnvironment!(uploadTarget, appId);
          assert.notEqual(sidecar.httpBaseUrl, primary.httpBaseUrl);
          const session = yield* manager.issueExistingMcpSession!(uploadTarget, appId, {
            label: "reverse",
            ttl: "1h",
            runtimeModeCeiling: "full-access",
          });
          assert.equal(session.token, `${appId}-session`);
          assert.deepEqual(app.sessions, ["app-control"]);
          const stillPrimary = yield* manager.ensureEnvironment(uploadTarget);
          assert.isFalse("type" in stillPrimary);
          if ("type" in stillPrimary) return;
          assert.equal(stillPrimary.remoteServerKind, "managed");
          assert.equal(stillPrimary.httpBaseUrl, primary.httpBaseUrl);
          yield* fixture.fs.writeFileString(`${appDir}/environment-id`, "replaced-owner\n");
          yield* manager.existingEnvironment!(uploadTarget, appId).pipe(Effect.flip);
          assert.notInclude(
            yield* fixture.fs.readFileString(`${fixture.test}/events`),
            '"type":"stop"',
          );
        }).pipe(Effect.provide(layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live(
      "opens a passive forward for the nonprimary environment without replacing the primary",
      () =>
        Effect.gen(function* () {
          const appId = "app-owner";
          const managedId = "managed-owner";
          const app = yield* startOwner(appId, "app-control");
          const managed = yield* startOwner(managedId, "managed-control");
          const fs = yield* FileSystem.FileSystem;
          const real = yield* ChildProcessSpawner.ChildProcessSpawner;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-two-owners-" });
          const forwards: Array<{ remotePort: number; killed: boolean }> = [];
          const scripts: string[] = [];
          for (const [kind, owner, id, token] of [
            ["app", app, appId, "app-control"],
            ["managed", managed, managedId, "managed-control"],
          ] as const) {
            const dir = `${home}/.goat/${kind === "app" ? "desktop/userdata" : "userdata"}`;
            yield* fs.makeDirectory(dir, { recursive: true });
            yield* fs.writeFileString(`${dir}/environment-id`, `${id}\n`);
            yield* fs.writeFileString(`${dir}/runtime-control.token`, `${token}\n`);
            yield* fs.writeFileString(
              `${dir}/server-runtime.json`,
              JSON.stringify({
                version: 1,
                pid: process.pid,
                port: owner.port,
                origin: `http://127.0.0.1:${owner.port}`,
              }),
            );
          }
          const transport = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (command._tag !== "StandardCommand") return yield* real.spawn(command);
              if (command.args.includes("-N")) {
                const forward = command.args[command.args.indexOf("-L") + 1] ?? "";
                const remotePort = Number(forward.split(":").at(-1));
                const observed = { remotePort, killed: false };
                forwards.push(observed);
                return makeRunningProcess(() => {
                  observed.killed = true;
                });
              }
              if (!command.command.endsWith("ssh")) return yield* real.spawn(command);
              if (command.args.includes("-G"))
                return makeSuccessfulProcess(
                  "hostname devbox.example.com\nuser julius\nport 2222\n",
                );
              const stdin = command.options.stdin;
              if (
                stdin === undefined ||
                typeof stdin !== "object" ||
                !("stream" in stdin) ||
                !Stream.isStream(stdin.stream)
              )
                return makeSuccessfulProcess("");
              const bytes = yield* stdin.stream.pipe(Stream.runCollect);
              scripts.push(
                new TextDecoder().decode(
                  new Uint8Array(bytes.flatMap((chunk) => Array.from(chunk))),
                ),
              );
              return yield* real.spawn(
                ChildProcess.make(remoteShell, ["-s"], {
                  env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
                  extendEnv: false,
                  stdin: { stream: Stream.fromIterable(bytes), endOnDone: true },
                }),
              );
            }),
          );
          let localPort = 41773;
          const net = NetService.NetService.of({
            ...testNetService,
            reserveLoopbackPort: () => Effect.sync(() => localPort++),
          });
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, net),
            SshAuth.SshPasswordPrompt.disabledLayer,
          ).pipe((base) =>
            SshTunnel.SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed({ ...ARCHIVE, attachAppServer: true }),
              leaveRemoteServerRunning: false,
            }).pipe(Layer.provideMerge(base)),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            const primary = yield* manager.ensureEnvironment(uploadTarget);
            assert.isFalse("type" in primary);
            if ("type" in primary) return;
            assert.equal(primary.remoteServerKind, "app");
            const alternate = yield* manager.existingEnvironment!(
              uploadTarget,
              EnvironmentId.make(managedId),
            );
            assert.notEqual(alternate.httpBaseUrl, primary.httpBaseUrl);
            assert.deepEqual(
              forwards.map(({ remotePort }) => remotePort),
              [app.port, managed.port],
            );
            const session = yield* manager.issueExistingMcpSession!(
              uploadTarget,
              EnvironmentId.make(managedId),
              {
                label: "hub",
                ttl: "1h",
                runtimeModeCeiling: "full-access",
              },
            );
            assert.equal(session.token, `${managedId}-session`);
            assert.deepEqual(managed.sessions, ["managed-control"]);
            assert.deepEqual(app.sessions, []);
            const stillPrimary = yield* manager.ensureEnvironment(uploadTarget);
            assert.isFalse("type" in stillPrimary);
            if ("type" in stillPrimary) return;
            assert.equal(stillPrimary.httpBaseUrl, primary.httpBaseUrl);
            yield* fs.writeFileString(`${home}/.goat/userdata/environment-id`, "replaced-owner\n");
            yield* manager.existingEnvironment!(uploadTarget, EnvironmentId.make(managedId)).pipe(
              Effect.flip,
            );
            assert.isTrue(forwards[1]?.killed);
            assert.isFalse(forwards[0]?.killed);
            assert.isFalse(scripts.some((script) => script.includes("STOP_WAIT_ATTEMPTS")));
          }).pipe(Effect.provide(layer), Effect.scoped);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live.each([false, true])(
      "checks an old Node entry before publishing an upgrade; missing identity=%s",
      (missingIdentity) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          const entry = `${f.home}/old entry.cjs`;
          const nextEntry = `${f.home}/new entry.cjs`;
          const executable = protocolExecutable(
            "1.2.3",
            {
              ssh: SSH_RUNTIME_PROTOCOL_VERSION,
              orchestration: ORCHESTRATION_PROTOCOL_VERSION,
              nodeReadiness: true,
              drain: true,
            },
            f.state,
          );
          yield* f.fs.writeFileString(
            entry,
            executable.replace(
              "JSON.stringify(descriptor)",
              `JSON.stringify({...descriptor, sshRuntimeProtocolVersion: fs.existsSync(path.join(test, "incompatible-live")) ? 99 : ${SSH_RUNTIME_PROTOCOL_VERSION}})`,
            ),
          );
          yield* f.fs.writeFileString(nextEntry, executable);
          const layer = (nodeScriptPath: string, leaveRemoteServerRunning: boolean) =>
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
              Layer.succeed(FileSystem.FileSystem, f.observedFs),
              Layer.succeed(HttpClient.HttpClient, testHttpClient),
              Layer.succeed(NetService.NetService, testNetService),
              SshAuth.SshPasswordPrompt.disabledLayer,
              SshTunnel.SshEnvironmentManager.layer({
                resolveCliRunner: Effect.succeed({
                  nodeScriptPath,
                  nodeEngineRange: TEST_NODE_ENGINE_RANGE,
                }),
                leaveRemoteServerRunning,
              }),
            );
          yield* Effect.gen(function* () {
            yield* (yield* SshTunnel.SshEnvironmentManager).ensureEnvironment(uploadTarget);
          }).pipe(Effect.provide(layer(entry, true)), Effect.scoped);
          const pid = (yield* f.fs.readFileString(`${f.state}/pid`)).trim();
          const record = `${f.home}/.goat/userdata/server-runtime.json`;
          const metadata = JSON.parse(yield* f.fs.readFileString(record));
          metadata.sshRuntimeProtocolVersion = 99;
          yield* f.fs.writeFileString(record, JSON.stringify(metadata));
          yield* f.fs.writeFileString(`${f.test}/incompatible-live`, "1");
          if (missingIdentity) yield* f.fs.remove(`${f.state}/identity`);
          const before = yield* f.snapshot;
          const bin = `${f.test}/real-ps-bin`;
          yield* f.fs.makeDirectory(bin);
          yield* f.fs.writeFileString(
            `${bin}/ps`,
            `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[1] === 'command=' && args[3] === ${JSON.stringify(pid)}) fs.appendFileSync(${JSON.stringify(`${f.test}/inspections`)}, JSON.stringify({ runner: fs.readFileSync(${JSON.stringify(`${f.state}/run-t3.sh`)}, 'utf8'), identity: fs.existsSync(${JSON.stringify(`${f.state}/identity`)}) ? fs.readFileSync(${JSON.stringify(`${f.state}/identity`)}, 'utf8') : null, command: cp.execFileSync('/bin/ps', args, {encoding:'utf8'}).trim() }) + '\\n');
process.stdout.write(cp.execFileSync('/bin/ps', args));
`,
          );
          yield* f.fs.chmod(`${bin}/ps`, 0o700);
          f.setRemotePath(`${bin}:${process.env.PATH ?? ""}`);
          const result = yield* Effect.result(
            Effect.gen(function* () {
              yield* (yield* SshTunnel.SshEnvironmentManager).ensureEnvironment(uploadTarget);
            }).pipe(Effect.provide(layer(nextEntry, false)), Effect.scoped),
          );
          if (missingIdentity) {
            assert.isTrue(Result.isFailure(result));
            if (Result.isFailure(result)) assert.include(String(result.failure), `kill ${pid}`);
            assert.deepEqual(yield* f.snapshot, before);
            yield* Effect.sync(() => process.kill(Number(pid), 0));
            assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
            return;
          }
          assert.isTrue(Result.isSuccess(result));
          const inspections = (yield* f.fs.readFileString(`${f.test}/inspections`))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.isAtLeast(inspections.length, 2);
          assert.include(inspections[0].runner, entry);
          assert.notInclude(inspections[0].runner, nextEntry);
          // Publication follows the confirmed drain, so every old-PID inspection
          // must still see the old runner.
          for (const inspection of inspections) {
            assert.include(inspection.runner, entry);
            assert.notInclude(inspection.runner, nextEntry);
          }
          const expectedIdentity =
            before.identity ??
            `${entry} serve --host 127.0.0.1 --port ${metadata.port} --base-dir ${f.home}/.goat\n`;
          for (const inspection of inspections) {
            if (inspection.identity !== null) assert.equal(inspection.identity, expectedIdentity);
            assert.equal(inspection.command, `node ${expectedIdentity.trim()}`);
          }
          const events = (yield* f.fs.readFileString(`${f.test}/events`))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.lengthOf(
            events.filter((event) => event.type === "start"),
            2,
          );
          assert.lengthOf(
            events.filter((event) => event.type === "stop"),
            1,
          );
          assert.lengthOf(
            events.filter((event) => event.type === "drain"),
            1,
          );
          assert.lengthOf(
            events.filter((event) => event.type === "self-stop"),
            1,
          );
          assert.lengthOf(
            events.filter((event) => event.type === "supervise" && event.status === "replaced"),
            1,
          );
          assert.include(events.filter((event) => event.type === "start")[1].runner, nextEntry);
          for (const file of ["pid", "port", "managed", "identity"])
            assert.isFalse(yield* f.fs.exists(`${f.state}/${file}`));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "reuses an exact live legacy descriptor for $entry",
      ({ entry }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: ARCHIVE.archiveVersion,
          });
          const before = yield* f.snapshot;
          const result = yield* f.run(entry);
          assert.isTrue(Result.isSuccess(result));
          assert.deepEqual(yield* f.snapshot, before);
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        (
          ["external", "missing record", "broken record", "different PID", "nonloopback"] as const
        ).map((mode) => ({ entry, mode })),
      ),
    )("preserves incompatible $mode identity before $entry", ({ entry, mode }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: mode === "external" ? "external" : "managed",
          oldVersion: "1.2.2",
          ssh: 99,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const file = `${f.home}/.goat/userdata/server-runtime.json`;
        if (mode === "missing record") yield* f.fs.remove(file);
        if (mode === "broken record") yield* f.fs.writeFileString(file, "{");
        if (mode === "different PID")
          yield* f.fs.writeFileString(`${f.state}/pid`, `${f.pid + 1}\n`);
        if (mode === "nonloopback") {
          const record = JSON.parse(yield* f.fs.readFileString(file));
          yield* f.fs.writeFileString(
            file,
            JSON.stringify({ ...record, origin: `http://example.invalid:${f.port}` }),
          );
        }
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(yield* f.snapshot, before);
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        assert.notInclude(events, '"type":"stop"');
        assert.notInclude(events, '"type":"auth"');
        yield* Effect.sync(() => process.kill(f.pid, 0));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "runs explicit matching Node $entry with an ambient upstream home",
      ({ entry }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          const upstream = `${f.home}/.t3`;
          yield* f.fs.makeDirectory(upstream, { recursive: true });
          yield* f.fs.writeFileString(`${upstream}/sentinel`, "upstream bytes");
          const cli = `${f.home}/dev.cjs`;
          yield* f.fs.writeFileString(
            cli,
            protocolExecutable(
              "1.2.3",
              {
                ssh: SSH_RUNTIME_PROTOCOL_VERSION,
                orchestration: ORCHESTRATION_PROTOCOL_VERSION,
                nodeReadiness: true,
              },
              f.state,
            ),
          );
          const scripts = yield* nativeScripts({ nodeScriptPath: cli });
          const key = f.state.slice(f.state.lastIndexOf("/") + 1);
          const child = yield* f.realSpawner.spawn(
            ChildProcess.make(remoteShell, ["-s", "--", key], {
              env: {
                HOME: f.home,
                PATH: f.withPortShim(process.env.PATH ?? ""),
                LC_ALL: "C",
                T3CODE_HOME: upstream,
              },
              extendEnv: false,
              stdin: {
                stream: Stream.make(new TextEncoder().encode(scripts[entry])),
                endOnDone: true,
              },
            }),
          );
          const output = yield* Effect.all(
            {
              stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
              code: child.exitCode,
            },
            { concurrency: "unbounded" },
          );
          assert.equal(Number(output.code), 0, output.stderr);
          if (entry === "launch")
            assert.equal(
              (yield* f.fs.readFileString(`${f.state}/port`)).trim(),
              String(f.pickPort),
            );
          assert.equal(yield* f.fs.readFileString(`${upstream}/sentinel`), "upstream bytes");
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
          const events = (yield* f.fs.readFileString(`${f.test}/events`))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          if (entry !== "launch") {
            const auth = events.findLast((event) => event.type === "auth");
            assert.equal(auth.version, "1.2.3");
            assert.equal(auth.args[auth.args.indexOf("--base-dir") + 1], `${f.home}/.goat`);
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
