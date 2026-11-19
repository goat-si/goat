import type { ComposerContextId } from "@goat/contracts";
import { setupSshComposer, state } from "~/test/sshComposerFixture";
import { useLayoutEffect, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";

/**
 * A server thread with one pending command approval and a send that redirects the agent: the
 * composer shows the approval, so a send declines it before the message goes out.
 */
async function redirectSend(
  fixture: Awaited<ReturnType<typeof setupSshComposer>>,
  options: {
    readonly composerMode: "full-access" | "approval-required";
    readonly refuse: boolean;
    readonly input?: Record<string, unknown>;
    readonly sendContext?: Record<string, unknown>;
  },
) {
  const { EnvironmentId, ProjectId, RuntimeRequestId, ThreadId, ProviderInstanceId } =
    await import("@goat/contracts");
  const { AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { makeThreadFixture } = await import("~/test-fixtures");
  const { AppAtomRegistryProvider } = await import("~/rpc/atomRegistry");
  const { readEnvironmentScope } = await import("~/state/session");
  const { useComposerSend } = await import("./useComposerSend");
  const environmentId = EnvironmentId.make("redirect-env");
  const threadId = ThreadId.make("redirect-thread");
  const requestId = RuntimeRequestId.make("redirect-approval");
  const target = { environmentId, threadId };
  const refusal =
    "This thread has a turn running, and changing its permission mode would end it. Wait for the turn to finish, or press Stop first.";
  const calls: Array<string> = [];
  const errors: Array<string | null> = [];
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  state.normal.mockImplementation(async () => {
    calls.push("startTurn");
    return AsyncResult.success({ sequence: 1 });
  });
  const persist = vi.fn(async (input: { readonly runtimeMode: string }) => {
    calls.push("settings:" + input.runtimeMode);
    return options.refuse
      ? AsyncResult.failure(Cause.fail(new Error(refusal)))
      : AsyncResult.success(undefined);
  });
  const respond = vi.fn(async (_requestId: string, decision: string) => {
    calls.push("approval:" + decision);
    return AsyncResult.success(undefined);
  });
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
  let send!: () => Promise<void>;
  const promptRef = { current: "Stop that and list the files instead." };
  function Probe() {
    const composerRef = useRef({
      getSendContext: () => ({
        providerAvailable: true,
        multipleModelSelections: null,
        images: [],
        files: [],
        terminalContexts: [],
        previewAnnotations: [],
        reviewComments: [],
        threadContexts: [],
        previewTabs: [],
        selectedProvider: "codex",
        selectedModel: modelSelection.model,
        selectedProviderModels: [],
        selectedPromptEffort: null,
        selectedModelSelection: modelSelection,
        interactionMode: "default",
        interactionModeEnabled: false,
        shownPendingApprovalIds: [requestId],
        answeringPendingUserInput: false,
        ...options.sendContext,
      }),
      validateProviderInput: () => true,
      hasPendingAttachments: () => false,
      resetCursorState: () => {},
    });
    const input = {
      environmentId,
      routeThreadRef: target,
      activeThreadRef: target,
      activeThread: makeThreadFixture({ id: threadId, runtimeMode: "full-access" }),
      activeThreadKey: "redirect",
      activeProject: { id: ProjectId.make("project"), environmentId, cwd: "/repo" },
      routeThreadKey: "redirect",
      currentRouteThreadKeyRef: { current: "redirect" },
      composerDraftTarget: target,
      promptRef,
      composerRef,
      composerImagesRef: { current: [] },
      composerFilesRef: { current: [] },
      composerTerminalContextsRef: { current: [] },
      feedbackUploadsInFlightRef: { current: new Set() },
      queuedRunEdit: { isEditing: false },
      isServerThread: true,
      isLocalDraftThread: false,
      isCloudThread: false,
      draftId: null,
      draftThread: null,
      phase: "running",
      runtimeMode: options.composerMode,
      sendEnvMode: "local",
      localCheckoutBranchMismatch: null,
      providerInstanceEntries: [],
      cloudState: { composerBlockReason: null },
      activeEnvironmentUnavailable: false,
      isSendBusy: false,
      isConnecting: false,
      needsLoadBalancing: false,
      usageLimitsOffered: false,
      pendingApprovals: [
        {
          requestId,
          requestKind: "command",
          createdAt: "2026-11-17T00:00:00.000Z",
          responseCapability: "live",
        },
      ],
      respondingRequestIds: [],
      activePendingProgress: null,
      onRespondToApproval: respond,
      persistThreadSettingsForNextTurn: persist,
      setThreadError: (_threadId: unknown, error: string | null) => errors.push(error),
      setDockedDraftHeroThreadKey: () => {},
      setOptimisticUserMessages: () => {},
      optimisticBlobPreviews: { track: () => {}, release: () => {} },
      beginLocalDispatch: () => {},
      resetLocalDispatch: () => {},
      beginWorktreeSetup: () => {},
      anchorNewTurn: () => {},
      clearUsageLimitsFor: () => {},
      readPendingEnvironmentChange: () => null,
      refreshBeforeSend: () => null,
      setKeepFullHistory: () => {},
      setSetupQueueSendThreadKey: () => {},
      captureDraftHeroComposerRect: () => {},
      acknowledgeActiveThreadWoke: () => {},
      setFeedbackSubmissionsByThreadKey: () => {},
      handleInteractionModeChange: () => {},
      handleNewThreadInActiveProject: () => {},
      openUsageLimits: () => false,
      keepFullHistory: false,
      resumeCompactionTokens: null,
      sendQueuesBehindSetup: false,
      isDraftHeroState: false,
      startFromOrigin: false,
      activeThreadBranch: null,
      activeMessageCount: 1,
      isGitRepo: false,
      ...options.input,
    } as unknown as Parameters<typeof useComposerSend>[0];
    const currentSend = useComposerSend(input).onSend;
    useLayoutEffect(() => {
      send = () => currentSend();
    });
    return null;
  }
  await fixture.rerender(
    <AppAtomRegistryProvider>
      <Probe />
    </AppAtomRegistryProvider>,
  );
  return { calls, errors, refusal, promptRef, send: () => send() };
}

it("regression goat#3558: a refused mode change on a redirect declines nothing and keeps the draft", async () => {
  await using fixture = await setupSshComposer();
  const redirect = await redirectSend(fixture, { composerMode: "approval-required", refuse: true });

  await redirect.send();

  expect(redirect.calls).toEqual(["settings:approval-required"]);
  expect(redirect.errors).toContain(redirect.refusal);
  expect(redirect.promptRef.current).toBe("Stop that and list the files instead.");
});

it("a redirect that keeps the mode declines, then sends, as before", async () => {
  await using fixture = await setupSshComposer();
  const redirect = await redirectSend(fixture, { composerMode: "full-access", refuse: false });

  await redirect.send();

  expect(redirect.calls).toEqual(["approval:decline", "settings:full-access", "startTurn"]);
});

async function draftReply(holder: string) {
  const { EnvironmentId, ThreadId, MessageId, TurnItemId } = await import("@goat/contracts");
  const { useComposerDraftStore } = await import("~/composerDraftStore");
  const environmentId = EnvironmentId.make("redirect-env");
  useComposerDraftStore.getState().setReplyTo(
    { environmentId, threadId: ThreadId.make("redirect-thread") },
    {
      version: 1,
      kind: "response",
      contextId: "response_m9" as ComposerContextId,
      label: "An answer",
      citation: {
        version: 1,
        environmentId,
        threadId: ThreadId.make(holder),
        messageId: MessageId.make("m9"),
        text: "An answer",
        start: 0,
        end: 9,
        prefix: "",
        suffix: "",
      },
      itemId: TurnItemId.make("item-9"),
    },
  );
  return environmentId;
}

async function serverTakesReplies(environmentId: unknown) {
  const { appAtomRegistry } = await import("~/rpc/atomRegistry");
  const { environmentServerConfigsAtom } = await import("~/state/server");
  const get = vi.mocked(appAtomRegistry.get);
  const prior = get.getMockImplementation()!;
  const configs = new Map([
    [environmentId, { environment: { capabilities: { replyToResponse: true } } }],
  ]);
  get.mockImplementation(((atom: unknown) =>
    atom === environmentServerConfigsAtom ? configs : prior(atom as never)) as never);
  return { [Symbol.dispose]: () => get.mockImplementation(prior) };
}

it("a draft reply to a server without replyToResponse starts no turn and says why", async () => {
  await using fixture = await setupSshComposer();
  const redirect = await redirectSend(fixture, { composerMode: "full-access", refuse: false });
  await draftReply("redirect-thread");

  await redirect.send();

  expect(redirect.calls).toEqual([]);
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "This machine's server can't take replies" }),
  );
});

