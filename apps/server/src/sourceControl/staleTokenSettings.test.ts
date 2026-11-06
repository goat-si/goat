import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sourceControlTokenPatch } from "@goat/shared/serverSettings";
import { layerServerSettings } from "../serverSettingsLayers.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";

it.effect(
  "saving one host from a stale client preserves the other host's newer secret reference",
  () =>
    Effect.gen(function* () {
      const service = yield* ServerSettings.ServerSettingsService;
      const oldRef = { provider: "vault", reference: "old" };
      const newRef = { provider: "vault", reference: "new" };
      const cached = { "a.example": "old-a", "b.example": oldRef };
      yield* service.updateSettings({ sourceControlHosts: { github: { tokens: cached } } });
      yield* service.updateSettings({
        sourceControlHosts: { github: { tokens: { "b.example": newRef } } },
      });
      const saved = yield* service.updateSettings(
        sourceControlTokenPatch("github", "a.example", "new-a"),
      );
      assert.deepStrictEqual(saved.sourceControlHosts.github?.tokens, {
        "a.example": "new-a",
        "b.example": newRef,
      });
    }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);
