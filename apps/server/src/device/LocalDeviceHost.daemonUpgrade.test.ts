import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_VERSION,
  agentDeviceStateDir,
} from "./DeviceToolchain.ts";
import * as LocalDeviceHost from "./LocalDeviceHost.ts";

const processOutput = (code: number, stdout = "", stderr = "", timedOut = false) => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout,
  stderr,
  timedOut,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const agentFixture = Effect.fn("agentFixture")(function* (
  startup: (
    stateDir: string,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  previousDaemon: typeof LocalDeviceHost.__testing.AgentDeviceDaemonFile.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-device-daemon-pin-" });
  const stateDir = agentDeviceStateDir(path, path.join(baseDir, "userdata"));
  const daemonHealthy = yield* Ref.make(true);
  const runs: Array<ProcessRunner.ProcessRunInput> = [];
  for (const [name, version, entry] of [
    ["expo-device-hub", DEVICE_HUB_VERSION, "dist/server/cli.mjs"],
    ["agent-device", AGENT_DEVICE_VERSION, "bin/agent-device.mjs"],
  ] as const) {
    const installDir = path.join(baseDir, "tools", name, version);
    const entryPath = path.join(installDir, "node_modules", name, entry);
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
    yield* fs.writeFileString(entryPath, "");
    yield* fs.writeFileString(path.join(installDir, ".install-complete"), version);
  }
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* fs.writeFileString(path.join(stateDir, "daemon.json"), JSON.stringify(previousDaemon));
  const host = yield* LocalDeviceHost.make().pipe(
    Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
    Effect.provideService(HostProcess.Environment, { HOME: baseDir, PATH: "" }),
    Effect.provideService(HostProcess.IsExecutable, false),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(123),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
      ),
    ),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) => {
        runs.push(input);
        if (input.args.includes("devices")) return startup(stateDir);
        return Effect.succeed(processOutput(0));
      },
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Ref.get(daemonHealthy).pipe(
          Effect.map((healthy) =>
            HttpClientResponse.fromWeb(
              request,
              new Response("ok", {
                status: request.url.endsWith("/health") && !healthy ? 503 : 200,
              }),
            ),
          ),
        ),
      ),
    ),
  );
  yield* host.ensureReady(() => Effect.void);
  return { host, stateDir, daemonHealthy, runs };
});

describe("AgentDevice daemon pin upgrade", () => {
  // regression: #41190 a daemon left by the previous pin keeps answering /health
  it.effect("hands a daemon recorded at another agent-device version to the pinned client", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const previous = { httpPort: 12345, token: "previous-token", version: "0.21.35" };
      const { host, runs } = yield* agentFixture(
        (stateDir) =>
          fs
            .writeFileString(
              `${stateDir}/daemon.json`,
              JSON.stringify({
                httpPort: 23456,
                token: "next-token",
                version: AGENT_DEVICE_VERSION,
              }),
            )
            .pipe(Effect.orDie, Effect.as(processOutput(0))),
        previous,
      );
      const ready = yield* host.ensureAgentReady(() => Effect.void);
      expect(runs.filter((run) => run.args.includes("devices"))).toHaveLength(1);
      expect(ready.agentDevice).toMatchObject({
        baseUrl: "http://127.0.0.1:23456",
        token: "next-token",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a busy daemon from another version that the pinned client leaves running", () =>
    Effect.gen(function* () {
      const previous = { httpPort: 12345, token: "previous-token", version: "0.21.35" };
      const { host, runs } = yield* agentFixture(() => Effect.succeed(processOutput(1)), previous);
      const ready = yield* host.ensureAgentReady(() => Effect.void);
      expect(runs.filter((run) => run.args.includes("devices"))).toHaveLength(1);
      expect(ready.agentDevice).toMatchObject({
        baseUrl: "http://127.0.0.1:12345",
        token: "previous-token",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a stopped daemon a failed replacement left registered", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let health: Ref.Ref<boolean> | undefined;
      const previous = {
        httpPort: 12345,
        token: "previous-token",
        pid: process.pid,
        version: "0.21.35",
      };
      const { host, stateDir, runs, daemonHealthy } = yield* agentFixture(
        () => (health ? Ref.set(health, false) : Effect.void).pipe(Effect.as(processOutput(1))),
        previous,
      );
      health = daemonHealthy;
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(runs.filter((run) => run.args.includes("devices"))).toHaveLength(1);
      expect(error).toMatchObject({
        _tag: "AgentDeviceStartError",
        reason: "command_failed",
        exitCode: 1,
      });
      expect(yield* fs.readFileString(path.join(stateDir, "daemon.json"))).toContain(
        previous.token,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
