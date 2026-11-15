import { ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import { applyAcpRegistryLiveConfiguration, buildCheckedAcpRegistrySnapshot } from "./driver.ts";
import { makeAcpRegistryLearnedModels } from "./learnedModels.ts";
import { normalizeAcpRegistryLiveConfiguration } from "./probe.ts";

const checked = buildCheckedAcpRegistrySnapshot({
  instanceId: ProviderInstanceId.make("acpRegistry_learned"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry_learned",
  settings: Schema.decodeSync(AcpRegistrySettings)({ agentId: "test-agent" }),
  checkedAt: "2026-11-15T00:00:00.000Z",
  inspection: { status: "ready", agentId: "test-agent", version: "1.0.0", distribution: "npx" },
});

const effortBySlug = (snapshot: ServerProvider) =>
  snapshot.models
    .map(
      (model) =>
        model.slug +
        ":" +
        (model.capabilities?.optionDescriptors ?? []).map((option) => option.id).join("+"),
    )
    .join();

/** A session under `environmentKey` reporting an effort option for its current model. */
const session = (environmentKey: string, currentModelId: string) => ({
  ...normalizeAcpRegistryLiveConfiguration(
    [
      {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ],
    undefined,
    {
      currentModelId,
      availableModels: [
        { modelId: "model-a", name: "model-a" },
        { modelId: "model-b", name: "model-b" },
      ],
    },
  ),
  environmentKey,
});

it.effect("a check that outlives its profile leaves the next profile's options alone", () =>
  Effect.gen(function* () {
    const learned = yield* makeAcpRegistryLearnedModels((provider, configuration, previous) =>
      applyAcpRegistryLiveConfiguration(provider, configuration, [], previous),
    );
    yield* learned.apply(checked, session("A", "model-a"), "A", {
      generation: yield* learned.generation,
    });
    // A second check under A starts, and is still reading A when the host moves to B.
    const heldUnderA = { generation: yield* learned.generation };
    let shown = yield* learned.apply(checked, session("B", "model-b"), "B", undefined);
    shown = yield* learned.apply(shown, session("B", "model-a"), "B", undefined);
    expect(effortBySlug(shown)).toBe("model-a:effort,model-b:effort");
    // The held check finishes with what it read; the coordinator now holds B's latest.
    const late = yield* learned.apply(checked, session("B", "model-a"), "A", heldUnderA);
    expect(effortBySlug(late)).toBe(effortBySlug(checked));
    // B's next check still has everything B's sessions taught.
    const nextUnderB = yield* learned.apply(checked, session("B", "model-a"), "B", {
      generation: yield* learned.generation,
    });
    expect(effortBySlug(nextUnderB)).toBe("model-a:effort,model-b:effort");
  }),
);
