import { scopeThreadRef } from "@goat/client-runtime/environment";
import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import { useComposerDraftStore } from "./composerDraftStore";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { deriveEffectiveComposerModelState } from "./composerModelState";
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

const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const threadRef = scopeThreadRef(EnvironmentId.make("environment-local"), ThreadId.make("seeded"));
const toSelections = (options: { reasoningEffort: string }) => [
  { id: "reasoningEffort", value: options.reasoningEffort },
];
const modelSelection = (model: string, options?: { reasoningEffort: string }) =>
  createModelSelection(CODEX_INSTANCE, model, options ? toSelections(options) : undefined);

describe("seeded draft model on a started thread", () => {
  beforeEach(() => useComposerDraftStore.setState(useComposerDraftStore.getInitialState()));
  const providers: ReadonlyArray<ServerProvider> = [
    {
      instanceId: CODEX_INSTANCE,
      driver: CODEX_DRIVER,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: ["gpt-5.4", "gpt-5.3-codex"].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: {},
      })),
      slashCommands: [],
      skills: [],
    },
  ];
  const threadSelection = modelSelection("gpt-5.3-codex", {
    reasoningEffort: "low",
  });
  const effective = (threadStarted: boolean) => {
    const state = deriveEffectiveComposerModelState({
      draft: useComposerDraftStore.getState().getComposerDraft(threadRef),
      threadStarted,
      providers,
      selectedProvider: CODEX_DRIVER,
      selectedInstanceId: CODEX_INSTANCE,
      threadModelSelection: threadSelection,
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
    return {
      model: state.selectedModel,
      options: state.modelOptions?.[CODEX_INSTANCE] ?? [],
    };
  };

  it("applies the seed only until the thread starts, then only an explicit pick wins", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadRef, modelSelection("gpt-5.4", { reasoningEffort: "high" }));

    expect(effective(false)).toEqual({
      model: "gpt-5.4",
      options: toSelections({ reasoningEffort: "high" }),
    });
    expect(effective(true)).toEqual({
      model: "gpt-5.3-codex",
      options: toSelections({ reasoningEffort: "low" }),
    });

    store.setModelSelection(threadRef, modelSelection("gpt-5.4", { reasoningEffort: "high" }), {
      explicit: true,
    });
    expect(effective(true)).toEqual({
      model: "gpt-5.4",
      options: toSelections({ reasoningEffort: "high" }),
    });
  });

  it("keeps the thread's model when traits change over a seed", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadRef, modelSelection("gpt-5.4"));
    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "high" }),
      { instanceId: CODEX_INSTANCE, model: "gpt-5.3-codex" },
    );

    expect(effective(true)).toEqual({
      model: "gpt-5.3-codex",
      options: toSelections({ reasoningEffort: "high" }),
    });
  });
  it("keeps the sticky model's own traits when traits change on another shown model", () => {
    const store = useComposerDraftStore.getState();
    store.setStickyModelSelection(modelSelection("gpt-5.3-codex", { reasoningEffort: "xhigh" }));

    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "low" }),
      { instanceId: CODEX_INSTANCE, model: "gpt-5.4", persistSticky: true },
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection("gpt-5.3-codex", { reasoningEffort: "xhigh" }),
    );
    expect(
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[CODEX_INSTANCE]?.["gpt-5.4"],
    ).toEqual(toSelections({ reasoningEffort: "low" }));

    store.setProviderModelOptions(threadRef, CODEX_DRIVER, null, {
      instanceId: CODEX_INSTANCE,
      model: "gpt-5.4",
      persistSticky: true,
    });

    const state = useComposerDraftStore.getState();
    expect(state.stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection("gpt-5.3-codex", { reasoningEffort: "xhigh" }),
    );
    expect(state.stickyOptionsByModelByProvider[CODEX_INSTANCE]?.["gpt-5.4"]).toBeUndefined();
  });
});
