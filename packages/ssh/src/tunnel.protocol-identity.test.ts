import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  TEST_NODE_ENGINE_RANGE,
  testHttpClient,
  testNetService,
  ARCHIVE,
  uploadTarget,
  nativeScripts,
} from "./tunnel.fixture.ts";
import { protocolExecutable, makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime protocol selection",
  () => {
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
          // Publication follows confirmed termination, so every old-PID inspection
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
            2,
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
