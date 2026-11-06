import { expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, ProviderInstanceId, ProviderDriverKind } from "@goat/contracts";
import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import { createModelSelection } from "@goat/shared/model";
import { useComposerDraftStore } from "./composerDraftStore";

it("retains old provider selections and draft text when rehydrating", () => {
  const key = scopedThreadKey(scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("one")));
  const selection = {
    provider: "codex",
    model: "gpt-5.4",
    options: { reasoningEffort: "high", fastMode: true },
  };
  const state = useComposerDraftStore.persist.getOptions().merge!(
    {
      draftsByThreadKey: {
        [key]: {
          prompt: "keep this draft",
          attachments: [],
          modelSelectionByProvider: { codex: selection },
          activeProvider: "codex",
        },
      },
      draftThreadsByThreadKey: {},
      stickyModelSelectionByProvider: { codex: selection },
      stickyActiveProvider: "codex",
    },
    useComposerDraftStore.getState(),
  );
  const expected = {
    instanceId: "codex",
    model: "gpt-5.4",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ],
  };
  expect(state.draftsByThreadKey[key]).toMatchObject({
    prompt: "keep this draft",
    modelSelectionByProvider: { codex: expected },
  });
  expect(state.stickyModelSelectionByProvider).toEqual({ codex: expected });
});

it("keeps an instance-scoped custom model even when its name is a Codex alias", () => {
  const ref = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("custom"));
  const instanceId = ProviderInstanceId.make("codex_custom");
  const store = useComposerDraftStore.getState();
  store.setModelSelection(ref, createModelSelection(instanceId, "gpt-5.3"), { explicit: true });
  expect(
    useComposerDraftStore.getState().getComposerDraft(ref)?.modelSelectionByProvider[instanceId]
      ?.model,
  ).toBe("gpt-5.3");
  store.setProviderModelOptions(
    ref,
    ProviderDriverKind.make("codex"),
    [{ id: "reasoningEffort", value: "low" }],
    { instanceId, model: "gpt-5.3", persistSticky: true },
  );
  expect(useComposerDraftStore.getState().stickyOptionsByModelByProvider[instanceId]).toEqual({
    "gpt-5.3": [{ id: "reasoningEffort", value: "low" }],
  });
});