it("a draft reply whose holding thread the client does not hold starts no turn and says why", async () => {
  await using fixture = await setupSshComposer();
  const redirect = await redirectSend(fixture, { composerMode: "full-access", refuse: false });
  using _server = await serverTakesReplies(await draftReply("holder-thread"));

  await redirect.send();

  expect(redirect.calls).toEqual([]);
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Can't find the response this replies to" }),
  );
});

it("a draft reply whose holding thread the client holds starts the turn", async () => {
  await using fixture = await setupSshComposer();
  const { readThreadShell } = await import("~/state/entities");
  const redirect = await redirectSend(fixture, { composerMode: "full-access", refuse: false });
  using _server = await serverTakesReplies(await draftReply("holder-thread"));
  using _shell = vi
    .mocked(readThreadShell)
    .mockImplementation(((ref: { threadId: string }) =>
      ref.threadId === "holder-thread" ? { deletedAt: null } : null) as never);

  await redirect.send();

  expect(redirect.calls).toEqual(["approval:decline", "settings:full-access", "startTurn"]);
  expect(state.toast).not.toHaveBeenCalled();
});

it("a queued-message edit whose reply names a thread the client does not hold is refused, and the edit stays open", async () => {
  await using fixture = await setupSshComposer();
  const { DraftId, useComposerDraftStore } = await import("~/composerDraftStore");
  const editDraft = DraftId.make("queued-edit:redirect-env:redirect-thread:run-1");
  const saveEdit = vi.fn(async () => {});
  const redirect = await redirectSend(fixture, {
    composerMode: "full-access",
    refuse: false,
    input: { queuedRunEdit: { isEditing: true, saveEdit }, composerDraftTarget: editDraft },
  });
  const environmentId = await draftReply("holder-thread");
  const store = useComposerDraftStore.getState();
  const threadDraft = { environmentId, threadId: "redirect-thread" } as never;
  store.setReplyTo(editDraft, store.getComposerDraft(threadDraft)!.replyTo);
  store.setReplyTo(threadDraft, null);
  using _server = await serverTakesReplies(environmentId);

  await redirect.send();

  expect(saveEdit).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Can't find the response this replies to" }),
  );
  expect(store.getComposerDraft(editDraft)?.replyTo?.contextId).toBe("response_m9");
});

