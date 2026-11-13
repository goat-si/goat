import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import { describe, expect, it } from "vite-plus/test";
import { deriveEffectiveComposerModelState } from "./composerDraftStore";
import { getComposerProviderState } from "./components/chat/composerProviderState";
import { provider, settingsWithProviderInstances } from "./modelSelection.testkit";

describe("composer model option precedence", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const driver = ProviderDriverKind.make("claudeAgent");
  const base = provider({ provider: driver, instanceId, models: ["claude-opus-5-5"] });
  const providers = [
    {
      ...base,
      models: base.models.map((model) => ({
        ...model,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select" as const,
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
              currentValue: "medium",
            },
          ],
        },
      })),
    },
  ];
  const settingsDefault = createModelSelection(instanceId, "claude-opus-5-5", [
    { id: "effort", value: "high" },
  ]);
  const dispatchedSelection = (
    threadModelSelection: ReturnType<typeof createModelSelection> | null,
  ) => {
    const state = deriveEffectiveComposerModelState({
      draft: null,
      providers,
      selectedProvider: driver,
      selectedInstanceId: instanceId,
      threadModelSelection,
      projectModelSelection: settingsDefault,
      settings: settingsWithProviderInstances(),
    });
    const dispatch = getComposerProviderState({
      provider: driver,
      model: state.selectedModel,
      models: providers[0]!.models,
      modelOptions: state.modelOptions?.[instanceId],
      planModeEnabled: false,
    });
    return createModelSelection(instanceId, state.selectedModel, dispatch.modelOptionsForDispatch);
  };

  it("does not inherit settings options for an optionless existing thread", () => {
    const threadSelection = createModelSelection(instanceId, "claude-opus-5-5");
    expect(dispatchedSelection(threadSelection)).toEqual(threadSelection);
  });

  it("keeps the options it was saved with", () => {
    const threadSelection = createModelSelection(instanceId, "claude-opus-5-5", [
      { id: "effort", value: "medium" },
    ]);
    expect(dispatchedSelection(threadSelection)).toEqual(threadSelection);
  });

  it("leaves the settings default's options in place before a thread exists", () => {
    expect(dispatchedSelection(null)).toEqual(settingsDefault);
  });
});
