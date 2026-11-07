import { describe, expect, it } from "@effect/vitest";
import { DeviceId, LOCAL_DEVICE_HOST_ID, ThreadId } from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import { classifyAgentClose, type AgentSessionTarget } from "./AgentSessionRelease.ts";
import type * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as DeviceService from "./DeviceService.ts";
import { DeviceOperationError } from "@goat/contracts";

const phone = DeviceId.make("emulator-5554");
const tablet = DeviceId.make("emulator-5556");
const lane = ThreadId.make("lane");
const other = ThreadId.make("other");

// A hub with two booted emulators and a scripted agent-device close.
const makeService = Effect.fn("makeService")(function* (failingCloses: number) {
  let failuresLeft = failingCloses;
  const closes: AgentSessionTarget[] = [];
  const shutdowns: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      if (path === "/api/devices") {
        const emulator = (id: string) => ({
          id,
          name: id,
          platform: "android",
          version: "15",
          physical: false,
          booted: true,
        });
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ simulators: [], emulators: [emulator(phone), emulator(tablet)] }),
        );
      }
      shutdowns.push(path);
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
      agentDeviceInstalled: true,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: () => Effect.succeed(ready),
    ensureAgentReady: () => Effect.die("Agent access is not used in this test"),
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: Effect.void,
  };
  const closeAgentSession = (target: AgentSessionTarget) =>
    Effect.suspend(() => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return Effect.fail(
          new DeviceOperationError({
            operation: "close agent session",
            reason: "request_failed",
            cause: new Error("daemon busy"),
          }),
        );
      }
      closes.push(target);
      return Effect.succeed("closed" as const);
    });
  const service = yield* DeviceService.makeWithHosts(
    new Map([[host.id, host]]),
    undefined,
    undefined,
    undefined,
    closeAgentSession,
  ).pipe(Effect.provide(NodeCrypto.layer));
  return { service, closes, shutdowns };
});

const open = (
  service: DeviceService.DeviceService["Service"],
  threadId: ThreadId,
  deviceId: DeviceId,
) => service.open({ threadId, deviceId, platform: "android" });

describe("DeviceService.releaseThread", () => {
  it.effect(
    "closes the thread's agent-device sessions, keeps other threads' and never shuts a device down",
    () =>
      Effect.gen(function* () {
        const { service, closes, shutdowns } = yield* makeService(0);
        yield* open(service, lane, phone);
        yield* open(service, lane, tablet);
        const kept = yield* open(service, other, phone);

        yield* service.releaseThread(lane);

        expect(closes.map((target) => [target.threadId, target.deviceId]).toSorted()).toEqual([
          [lane, phone],
          [lane, tablet],
        ]);
        expect((yield* service.state).sessions).toEqual([kept]);
        expect(shutdowns).toEqual([]);
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })),
        Effect.scoped,
      ),
  );

  it.effect("a failed agent-device close fails the release and the next release closes it", () =>
    Effect.gen(function* () {
      const { service, closes } = yield* makeService(1);
      yield* open(service, lane, phone);

      expect(Exit.isFailure(yield* Effect.exit(service.releaseThread(lane)))).toBe(true);
      expect(closes).toEqual([]);

      yield* service.releaseThread(lane);
      expect(closes.map((target) => target.deviceId)).toEqual([phone]);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
  );

  it.effect(
    "a session dropped by turning device support off is still closed by the next release",
    () =>
      Effect.gen(function* () {
        const { service, closes } = yield* makeService(0);
        yield* open(service, lane, phone);
        yield* service.configure({ enabled: false });
        expect((yield* service.state).sessions).toEqual([]);

        yield* service.releaseThread(lane);
        expect(closes.map((target) => [target.threadId, target.deviceId])).toEqual([[lane, phone]]);
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })),
        Effect.scoped,
      ),
  );

  it.effect(
    "a close that failed earlier is retried by any later release, even another thread's",
    () =>
      Effect.gen(function* () {
        const { service, closes } = yield* makeService(1);
        yield* open(service, lane, phone);
        expect(Exit.isFailure(yield* Effect.exit(service.close({ threadId: lane })))).toBe(true);

        yield* service.releaseThread(other);
        expect(closes.map((target) => [target.threadId, target.deviceId])).toEqual([[lane, phone]]);
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })),
        Effect.scoped,
      ),
  );

  it.effect("a pending close is dropped, not run, once its session is reopened", () =>
    Effect.gen(function* () {
      const { service, closes } = yield* makeService(1);
      yield* open(service, lane, phone);
      expect(Exit.isFailure(yield* Effect.exit(service.close({ threadId: lane })))).toBe(true);
      const reopened = yield* open(service, lane, phone);
      yield* open(service, lane, tablet);

      yield* service.close({ threadId: lane, deviceId: tablet });
      expect(closes.map((target) => target.deviceId)).toEqual([tablet]);
      expect((yield* service.state).sessions).toEqual([reopened]);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
  );
});

describe("classifyAgentClose", () => {
  const json = (value: unknown) => ({ code: 1, stdout: JSON.stringify(value) });
  it("treats a closed session as closed and a missing one as already gone", () => {
    expect(classifyAgentClose({ code: 0, stdout: '{"success":true}' })).toBe("closed");
    expect(classifyAgentClose(json({ success: false, error: { code: "SESSION_NOT_FOUND" } }))).toBe(
      "absent",
    );
  });

  it("reports an unreachable daemon apart from a failed close, never as a closed session", () => {
    const unavailable = json({
      success: false,
      error: { code: "COMMAND_FAILED", message: "Remote daemon is unavailable" },
    });
    expect(classifyAgentClose(unavailable)).toBe("unreachable");
    expect(classifyAgentClose({ code: null, stdout: "" })).toBe("failed");
  });
});
