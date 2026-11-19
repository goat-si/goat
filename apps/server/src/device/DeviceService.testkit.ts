import { DEFAULT_SERVER_SETTINGS, LOCAL_DEVICE_HOST_ID, type DeviceSummary } from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { NodeRuntimeUnavailableError } from "@goat/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";

export const fixture = Effect.fn("fixture")(function* (
  onBoot: Effect.Effect<void> = Effect.void,
  bootError?: string | { error?: string; errors?: Array<{ message: string; error?: string }> },
  failListAfterShutdown = false,
  runtimeFailure?:
    | NodeRuntimeUnavailableError
    | DeviceHost.DeviceHostError
    | DeviceHost.AgentDeviceStartError,
  inspectError = false,
  installTool?: Parameters<typeof DeviceService.makeWithHosts>[3],
  options: { readonly endsDevices?: boolean } = {},
) {
  const settings = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
  const starts: string[] = [];
  const agentStarts: string[] = [];
  const agentStops: string[] = [];
  const requests: string[] = [];
  const devices: Array<Omit<DeviceSummary, "hostId">> = [];
  const discoveryErrors = yield* Ref.make<Array<{ message: string; error?: string }>>([]);
  const androidAvailable = yield* Ref.make(true);
  const encoderResult = yield* Ref.make({ code: 0, stdout: " V....D libx264", stderr: "" });
  let booted = false;
  let shutDown = false;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push(request.url);
      if (request.url.includes("/api/screenshot")) {
        return HttpClientResponse.fromWeb(request, new Response(new Uint8Array([137, 80, 78, 71])));
      }
      if (request.url.endsWith("/shutdown")) {
        shutDown = true;
        booted = false;
        return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
      }
      if (shutDown && failListAfterShutdown) {
        return HttpClientResponse.fromWeb(request, new Response("Discovery busy", { status: 503 }));
      }
      if (request.url.endsWith("/boot")) {
        yield* onBoot;
        booted = true;
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            bootError
              ? { ok: false, ...(typeof bootError === "string" ? { error: bootError } : bootError) }
              : { ok: true, serial: "emulator-5554" },
          ),
        );
      }
      if (request.url.endsWith("/grid/api/start")) {
        return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          errors: yield* Ref.get(discoveryErrors),
          simulators: devices.filter((device) => device.platform === "ios"),
          emulators: [
            ...devices.filter((device) => device.platform === "android"),
            ...(booted
              ? [
                  {
                    id: "emulator-5554",
                    name: "Pixel_API_35",
                    platform: "android",
                    version: "Android 15",
                    booted: true,
                    physical: false,
                  },
                ]
              : []),
          ],
        }),
      );
    }),
  );
  const run = (command: string) =>
    command === "emulator"
      ? Effect.succeed({ code: 0, stdout: "Pixel_API_35\n", stderr: "" })
      : Ref.get(encoderResult);
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    devices: {
      ...makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: "http://device.test",
        http,
        run,
        platformAvailable: () => Ref.get(androidAvailable),
      }),
      ...(options.endsDevices ? { endsDevices: true } : {}),
    },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run,
  };
  const host: DeviceHost.DeviceHost["Service"] = {
    ...(inspectError
      ? {
          inspect: Effect.fail(
            new DeviceHost.DeviceHostError({
              hostId: LOCAL_DEVICE_HOST_ID,
              step: "probe",
              cause: new Error("offline"),
            }),
          ),
        }
      : {}),
    id: LOCAL_DEVICE_HOST_ID,
    label: "This machine",
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Test server",
      platforms: [
        { platform: "android", available: true },
        { platform: "ios", available: true },
      ],
      hubInstalled: true,
      agentDeviceInstalled: false,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: (onPhase) =>
      Effect.gen(function* () {
        if (runtimeFailure && runtimeFailure._tag !== "AgentDeviceStartError")
          return yield* runtimeFailure;
        starts.push("start");
        yield* onPhase("installing", "Updating device hub from 0.9.0 to 0.10.1…");
        return ready;
      }),
    ensureAgentReady: (onPhase) =>
      Effect.gen(function* () {
        if (runtimeFailure) return yield* runtimeFailure;
        agentStarts.push("start");
        yield* onPhase("starting");
        return {
          ...ready,
          agentDevice: { baseUrl: "http://agent.test", token: "test", entryPath: "/agent" },
        };
      }),
    current: Effect.succeed(null),
    stopAgent: Effect.sync(() => {
      agentStops.push("stop");
    }),
    stop: Effect.sync(() => {
      starts.push("stop");
    }),
  };
  const service = yield* DeviceService.makeWithHosts(
    new Map([[host.id, host]]),
    undefined,
    undefined,
    installTool,
  ).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(DeviceHost.DeviceHost, host),
    Effect.provideService(
      ServerSettings.ServerSettingsService,
      ServerSettings.ServerSettingsService.of({
        updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
        checkpointReplicationPermit: () =>
          Effect.die("checkpoint replication is not used by this fixture"),
        withSettingsSnapshot: (use) => Effect.flatMap(Ref.get(settings), use),
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settings),
        updateSettings: (patch) =>
          Ref.updateAndGet(settings, (current) => ({
            ...current,
            enableDeviceSupport: patch.enableDeviceSupport ?? current.enableDeviceSupport,
            enableAgentDeviceAccess:
              patch.enableAgentDeviceAccess ?? current.enableAgentDeviceAccess,
            deviceOnboardingCompleted:
              patch.deviceOnboardingCompleted ?? current.deviceOnboardingCompleted,
          })),
        updateSettingsWith: (patchFor) =>
          Ref.get(settings).pipe(
            Effect.flatMap(patchFor),
            Effect.flatMap((patch) =>
              Ref.updateAndGet(settings, (current) => ({
                ...current,
                enableDeviceSupport: patch.enableDeviceSupport ?? current.enableDeviceSupport,
                enableAgentDeviceAccess:
                  patch.enableAgentDeviceAccess ?? current.enableAgentDeviceAccess,
                deviceOnboardingCompleted:
                  patch.deviceOnboardingCompleted ?? current.deviceOnboardingCompleted,
              })),
            ),
          ),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
    ),
  );
  // The host ending a device on its own, as EAS does at a session's limits.
  const endDevice = () => {
    booted = false;
  };
  return {
    service,
    starts,
    agentStarts,
    agentStops,
    requests,
    settings,
    devices,
    encoderResult,
    discoveryErrors,
    androidAvailable,
    endDevice,
  };
});