it("a reply sent as a plan follow-up carries its response record", async () => {
  await using fixture = await setupSshComposer();
  const redirect = await redirectSend(fixture, {
    composerMode: "full-access",
    refuse: false,
    input: {
      showPlanFollowUpPrompt: true,
      activeProposedPlan: { id: "plan-1", planMarkdown: "# Plan\n\n1. Do it" },
    },
    sendContext: { interactionModeEnabled: true },
  });
  using _server = await serverTakesReplies(await draftReply("redirect-thread"));

  await redirect.send();

  expect(redirect.calls).toEqual(["settings:full-access", "startTurn"]);
  const [{ input }] = state.normal.mock.calls[0] as [
    { input: { message: { context?: { records: ReadonlyArray<{ kind: string }> } } } },
  ];
  expect(input.message.context?.records ?? []).toContainEqual(
    expect.objectContaining({ kind: "response", contextId: "response_m9" }),
  );
});

it("a plan follow-up with a reply that fails to send puts the reply back with its text", async () => {
  await using fixture = await setupSshComposer();
  const { AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { useComposerDraftStore } = await import("~/composerDraftStore");
  const redirect = await redirectSend(fixture, {
    composerMode: "full-access",
    refuse: false,
    input: {
      showPlanFollowUpPrompt: true,
      activeProposedPlan: { id: "plan-1", planMarkdown: "# Plan\n\n1. Do it" },
    },
    sendContext: { interactionModeEnabled: true },
  });
  const environmentId = await draftReply("redirect-thread");
  using _server = await serverTakesReplies(environmentId);
  state.normal.mockImplementation(async () =>
    AsyncResult.failure(Cause.fail(new Error("offline"))),
  );

  await redirect.send();

  const draft = useComposerDraftStore
    .getState()
    .getComposerDraft({ environmentId, threadId: "redirect-thread" } as never);
  expect(draft?.prompt).toBe("Stop that and list the files instead.");
  expect(draft?.replyTo?.contextId).toBe("response_m9");
});

it("opens a side chat without declining the pending approval", async () => {
  await using fixture = await setupSshComposer();
  const redirect = await redirectSend(fixture, {
    composerMode: "full-access",
    refuse: false,
    input: { sideChatAvailable: true },
  });
  const { useSideChatStore } = await import("../sideChat/sideChatStore");
  redirect.promptRef.current = "/side question";
  await redirect.send();
  expect(useSideChatStore.getState().pendingPrompts["redirect"]).toBe("question");
  expect(redirect.calls).toEqual([]);
});
