import { expect, it } from "@effect/vitest";
import { ANTIGRAVITY_DEFAULT_MODEL } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";

import { layerTest, makeHarness, modelConfig, started } from "./AntigravityProvider.testkit.ts";
import { mergeProviderSnapshot } from "./ProviderRegistry.ts";

it.layer(layerTest)("Antigravity provider thinking defaults", (it) => {
  it.effect(
    "does not let live session thinking-level or model changes overwrite catalog defaults",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* harness.initialize;
          const thinking = (
            currentValue: string,
            levels: ReadonlyArray<string> = ["low", "medium", "high", "xhigh"],
          ) =>
            ({
              id: "thought_level",
              name: "Thinking Level",
              category: "thought_level",
              type: "select",
              currentValue,
              options: levels.map((value) => ({ value, name: value })),
            }) satisfies EffectAcpSchema.SessionConfigOption;
          const catalogModels = {
            ...modelConfig,
            currentValue: "neon",
            options: [
              { value: "neon", name: "Neon" },
              { value: "carbon", name: "Carbon" },
            ],
          } satisfies EffectAcpSchema.SessionConfigOption;
          yield* harness.provider.onSessionStarted(
            {
              ...started,
              sessionSetupResult: {
                sessionId: "session-fresh",
                configOptions: [catalogModels, thinking("high")],
              },
            },
            "/workspace",
          );

          // A live chat session setting thought_level=xhigh must not pollute the catalog default.
          yield* harness.provider.onConfigOptionsUpdated([catalogModels, thinking("xhigh")]);
          // A live chat session switching to another model with a custom level must neither move
          // isDefault nor overwrite cached thinking defaults for that model.
          const switchedToCarbon = {
            ...catalogModels,
            currentValue: "carbon",
          } satisfies EffectAcpSchema.SessionConfigOption;
          yield* harness.provider.onConfigOptionsUpdated([
            switchedToCarbon,
            thinking("low", ["low", "medium", "high"]),
          ]);

          const snapshot = yield* harness.provider.snapshot.getSnapshot;
          const neon = snapshot.models.find((model) => model.slug === "neon");
          const carbon = snapshot.models.find((model) => model.slug === "carbon");
          expect(neon?.isDefault).toBe(true);
          expect(neon?.aliases).toContain(ANTIGRAVITY_DEFAULT_MODEL);
          expect(neon?.capabilities?.optionDescriptors?.[0]).toMatchObject({
            id: "thought_level",
            currentValue: "high",
          });
          expect(carbon?.isDefault).toBeUndefined();
          expect(carbon?.capabilities?.optionDescriptors).toEqual([]);

          // Updating an observed model's choices keeps its recorded default while still offered,
          // and falls back if the agent removes that default.
          yield* harness.provider.onConfigOptionsUpdated([
            catalogModels,
            thinking("max", ["low", "medium", "high", "xhigh", "max"]),
          ]);
          const expanded = (yield* harness.provider.snapshot.getSnapshot).models.find(
            (model) => model.slug === "neon",
          )?.capabilities?.optionDescriptors?.[0];
          expect(expanded).toMatchObject({
            id: "thought_level",
            currentValue: "high",
            options: [
              { id: "low" },
              { id: "medium" },
              { id: "high" },
              { id: "xhigh" },
              { id: "max" },
            ],
          });

          yield* harness.provider.onConfigOptionsUpdated([
            catalogModels,
            thinking("medium", ["low", "medium"]),
          ]);
          const narrowed = (yield* harness.provider.snapshot.getSnapshot).models.find(
            (model) => model.slug === "neon",
          )?.capabilities?.optionDescriptors?.[0];
          expect(narrowed).toMatchObject({
            id: "thought_level",
            currentValue: "medium",
            options: [{ id: "low" }, { id: "medium" }],
          });

          // A catalog probe records each model's default level and keeps the default model intact.
          yield* harness.provider.onConfigOptionsUpdated(
            [switchedToCarbon, thinking("medium", ["low", "medium", "high"])],
            undefined,
            { fromCatalogProbe: true },
          );
          const probed = yield* harness.provider.snapshot.getSnapshot;
          expect(probed.models.find((model) => model.slug === "neon")?.isDefault).toBe(true);
          expect(
            probed.models.find((model) => model.slug === "carbon")?.capabilities
              ?.optionDescriptors?.[0],
          ).toMatchObject({ id: "thought_level", currentValue: "medium" });

          // After a restart, resuming a session on another model at xhigh leaves unobserved
          // models and default identity unset so the registry retains the cached defaults.
          const restarted = yield* makeHarness();
          yield* restarted.initialize;
          yield* restarted.provider.onSessionStarted(
            {
              ...started,
              sessionSetupResult: {
                sessionId: "session-resumed",
                configOptions: [switchedToCarbon, thinking("xhigh")],
              },
            },
            "/workspace",
            undefined,
            { resumed: true },
          );
          const merged = mergeProviderSnapshot(
            probed,
            yield* restarted.provider.snapshot.getSnapshot,
          );
          const mergedNeon = merged.models.find((model) => model.slug === "neon");
          const mergedCarbon = merged.models.find((model) => model.slug === "carbon");
          expect(mergedNeon?.isDefault).toBe(true);
          expect(mergedNeon?.aliases).toContain(ANTIGRAVITY_DEFAULT_MODEL);
          expect(mergedNeon?.capabilities?.optionDescriptors?.[0]).toMatchObject({
            id: "thought_level",
            currentValue: "medium",
          });
          expect(mergedCarbon?.isDefault).toBeUndefined();
          expect(mergedCarbon?.aliases).toBeUndefined();
          expect(mergedCarbon?.capabilities?.optionDescriptors?.[0]).toMatchObject({
            id: "thought_level",
            currentValue: "medium",
          });

          // A later authoritative session start replaces the cached default model.
          yield* restarted.provider.onSessionStarted(
            {
              ...started,
              sessionSetupResult: {
                sessionId: "session-fresh-after-restart",
                configOptions: [switchedToCarbon, thinking("low", ["low", "medium", "high"])],
              },
            },
            "/workspace",
          );
          const updatedAfterFresh = mergeProviderSnapshot(
            merged,
            yield* restarted.provider.snapshot.getSnapshot,
          );
          expect(updatedAfterFresh.models.find((model) => model.slug === "neon")?.isDefault).toBe(
            undefined,
          );
          expect(updatedAfterFresh.models.find((model) => model.slug === "carbon")?.isDefault).toBe(
            true,
          );
          expect(
            updatedAfterFresh.models.find((model) => model.slug === "carbon")?.aliases,
          ).toContain(ANTIGRAVITY_DEFAULT_MODEL);
        }),
      ),
  );
});
