import { expect, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as DeviceService from "./DeviceService.ts";

it.effect("retains only the failed host's last known simulators until discovery recovers", () =>
  Effect.gen(function* () {
    const discovery = yield* Ref.make<"present" | "failed" | "empty">("present");
    const makeHost = (id: string): DeviceHost.DeviceHost["Service"] => {
      const http = HttpClient.make((request) =>
        Ref.get(discovery).pipe(
          Effect.map((mode) =>
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                simulators:
                  mode !== "present" && id === "local"
                    ? []
                    : [
                        {
                          id: `iphone-${id}`,
                          name: "iPhone",
                          platform: "ios",
                          version: "26",
                          booted: true,
                          physical: false,
                        },
                      ],
                emulators: [],
                errors:
                  mode === "failed" && id === "local"
                    ? [
                        {
                          message:
                            "[apple-utils] Failed to run `xcrun simctl list devices --json`:",
                        },
                      ]
                    : [],
              }),
            ),
          ),
        ),
      );
      const run = () => Effect.succeed({ code: 0, stdout: "", stderr: "" });
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: process.execPath,
        hub: { origin: `http://${id}` },
        run,
        devices: makeDeviceHubOperations({
          hostId: id,
          origin: `http://${id}`,
          http,
          run,
          platformAvailable: (platform) => Effect.succeed(platform === "ios"),
        }),
        helpers: { serveSimAxSettings: null, serveSimCli: null },
      };
      return {
        id,
        label: id,
        summary: Effect.succeed({
          id,
          label: id,
          kind: id === "local" ? "local" : "ssh",
          platforms: [{ platform: "ios", available: true }],
          hubInstalled: true,
          agentDeviceInstalled: false,
        }),
        platformAvailability: (platform) =>
          Effect.succeed({ platform, available: platform === "ios" }),
        ensureReady: () => Effect.succeed(ready),
        ensureAgentReady: () => Effect.die("not used"),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
    };
    const hosts = new Map(["local", "remote"].map((id) => [id, makeHost(id)]));
    const service = yield* DeviceService.makeWithHosts(hosts).pipe(
      Effect.provide(NodeCrypto.layer),
    );
    expect((yield* service.list).devices.map((device) => device.id).sort()).toEqual([
      "iphone-local",
      "iphone-remote",
    ]);
    yield* Ref.set(discovery, "failed");
    const failed = yield* service.list;
    expect(failed.devices.map((device) => device.id).sort()).toEqual([
      "iphone-local",
      "iphone-remote",
    ]);
    expect(failed.hostStatuses.local?.incompletePlatforms).toEqual(["ios"]);
    expect(failed.hostStatuses.remote?.incompletePlatforms).toBeUndefined();
    yield* Ref.set(discovery, "empty");
    const recovered = yield* service.list;
    expect(recovered.hostStatuses.local?.incompletePlatforms).toBeUndefined();
    expect(recovered.devices.map((device) => device.id)).toEqual(["iphone-remote"]);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect("marks available platforms incomplete when the hub listing times out", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();
    const http = HttpClient.make(() =>
      Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const run = () => Effect.succeed({ code: 0, stdout: "", stderr: "" });
    const operations = makeDeviceHubOperations({
      hostId: "local",
      origin: "http://local",
      http,
      run,
      platformAvailable: () => Effect.succeed(true),
    });
    const listing = yield* operations.list.pipe(Effect.forkScoped);
    yield* Deferred.await(requested);
    yield* TestClock.adjust("40 seconds");
    const result = yield* Fiber.join(listing);
    expect(result.incompletePlatforms).toEqual(["ios", "android"]);
    expect(result.detail).toContain("40 seconds");
  }).pipe(Effect.scoped),
);

it.effect("does not open a retained device after an incomplete post-boot listing", () =>
  Effect.gen(function* () {
    const afterBoot = yield* Ref.make(false);
    const device = {
      id: "pixel",
      name: "Pixel",
      platform: "android",
      version: "36",
      booted: false,
      physical: false,
    } as const;
    const http = HttpClient.make(() => Effect.die("unused"));
    const run = () => Effect.succeed({ code: 0, stdout: " V....D libx264", stderr: "" });
    const ready: DeviceHost.DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin: "http://local" },
      run,
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      devices: {
        ...makeDeviceHubOperations({
          hostId: "local",
          origin: "http://local",
          http,
          run,
          platformAvailable: () => Effect.succeed(true),
        }),
        list: Ref.get(afterBoot).pipe(
          Effect.map((incomplete) =>
            incomplete
              ? {
                  devices: [],
                  detail: "Discovery timed out",
                  incompletePlatforms: ["android" as const],
                }
              : { devices: [device], detail: undefined },
          ),
        ),
        boot: () => Ref.set(afterBoot, true).pipe(Effect.as("pixel")),
      },
    };
    const host: DeviceHost.DeviceHost["Service"] = {
      id: "local",
      label: "local",
      summary: Effect.succeed({
        id: "local",
        label: "local",
        kind: "local",
        platforms: [{ platform: "android", available: true }],
        hubInstalled: true,
        agentDeviceInstalled: false,
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
      ensureReady: () => Effect.succeed(ready),
      ensureAgentReady: () => Effect.die("unused"),
      current: Effect.succeed(ready),
      stopAgent: Effect.void,
      stop: Effect.void,
    };
    const service = yield* DeviceService.makeWithHosts(new Map([["local", host]])).pipe(
      Effect.provide(NodeCrypto.layer),
    );
    yield* service.list;
    const error = yield* service
      .open({ threadId: ThreadId.make("thread:boot"), deviceId: "pixel", platform: "android" })
      .pipe(Effect.flip);
    expect(error._tag).toBe("DeviceNotFoundError");
    expect((yield* service.state).sessions).toEqual([]);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);
