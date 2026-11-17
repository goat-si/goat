import { RegistryContext } from "@effect/atom-react";
import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import { makeThreadRequestsResolvedAnnouncer } from "@goat/client-runtime/state/thread-requests";
import { EnvironmentId, RuntimeRequestId, ThreadId, type ScopedThreadRef } from "@goat/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { usePendingUserInputAnswers } from "../../questionAttachments";

type Snapshot = {
  items: readonly DecisionItem[];
  authoritativeRefs: readonly ScopedThreadRef[];
  loadingRefs: readonly ScopedThreadRef[];
  errors: readonly { ref: ScopedThreadRef; message: string }[];
  isLoading: boolean;
};
const state = vi.hoisted<{
  registry: AtomRegistry.AtomRegistry | null;
  snapshot: Atom.Writable<Snapshot> | null;
}>(() => ({ registry: null, snapshot: null }));
vi.mock("../../state/decisionInbox", async () => {
  const { Atom } = await import("effect/reactivity");
  state.snapshot = Atom.make<Snapshot>({
    items: [],
    authoritativeRefs: [],
    loadingRefs: [],
    errors: [],
    isLoading: false,
  }).pipe(Atom.keepAlive);
  return { decisionInbox: { itemsAtom: state.snapshot } };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));

import { useDecisionInbox } from "./useDecisionInbox";

const environmentId = EnvironmentId.make("secondary");
const threadId = ThreadId.make("question-thread");
const requestId = RuntimeRequestId.make("question");
const question: Extract<DecisionItem, { kind: "user_input" }> = {
  id: JSON.stringify([environmentId, threadId, requestId]),
  ref: { environmentId, threadId },
  routing: { routedTo: "person" },
  kind: "user_input",
  createdAt: "2026-10-01T00:00:00.000Z",
  request: {
    requestId,
    createdAt: "2026-10-01T00:00:00.000Z",
    responseCapability: "live",
    dismissible: false,
    questions: [
      {
        id: "approach",
        header: "Approach",
        question: "How should this be fixed?",
        multiSelect: false,
        options: [],
      },
    ],
  },
};

function setup() {
  state.registry = AtomRegistry.make();
  state.registry.set(state.snapshot!, {
    items: [question],
    authoritativeRefs: [question.ref],
    loadingRefs: [],
    errors: [],
    isLoading: false,
  });
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  usePendingUserInputAnswers.setState({}, true);
  const latest: { inbox: ReturnType<typeof useDecisionInbox> | null } = { inbox: null };
  function Harness() {
    const value = useDecisionInbox();
    useLayoutEffect(() => {
      latest.inbox = value;
    });
    return null;
  }
  const registry = state.registry;
  return {
    latest,
    ui: (
      <RegistryContext.Provider value={registry}>
        <Harness />
      </RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

it("Stop keeps an answer typed in the Decisions inbox in the thread's draft", async () => {
  using inbox = setup();
  // A bare hook host; nothing here links or navigates.
  await using _screen = await render(inbox.ui, { router: false });
  await act(() =>
    inbox.latest.inbox!.setAnswers(question.id, { approach: { customAnswer: "Use the cache" } }),
  );

  // Stop cancels the open question, so the typed answer was never sent.
  await act(() =>
    makeThreadRequestsResolvedAnnouncer(
      environmentId,
      threadId,
    )([{ id: requestId, status: "cancelled" }]),
  );

  expect(
    useComposerDraftStore.getState().getComposerDraft({ environmentId, threadId })?.prompt,
  ).toBe("Use the cache");
});
