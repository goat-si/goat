import { describe, expect, it } from "@effect/vitest";
import { DeviceId, LOCAL_DEVICE_HOST_ID, ThreadId } from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import type * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as DeviceService from "./DeviceService.ts";

const deviceId = DeviceId.make("emulator-5554");

// A hub with one booted emulator whose first `rejectedShutdowns` shutdowns fail.
const makeService = Effect.fn("makeService")(function* (rejectedShutdowns: number) {
  let booted = true;
  let rejectionsLeft = rejectedShutdowns;
  const shutdowns: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
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
      if (rejectionsLeft > 0) {
        rejectionsLeft -= 1;
        return HttpClientResponse.fromWeb(request, Response.json({ ok: false, error: "busy" }));
      }
      booted = false;
      return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
    }),
  );
  const run = () => Effect.succeed({ code: 0, stdout: " V....D libx264", stderr: "" });
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    devices: makeDeviceHubOperations({
      hostId: LOCAL_DEVICE_HOST_ID,
      origin: "http://device.test",
      http,
      run,
      androidAvailable: Effect.succeed(true),
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
  return { service, shutdowns };
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
});
