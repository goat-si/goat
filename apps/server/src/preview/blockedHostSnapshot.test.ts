import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layerServerSettings } from "../serverSettingsLayers.testkit.ts";

it.effect("the blocked-host view sees the committed settings update", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    if (!settings.blockedBrowserHostsSnapshot) throw new Error("missing synchronous host view");
    expect(yield* settings.blockedBrowserHostsSnapshot).toEqual([]);
    yield* settings.updateSettings({ blockedBrowserHosts: ["blocked.test"] });
    expect(yield* settings.blockedBrowserHostsSnapshot).toEqual(["blocked.test"]);
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest().pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-host-view-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("the production settings service publishes its committed blocked-host view", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.start;
    if (!settings.blockedBrowserHostsSnapshot) throw new Error("missing synchronous host view");
    expect(yield* settings.blockedBrowserHostsSnapshot).toEqual([]);
    yield* settings.updateSettings({ blockedBrowserHosts: ["blocked.test"] });
    expect(yield* settings.blockedBrowserHostsSnapshot).toEqual(["blocked.test"]);
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);
