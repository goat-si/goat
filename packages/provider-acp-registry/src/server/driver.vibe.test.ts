import { ProviderInstanceId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "../settings.ts";
import { applyAcpRegistryLiveConfiguration, buildCheckedAcpRegistrySnapshot } from "./driver.ts";
import { normalizeAcpRegistryLiveConfiguration } from "./probe.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry_test",
};
const noSessionManagement = {
  canList: false,
  canLoad: false,
  canResume: false,
  canLogout: false,
  canDelete: false,
  canConfigureProviders: false,
} as const;

it("keeps each Mistral Vibe model's own thinking levels", () => {
  const provider = buildCheckedAcpRegistrySnapshot({
    ...identity,
    settings: decodeSettings({ agentId: "mistral-vibe" }),
    checkedAt: "2026-11-18T10:00:00.000Z",
    inspection: {
      status: "ready",
      agentId: "mistral-vibe",
      version: "3.1.1",
      distribution: "binary",
    },
    probe: {
      probe: {
        instanceId: identity.instanceId,
        ready: true,
        icon: null,
        authMethods: [],
        models: [],
        currentModelId: null,
        configOptions: [],
        sessionManagement: noSessionManagement,
      },
      slashCommands: [],
      skills: [],
    },
  });
  // Mistral Vibe 3.1.1 sends its levels under category "thinking", for the session's model only.
  const vibeSession = (model: string, levels: ReadonlyArray<string>) =>
    normalizeAcpRegistryLiveConfiguration([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: model,
        options: ["mistral-large-4-0-3", "mistral-medium-3.5"].map((value) => ({
          value,
          name: value,
        })),
      },
      {
        id: "thinking",
        name: "Thinking",
        category: "thinking",
        type: "select",
        currentValue: "high",
        options: levels.map((value) => ({ value, name: value })),
      },
    ]);
  const thinking = (levels: ReadonlyArray<string>) => ({
    id: "thinking",
    label: "Thinking",
    type: "select",
    options: levels.map((id) => ({ id, label: id })),
    currentValue: "high",
    role: "reasoning",
  });
  const descriptors = (snapshot: typeof provider) =>
    snapshot.models.map((model) => [model.slug, model.capabilities?.optionDescriptors ?? []]);

  const onLarge = applyAcpRegistryLiveConfiguration(
    provider,
    vibeSession("mistral-large-4-0-3", ["low", "medium", "high"]),
    [],
  );
  expect(descriptors(onLarge)).toEqual([
    ["mistral-large-4-0-3", [thinking(["low", "medium", "high"])]],
    ["mistral-medium-3.5", []],
  ]);
  const onMedium = applyAcpRegistryLiveConfiguration(
    onLarge,
    vibeSession("mistral-medium-3.5", ["off", "high"]),
    [],
  );
  expect(descriptors(onMedium)).toEqual([
    ["mistral-large-4-0-3", [thinking(["low", "medium", "high"])]],
    ["mistral-medium-3.5", [thinking(["off", "high"])]],
  ]);
});
