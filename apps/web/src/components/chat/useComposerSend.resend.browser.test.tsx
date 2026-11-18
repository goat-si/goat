import { setupSshComposer, state } from "~/test/sshComposerFixture";
import { useLayoutEffect, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";

const PROMPT = "Summarize the failing tests.";

/**
 * A server thread whose message send stays pending while the client runtime resends it after a
 * lost socket (962eeefa03), then settles once. Only that outcome decides sent or restored.
 */
async function pendingSend(fixture: Awaited<ReturnType<typeof setupSshComposer>>) {
  const { EnvironmentId, ProjectId, ThreadId, ProviderInstanceId } =
    await import("@goat/contracts");
  const { AsyncResult } = await import("effect/reactivity");
  const { makeThreadFixture } = await import("~/test-fixtures");
  const { AppAtomRegistryProvider } = await import("~/rpc/atomRegistry");
  const { readEnvironmentScope } = await import("~/state/session");
  const { useComposerSend } = await import("./useComposerSend");
  const environmentId = EnvironmentId.make("resend-env");
  const threadId = ThreadId.make("resend-thread");
  const target = { environmentId, threadId };
  const errors: Array<string | null> = [];
  let optimistic: ReadonlyArray<{ readonly id: unknown }> = [];
  let settle!: (result: unknown) => void;
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  state.normal.mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
  let send!: () => Promise<void>;
  const promptRef = { current: PROMPT };
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
        shownPendingApprovalIds: [],
        answeringPendingUserInput: false,
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
      activeThreadKey: "resend",
      activeProject: { id: ProjectId.make("project"), environmentId, cwd: "/repo" },
      routeThreadKey: "resend",
      currentRouteThreadKeyRef: { current: "resend" },
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
      phase: "ready",
      runtimeMode: "full-access",
      sendEnvMode: "local",
      localCheckoutBranchMismatch: null,
      providerInstanceEntries: [],
      cloudState: { composerBlockReason: null },
      activeEnvironmentUnavailable: false,
      isSendBusy: false,
      isConnecting: false,
      needsLoadBalancing: false,
      usageLimitsOffered: false,
      pendingApprovals: [],
      respondingRequestIds: [],
      activePendingProgress: null,
      onRespondToApproval: async () => AsyncResult.success(undefined),
      persistThreadSettingsForNextTurn: async () => AsyncResult.success(undefined),
      setThreadError: (_threadId: unknown, error: string | null) => errors.push(error),
      setDockedDraftHeroThreadKey: () => {},
      setOptimisticUserMessages: (
        update: (existing: ReadonlyArray<{ readonly id: unknown }>) => typeof existing,
      ) => {
        optimistic = update(optimistic);
      },
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
  const sending = send();
  await vi.waitFor(() => expect(state.normal).toHaveBeenCalledTimes(1));
  return {
    errors,
    promptRef,
    optimistic: () => optimistic,
    settle: async (result: unknown) => {
      settle(result);
      await sending;
    },
  };
}

it("a send the runtime resends after a lost socket stays sent and is never restored to the draft", async () => {
  await using fixture = await setupSshComposer();
  const { AsyncResult } = await import("effect/reactivity");
  const pending = await pendingSend(fixture);

  expect(pending.promptRef.current).toBe("");
  expect(pending.optimistic()).toHaveLength(1);

  await pending.settle(AsyncResult.success({ sequence: 2 }));

  expect(state.normal).toHaveBeenCalledTimes(1);
  expect(pending.promptRef.current).toBe("");
  expect(pending.optimistic()).toHaveLength(1);
  expect(pending.errors.filter((error) => error !== null)).toEqual([]);
});

it("a send whose resends give up is restored to the draft once and leaves no sent row", async () => {
  await using fixture = await setupSshComposer();
  const { AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const pending = await pendingSend(fixture);

  expect(pending.promptRef.current).toBe("");

  await pending.settle(AsyncResult.failure(Cause.fail(new Error("socket closed"))));

  expect(state.normal).toHaveBeenCalledTimes(1);
  expect(pending.promptRef.current).toBe(PROMPT);
  expect(pending.optimistic()).toEqual([]);
  expect(pending.errors).toContain("socket closed");
});
