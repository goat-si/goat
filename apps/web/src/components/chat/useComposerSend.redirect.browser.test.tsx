import { setupSshComposer, state } from "~/test/sshComposerFixture";
import { useLayoutEffect, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";

/**
 * A server thread with one pending command approval and a send that redirects the agent: the
 * composer shows the approval, so a send declines it before the message goes out.
 */
async function redirectSend(
  fixture: Awaited<ReturnType<typeof setupSshComposer>>,
  options: { readonly composerMode: "full-access" | "approval-required"; readonly refuse: boolean },
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
