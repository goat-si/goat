import { expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
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
