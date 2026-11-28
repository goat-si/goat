import { describe, expect, it } from "@effect/vitest";
import { DeviceId, LOCAL_DEVICE_HOST_ID, ThreadId } from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import type * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as DeviceService from "./DeviceService.ts";

const deviceId = DeviceId.make("emulator-5554");

// A hub with one booted emulator whose first `rejectedShutdowns` shutdowns fail.
const makeService = Effect.fn("makeService")(function* (
  rejectedShutdowns: number,
  options: {
    readonly shutdownDelay?: Duration.Input;
    readonly adbDevices?: { code: number; stdout: string; stderr: string };
  } = {},
) {
  let booted = true;
  let rejectionsLeft = rejectedShutdowns;
  const shutdowns: string[] = [];
  const shutdownRequested = yield* Deferred.make<void>();
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      if (path === "/api/devices") {
        const emulator = {
          id: deviceId,
          name: "Pixel",
          platform: "android",
          version: "15",
          physical: false,
        };
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ simulators: [], emulators: [{ ...emulator, booted }] }),
        );
      }
      if (path !== "/api/devices/shutdown") throw new Error(`Unexpected hub path: ${path}`);
      shutdowns.push(path);
      yield* Deferred.succeed(shutdownRequested, undefined);
      if (options.shutdownDelay !== undefined) yield* Effect.sleep(options.shutdownDelay);
      if (rejectionsLeft > 0) {
        rejectionsLeft -= 1;
        return HttpClientResponse.fromWeb(request, Response.json({ ok: false, error: "busy" }));
      }
      booted = false;
      return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
    }),
  );
  const run: DeviceHost.DeviceHostReady["run"] = (command, args) =>
    command === "adb" && args.join(" ") === "devices"
      ? Effect.sync(
          () =>
            options.adbDevices ?? {
              code: 0,
              stdout: `List of devices attached\n${booted ? `${deviceId}\tdevice\n` : ""}`,
              stderr: "",
            },
        )
      : Effect.succeed({ code: 0, stdout: " V....D libx264", stderr: "" });
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    devices: makeDeviceHubOperations({
      hostId: LOCAL_DEVICE_HOST_ID,
      origin: "http://device.test",
      http,
      run,
      platformAvailable: () => Effect.succeed(true),
    }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run,
  };
  const host: DeviceHost.DeviceHost["Service"] = {
    id: LOCAL_DEVICE_HOST_ID,
    label: "This machine",
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Emulator host",
      platforms: [{ platform: "android", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: false,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: () => Effect.succeed(ready),
    ensureAgentReady: () => Effect.die("Agent access is not used in this test"),
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: Effect.void,
  };
  const service = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
    Effect.provide(NodeCrypto.layer),
  );
  const endDevice = () => {
    booted = false;
  };
  return { service, shutdowns, shutdownRequested, endDevice };
});

describe("DeviceService.close", () => {
  it.effect("a close whose shutdown fails keeps the session so the same close can retry it", () =>
    Effect.gen(function* () {
      const { service, shutdowns } = yield* makeService(1);
      const threadId = ThreadId.make("close-retry");
      const session = yield* service.open({ threadId, deviceId, platform: "android" });
      const input = { threadId, deviceId, shutdown: true };

      expect(Exit.isFailure(yield* Effect.exit(service.close(input)))).toBe(true);
      expect(shutdowns).toHaveLength(1);
      expect((yield* service.state).sessions).toEqual([session]);

      yield* service.close(input);
      expect(shutdowns).toHaveLength(2);
      expect((yield* service.state).sessions).toEqual([]);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
  );

  it.effect("closes the session on a retry once the emulator has exited", () =>
    Effect.gen(function* () {
      const { service, endDevice } = yield* makeService(2);
      const threadId = ThreadId.make("android-close-exited");
      yield* service.open({ threadId, deviceId, platform: "android" });
      const first = yield* Effect.exit(service.close({ threadId, shutdown: true }));
      expect(Exit.isFailure(first)).toBe(true);
      expect((yield* service.state).sessions).toHaveLength(1);

      endDevice();
      yield* service.close({ threadId, shutdown: true });
      expect((yield* service.state).sessions).toEqual([]);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
  );

  it.effect.each([
    {
      adb: "lists it offline",
      result: { code: 0, stdout: "List of devices attached\nemulator-5554\toffline\n", stderr: "" },
    },
    { adb: "fails", result: { code: 1, stdout: "", stderr: "adb: no server" } },
  ])("keeps the session after a rejected shutdown when adb $adb", ({ result }) =>
    Effect.gen(function* () {
      const { service } = yield* makeService(1, { adbDevices: result });
      const threadId = ThreadId.make("android-close-adb");
      yield* service.open({ threadId, deviceId, platform: "android" });
      const exit = yield* Effect.exit(service.close({ threadId, shutdown: true }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect((yield* service.state).sessions).toHaveLength(1);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
  );

  it.effect("waits for an emulator the hub takes longer than 15 seconds to see exit", () =>
    Effect.gen(function* () {
      const { service, shutdownRequested } = yield* makeService(0, {
        shutdownDelay: Duration.seconds(25),
      });
      const threadId = ThreadId.make("android-close-slow");
      yield* service.open({ threadId, deviceId, platform: "android" });
      // The hub allows the emulator 30 seconds to leave adb after the kill.
      const closing = yield* Effect.forkChild(service.close({ threadId, shutdown: true }));
      yield* Deferred.await(shutdownRequested);
      yield* TestClock.adjust(Duration.seconds(25));
      expect(Exit.isSuccess(yield* Fiber.await(closing))).toBe(true);
      expect((yield* service.state).sessions).toEqual([]);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
  );
});
