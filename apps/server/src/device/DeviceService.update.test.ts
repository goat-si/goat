import { expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID } from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";

it.effect("a failed tool update reports npm's exit code but not its output", () =>
  Effect.gen(function* () {
    const host: DeviceHost.DeviceHost["Service"] = {
      id: LOCAL_DEVICE_HOST_ID,
      label: "This machine",
      summary: Effect.succeed({
        id: LOCAL_DEVICE_HOST_ID,
        kind: "local",
        label: "Test server",
        platforms: [],
        hubInstalled: false,
        agentDeviceInstalled: false,
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: false }),
      ensureReady: () => Effect.die("Updating a tool does not start the hub"),
      ensureAgentReady: () => Effect.die("Updating a tool does not start the agent"),
      current: Effect.succeed(null),
      stopAgent: Effect.void,
      stop: Effect.void,
    };
    const npmFailure = {
      code: ChildProcessSpawner.ExitCode(243),
      stdout: "",
      stderr: "npm error EACCES https://private:credential@registry.example.test/expo-device-hub",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    const service = yield* DeviceService.make.pipe(
      Effect.provideService(DeviceHost.DeviceHost, host),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.succeed(npmFailure),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Updating a tool makes no hub requests")),
      ),
    );

    const error = yield* service.updateTool("hub").pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "DeviceOperationError",
      reason: "command_failed",
      exitCode: 243,
    });
    expect(error.message).toBe(
      "Device update device tool failed: The device command failed (exit code 243).",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ enableDeviceSupport: true }),
        ServerConfig.layerTest(process.cwd(), { prefix: "goat-device-update-" }),
        NodeCrypto.layer,
        NetService.layer,
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.scoped,
  ),
);
