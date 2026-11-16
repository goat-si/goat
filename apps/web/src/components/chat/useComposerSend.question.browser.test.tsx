import { setupSshComposer, state } from "~/test/sshComposerFixture";
import { useLayoutEffect, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";

/** A thread with one open question and a send hook whose turn guards all block. */
async function openQuestion(
  fixture: Awaited<ReturnType<typeof setupSshComposer>>,
  extraInput: Record<string, unknown> = {},
) {
  const { EnvironmentId, NodeId, RuntimeRequestId, ThreadId, TurnItemId } =
    await import("@goat/contracts");
  const { AsyncResult } = await import("effect/reactivity");
  const { makeThreadFixture, makeThreadProjectionFixture } = await import("~/test-fixtures");
  const { AppAtomRegistryProvider } = await import("~/rpc/atomRegistry");
  const { useComposerDraftStore } = await import("~/composerDraftStore");
  const { questionAttachmentDraftId } = await import("~/questionAttachments");
  const { act } = await import("../../../test/render");
  const environmentId = EnvironmentId.make("question-send-env");
  const threadId = ThreadId.make("question-send-thread");
  const requestId = RuntimeRequestId.make("question-send-request");
  const target = { environmentId, threadId };
  const questionTarget = questionAttachmentDraftId(environmentId, threadId, requestId, "q");
  const base = makeThreadProjectionFixture();
  const projection = {
    ...base,
    thread: { ...base.thread, id: threadId },
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make("q"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input" as const,
        status: "pending" as const,
        responseCapability: { type: "message" as const },
        createdAt: base.updatedAt,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make("q"),
        threadId,
        runId: null,
        nodeId: NodeId.make("q"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed" as const,
        title: null,
        startedAt: base.updatedAt,
        completedAt: base.updatedAt,
        updatedAt: base.updatedAt,
        type: "user_input_request" as const,
        requestId,
        questions: [
          { id: "q", header: "Question", question: "Answer?", options: [], multiSelect: false },
        ],
      },
    ],
  };
  const { useComposerSend } = await import("./useComposerSend");
  const { usePendingThreadRequests } = await import("./usePendingThreadRequests");
  state.normal.mockResolvedValue(AsyncResult.success(undefined));
  let requests!: ReturnType<typeof usePendingThreadRequests>;
  let send!: ReturnType<typeof useComposerSend>["onSend"];
  let unavailable = false;
  function Probe() {
    const promptRef = useRef("");
    const composerRef = useRef(null);
    const currentRequests = usePendingThreadRequests({
      environmentId,
      activeThreadId: threadId,
      serverProjection: projection,
      supportsQuestionAttachments: true,
      composerDraftTarget: target,
      setComposerDraftPrompt: (id, value) => useComposerDraftStore.getState().setPrompt(id, value),
      promptRef,
      composerRef,
      setThreadError: () => {},
    });
    const input = {
      ...extraInput,
      environmentId,
      routeThreadRef: target,
      activeThreadRef: target,
      activeThread: makeThreadFixture({ id: threadId }),
      routeThreadKey: "question-send",
      currentRouteThreadKeyRef: { current: "question-send" },
      composerDraftTarget: target,
      promptRef,
      composerRef,
      queuedRunEdit: { isEditing: false },
      activeEnvironmentUnavailable: unavailable,
      isSendBusy: true,
      isConnecting: true,
      usageLimitsOffered: false,
      pendingApprovals: [],
      respondingRequestIds: [],
      activePendingProgress: currentRequests.activePendingProgress,
      onAdvanceActivePendingUserInput: currentRequests.onAdvanceActivePendingUserInput,
      onChangeActivePendingUserInputCustomAnswer:
        currentRequests.onChangeActivePendingUserInputCustomAnswer,
      readPendingEnvironmentChange: () => null,
      refreshBeforeSend: () => null,
    } as unknown as Parameters<typeof useComposerSend>[0];
    const currentSend = useComposerSend(input).onSend;
    useLayoutEffect(() => {
      requests = currentRequests;
      send = currentSend;
    });
    return null;
  }
  const show = () =>
    fixture.rerender(
      <AppAtomRegistryProvider>
        <Probe />
      </AppAtomRegistryProvider>,
    );
  await show();
  return {
    environmentId,
    threadId,
    requestId,
    questionTarget,
    show,
    act,
    requests: () => requests,
    send: () => send(),
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}

it("sends a question answer through turn blockers and preserves it under answer guards", async () => {
  await using fixture = await setupSshComposer();
  const question = await openQuestion(fixture);
  const { environmentId, threadId, requestId, questionTarget, show, act } = question;
  const { readEnvironmentScope } = await import("~/state/session");
  const { makeThreadRequestsResolvedAnnouncer } =
    await import("@goat/client-runtime/state/thread-requests");
  const { changeQuestionAttachmentPreparation } = await import("~/questionAttachments");
  const requests = () => question.requests();
  const send = () => question.send();
  await act(() => requests().onChangeActivePendingUserInputCustomAnswer("q", "My answer"));
  vi.mocked(readEnvironmentScope).mockReturnValue(false);
  await act(async () => send());
  expect(state.normal).not.toHaveBeenCalled();
  expect(requests().activePendingDraftAnswers.q?.customAnswer).toBe("My answer");
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  question.setUnavailable(true);
  await show();
  await act(async () => send());
  expect(state.normal).not.toHaveBeenCalled();
  expect(requests().activePendingDraftAnswers.q?.customAnswer).toBe("My answer");
  question.setUnavailable(false);
  await act(() => changeQuestionAttachmentPreparation(questionTarget, 1));
  await show();
  await act(async () => send());
  expect(state.normal).not.toHaveBeenCalled();
  expect(requests().activePendingDraftAnswers.q?.customAnswer).toBe("My answer");
  await act(() => changeQuestionAttachmentPreparation(questionTarget, -1));
  await act(async () => send());
  expect(state.normal).toHaveBeenCalledOnce();
  expect(state.normal).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId,
      input: expect.objectContaining({ threadId, requestId, answers: { q: "My answer" } }),
    }),
  );
  await act(() =>
    makeThreadRequestsResolvedAnnouncer(
      environmentId,
      threadId,
    )([{ id: requestId, status: "resolved" }]),
  );
  expect(requests().activePendingDraftAnswers.q?.customAnswer).toBeUndefined();
});

it("/side typed as an answer opens the side chat and leaves the question pending", async () => {
  await using fixture = await setupSshComposer();
  const question = await openQuestion(fixture, {
    sideChatAvailable: true,
    activeThreadKey: "question-send-thread-key",
  });
  const { useSideChatStore } = await import("../sideChat/sideChatStore");
  const { act } = question;
  await act(() =>
    question.requests().onChangeActivePendingUserInputCustomAnswer("q", "/side what changed?"),
  );

  await act(async () => question.send());

  expect(state.normal).not.toHaveBeenCalled();
  expect(useSideChatStore.getState().pendingPrompts["question-send-thread-key"]).toBe(
    "what changed?",
  );
  expect(question.requests().activePendingProgress).not.toBeNull();
  expect(question.requests().activePendingDraftAnswers.q?.customAnswer ?? "").toBe("");
});
