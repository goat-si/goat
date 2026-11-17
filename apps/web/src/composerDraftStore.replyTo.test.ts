import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import {
  type ComposerContextId,
  EnvironmentId,
  MessageId,
  type ResponseContextRecord,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { partializeComposerDraftStoreState, useComposerDraftStore } from "./composerDraftStore";

const environmentId = EnvironmentId.make("environment-local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("reply-thread"));
const threadKey = scopedThreadKey(threadRef);

const reply: ResponseContextRecord = {
  version: 1,
  kind: "response",
  contextId: "response_m1" as ComposerContextId,
  label: "The fix is in",
  citation: {
    version: 1,
    environmentId,
    threadId: threadRef.threadId,
    messageId: MessageId.make("m1"),
    text: "The fix is in",
    start: 0,
    end: 13,
    prefix: "",
    suffix: "",
  },
  itemId: TurnItemId.make("item-1"),
};

function setup() {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const persistApi = useComposerDraftStore.persist as unknown as {
    getOptions: () => {
      merge: (
        persistedState: unknown,
        currentState: ReturnType<typeof useComposerDraftStore.getState>,
      ) => ReturnType<typeof useComposerDraftStore.getState>;
    };
  };
  const rehydrate = (persisted: unknown) =>
    persistApi.getOptions().merge(persisted, useComposerDraftStore.getInitialState());
  return { store: useComposerDraftStore.getState(), rehydrate };
}

describe("the response a draft replies to", () => {
  it("survives a reload with nothing else in the draft", () => {
    const { store, rehydrate } = setup();
    store.setReplyTo(threadRef, reply);
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    expect(persisted.draftsByThreadKey[threadKey]?.replyTo).toEqual(reply);
    expect(rehydrate(persisted).draftsByThreadKey[threadKey]?.replyTo).toEqual(reply);
  });

  it("drops a malformed stored reply and keeps the rest of the draft", () => {
    const { store, rehydrate } = setup();
    store.setPrompt(threadRef, "keep this");
    store.setReplyTo(threadRef, reply);
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    const draft = persisted.draftsByThreadKey[threadKey];
    const broken = {
      ...persisted,
      draftsByThreadKey: { [threadKey]: { ...draft, replyTo: { ...reply, itemId: 7 } } },
    };
    const restored = rehydrate(broken).draftsByThreadKey[threadKey];
    expect(restored?.prompt).toBe("keep this");
    expect(restored?.replyTo).toBeNull();
  });

  it("goes away with the draft when the reply is cancelled and nothing else is left", () => {
    const { store } = setup();
    store.setReplyTo(threadRef, reply);
    expect(useComposerDraftStore.getState().draftsByThreadKey[threadKey]?.replyTo).toEqual(reply);
    store.setReplyTo(threadRef, null);
    expect(useComposerDraftStore.getState().draftsByThreadKey[threadKey]).toBeUndefined();
  });

  it("is cleared with the rest of the composer content", () => {
    const { store } = setup();
    store.setPrompt(threadRef, "text");
    store.setReplyTo(threadRef, reply);
    store.clearComposerContent(threadRef);
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[threadKey]?.replyTo ?? null,
    ).toBeNull();
  });
});
