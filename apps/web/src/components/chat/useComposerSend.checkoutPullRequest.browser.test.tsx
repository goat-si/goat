import { ThreadId } from "@goat/contracts";
import type { AttachmentUploadCycleResult } from "@goat/client-runtime/state/attachments";
import { deferred, setupSshComposer, state } from "~/test/sshComposerFixture";
import { useLayoutEffect, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../../hooks/usePullRequestLinking"), { spy: true });
vi.mock(import("@goat/client-runtime/state/attachments"), { spy: true });

async function renderCheckoutSend(
  fixture: Awaited<ReturnType<typeof setupSshComposer>>,
  options: {
    readonly input: Record<string, unknown>;
    readonly sendContext: Record<string, unknown>;
  },
) {
  const { EnvironmentId, ProviderInstanceId } = await import("@goat/contracts");
  const { AppAtomRegistryProvider } = await import("~/rpc/atomRegistry");
  const { useComposerSend } = await import("./useComposerSend");
  const environmentId = EnvironmentId.make("redirect-env");
  const target = { environmentId, threadId: ThreadId.make("redirect-thread") };
  const errors: Array<string | null> = [];
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
        shownPendingApprovalIds: [],
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
      activeThreadKey: "redirect",
      promptRef,
      composerRef,
      composerImagesRef: { current: [] },
      composerFilesRef: { current: [] },
      composerTerminalContextsRef: { current: [] },
      feedbackUploadsInFlightRef: { current: new Set() },
      queuedRunEdit: { isEditing: false },
      isServerThread: false,
      isLocalDraftThread: true,
      isCloudThread: false,
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
      activeMessageCount: 0,
      isGitRepo: true,
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
  return { errors, send: () => send() };
}

it.each([
  {
    title: "links each acknowledged first-send model thread to the checkout pull request",
    checkoutBranch: "feature",
    links: true,
    changesDuringUpload: false,
  },
  {
    title: "omits the checkout pull request when a multiple-model draft changed branches",
    checkoutBranch: "old-feature",
    links: false,
    changesDuringUpload: false,
  },
  {
    title: "does not link a checkout on a new branch while the original model send uploads",
    checkoutBranch: "feature",
    links: false,
    changesDuringUpload: true,
  },
])("$title", async ({ checkoutBranch, links, changesDuringUpload }) => {
  await using fixture = await setupSshComposer();
  const { EnvironmentId, ProjectId, ProviderDriverKind, ProviderInstanceId } =
    await import("@goat/contracts");
  const { scopeProjectRef } = await import("@goat/client-runtime/environment");
  const { AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { DraftId, useComposerDraftStore } = await import("~/composerDraftStore");
  const { appAtomRegistry } = await import("~/rpc/atomRegistry");
  const { environmentPresentations } = await import("~/state/presentation");
  const { makeThreadFixture } = await import("~/test-fixtures");
  const { deriveProviderInstanceEntries } = await import("~/providerInstances");
  const { usePullRequestLinking } = await import("../../hooks/usePullRequestLinking");
  const { runAttachmentUploadCycle } = await import("@goat/client-runtime/state/attachments");
  const changeLink = vi.fn().mockResolvedValue(undefined);
  const linking = vi.mocked(usePullRequestLinking);
  linking.mockReturnValue({
    mode: "multiple",
    canLink: () => true,
    isLinked: () => false,
    changeLink,
  });
  using _linking = { [Symbol.dispose]: () => linking.mockRestore() };
  const environmentId = EnvironmentId.make("redirect-env");
  const projectId = ProjectId.make("project");
  const threadId = ThreadId.make("redirect-thread");
  const routeThreadKey = changesDuringUpload ? "checkout-upload" : checkoutBranch;
  const draftId = DraftId.make(`fanout-${routeThreadKey}`);
  const url = "https://github.com/org/repo/pull/1";
  const branch = "feature";
  const uploadStarted = deferred<void>();
  const upload = deferred<AttachmentUploadCycleResult>();
  const uploadCycle = vi.mocked(runAttachmentUploadCycle);
  const file = new File(["image"], "picture.png", { type: "image/png" });
  if (changesDuringUpload) {
    uploadCycle.mockImplementation(() => {
      uploadStarted.resolve();
      return upload.promise;
    });
  }
  using _upload = {
    [Symbol.dispose]() {
      if (!changesDuringUpload) return;
      upload.resolve({ status: "cancelled", attachmentId: null });
      uploadCycle.mockRestore();
    },
  };
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, {
    threadId,
    branch,
    checkoutPullRequest: { url, branch: checkoutBranch },
  });
  const instanceId = ProviderInstanceId.make("codex");
  const selections = ["first", "second", "failed"].map((model) => ({ instanceId, model }));
  const providerInstanceEntries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      version: null,
      checkedAt: "2026-11-18T00:00:00Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const get = vi.mocked(appAtomRegistry.get);
  const prior = get.getMockImplementation()!;
  get.mockImplementation(((atom: unknown) =>
    atom === environmentPresentations.presentationsAtom
      ? new Map([
          [
            environmentId,
            {
              serverConfig: {
                environment: {
                  capabilities: { requiredWorktreeBootstrap: true, attachmentUploads: true },
                },
              },
            },
          ],
        ])
      : prior(atom as never)) as never);
  const sender = await renderCheckoutSend(fixture, {
    input: {
      activeThread: makeThreadFixture({ id: threadId, environmentId, projectId, branch }),
      activeProject: { id: projectId, environmentId, workspaceRoot: "/repo" },
      draftId,
      draftThread: store.getDraftSession(draftId),
      composerDraftTarget: draftId,
      routeThreadKey,
      currentRouteThreadKeyRef: { current: routeThreadKey },
      activeThreadBranch: branch,
      providerInstanceEntries,
    },
    sendContext: {
      multipleModelSelections: selections,
      images: changesDuringUpload
        ? [
            {
              type: "image",
              id: "checkout-upload",
              name: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              file,
              previewUrl: "blob:checkout-upload",
            },
          ]
        : [],
    },
  });
  const started: ThreadId[] = [];
  state.normal.mockImplementation(
    async ({ input }: { input: { threadId: ThreadId; modelSelection: { model: string } } }) => {
      if (input.modelSelection.model === "failed")
        return AsyncResult.failure(Cause.fail(new Error("offline")));
      started.push(input.threadId);
      return AsyncResult.success({ sequence: 1 });
    },
  );

  const sending = sender.send();
  if (changesDuringUpload) {
    await Promise.race([uploadStarted.promise, sending]);
    expect(uploadCycle).toHaveBeenCalledOnce();
    expect(state.normal).not.toHaveBeenCalled();
    store.setDraftThreadContext(draftId, {
      branch: "other-feature",
      checkoutPullRequest: {
        url: "https://github.com/org/repo/pull/2",
        branch: "other-feature",
      },
    });
    upload.resolve({ status: "uploaded", attachmentId: "uploaded-picture" });
  }
  await sending;

  expect(sender.errors.filter(Boolean)).toEqual([]);
  expect(state.normal).toHaveBeenCalledTimes(3);
  for (const [request] of state.normal.mock.calls) {
    expect(request.input.bootstrap.prepareWorktree.baseBranch).toBe(branch);
  }
  expect(started).toHaveLength(2);
  expect(changeLink.mock.calls).toHaveLength(links ? started.length : 0);
  if (links) {
    for (const id of started) {
      expect(changeLink).toHaveBeenCalledWith({ environmentId, threadId: id }, url, true);
    }
  }
});

it("keeps a replacement checkout's pull request off a single-model send already uploading", async () => {
  await using fixture = await setupSshComposer();
  const { EnvironmentId, ProjectId } = await import("@goat/contracts");
  const { scopeProjectRef } = await import("@goat/client-runtime/environment");
  const { AsyncResult } = await import("effect/reactivity");
  const { DraftId, useComposerDraftStore } = await import("~/composerDraftStore");
  const { appAtomRegistry } = await import("~/rpc/atomRegistry");
  const { environmentPresentations } = await import("~/state/presentation");
  const { makeThreadFixture } = await import("~/test-fixtures");
  const { usePullRequestLinking } = await import("../../hooks/usePullRequestLinking");
  const { runAttachmentUploadCycle } = await import("@goat/client-runtime/state/attachments");

  const environmentId = EnvironmentId.make("redirect-env");
  const projectId = ProjectId.make("project");
  const threadId = ThreadId.make("redirect-thread");
  const draftId = DraftId.make("single-checkout-upload");
  const branch = "feature";
  const worktreePath = "/worktrees/feature";
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, {
    threadId,
    branch,
    worktreePath,
    envMode: "worktree",
    checkoutPullRequest: { url: "https://github.com/org/repo/pull/1", branch },
  });

  const changeLink = vi.fn().mockResolvedValue(undefined);
  const linking = vi.mocked(usePullRequestLinking);
  linking.mockReturnValue({
    mode: "multiple",
    canLink: () => true,
    isLinked: () => false,
    changeLink,
  });
  using _linking = { [Symbol.dispose]: () => linking.mockRestore() };

  const uploadStarted = deferred<void>();
  const upload = deferred<AttachmentUploadCycleResult>();
  const uploadCycle = vi.mocked(runAttachmentUploadCycle).mockImplementation(() => {
    uploadStarted.resolve();
    return upload.promise;
  });
  using _upload = {
    [Symbol.dispose]() {
      upload.resolve({ status: "cancelled", attachmentId: null });
      uploadCycle.mockRestore();
    },
  };
  const get = vi.mocked(appAtomRegistry.get);
  const prior = get.getMockImplementation()!;
  get.mockImplementation(((atom: unknown) =>
    atom === environmentPresentations.presentationsAtom
      ? new Map([
          [
            environmentId,
            {
              serverConfig: { environment: { capabilities: { attachmentUploads: true } } },
            },
          ],
        ])
      : prior(atom as never)) as never);
  using _registry = {
    [Symbol.dispose]: () => {
      get.mockImplementation(prior);
    },
  };

  const file = new File(["image"], "picture.png", { type: "image/png" });
  const sender = await renderCheckoutSend(fixture, {
    input: {
      activeThread: makeThreadFixture({
        id: threadId,
        environmentId,
        projectId,
        branch,
        worktreePath,
      }),
      activeProject: { id: projectId, environmentId, workspaceRoot: "/repo" },
      draftId,
      draftThread: store.getDraftSession(draftId),
      composerDraftTarget: draftId,
      routeThreadKey: draftId,
      currentRouteThreadKeyRef: { current: draftId },
      activeThreadBranch: branch,
      sendEnvMode: "worktree",
    },
    sendContext: {
      images: [
        {
          type: "image",
          id: "single-checkout-picture",
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
          previewUrl: "blob:single-checkout-picture",
        },
      ],
    },
  });
  state.normal.mockResolvedValue(AsyncResult.success({ sequence: 1 }));

  const sending = sender.send();
  await Promise.race([uploadStarted.promise, sending]);
  expect(uploadCycle).toHaveBeenCalledOnce();
  expect(state.normal).not.toHaveBeenCalled();
  store.setDraftThreadContext(draftId, {
    branch: "other-feature",
    worktreePath: "/worktrees/other-feature",
    checkoutPullRequest: { url: "https://github.com/org/repo/pull/2", branch: "other-feature" },
  });
  upload.resolve({ status: "uploaded", attachmentId: "uploaded-picture" });
  await sending;

  expect(sender.errors.filter(Boolean)).toEqual([]);
  expect(state.normal).toHaveBeenCalledOnce();
  expect(state.normal.mock.calls[0]?.[0].input.bootstrap.createThread).toMatchObject({
    branch,
    worktreePath,
  });
  expect(changeLink).not.toHaveBeenCalled();
});

it("does not clear the visible composer after navigating during an upload", async () => {
  await using fixture = await setupSshComposer();
  const { EnvironmentId, ProjectId } = await import("@goat/contracts");
  const { scopeProjectRef } = await import("@goat/client-runtime/environment");
  const { AsyncResult } = await import("effect/reactivity");
  const { DraftId, useComposerDraftStore } = await import("~/composerDraftStore");
  const { appAtomRegistry } = await import("~/rpc/atomRegistry");
  const { environmentPresentations } = await import("~/state/presentation");
  const { makeThreadFixture } = await import("~/test-fixtures");
  const { usePullRequestLinking } = await import("../../hooks/usePullRequestLinking");
  const { runAttachmentUploadCycle } = await import("@goat/client-runtime/state/attachments");
  const environmentId = EnvironmentId.make("redirect-env");
  const projectId = ProjectId.make("project");
  const threadId = ThreadId.make("redirect-thread");
  const draftId = DraftId.make("navigation-upload");
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, {
    threadId,
    branch: "feature",
  });
  const linking = vi.mocked(usePullRequestLinking);
  linking.mockReturnValue({
    mode: "multiple",
    canLink: () => true,
    isLinked: () => false,
    changeLink: vi.fn(),
  });
  using _linking = { [Symbol.dispose]: () => linking.mockRestore() };
  const uploadStarted = deferred<void>();
  const upload = deferred<AttachmentUploadCycleResult>();
  const uploadCycle = vi.mocked(runAttachmentUploadCycle).mockImplementation(() => {
    uploadStarted.resolve();
    return upload.promise;
  });
  using _upload = {
    [Symbol.dispose]() {
      upload.resolve({ status: "cancelled", attachmentId: null });
      uploadCycle.mockRestore();
    },
  };
  const get = vi.mocked(appAtomRegistry.get);
  const prior = get.getMockImplementation()!;
  get.mockImplementation(((atom: unknown) =>
    atom === environmentPresentations.presentationsAtom
      ? new Map([
          [
            environmentId,
            { serverConfig: { environment: { capabilities: { attachmentUploads: true } } } },
          ],
        ])
      : prior(atom as never)) as never);
  using _registry = { [Symbol.dispose]: () => get.mockImplementation(prior) };
  const file = new File(["image"], "picture.png", { type: "image/png" });
  const route = { current: String(draftId) };
  const promptRef = { current: "original" };
  const resetCursorState = vi.fn();
  const composerRef = {
    current: {
      getSendContext: () => ({
        providerAvailable: true,
        multipleModelSelections: null,
        images: [
          {
            type: "image",
            id: "navigation-image",
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            file,
            previewUrl: "blob:navigation-image",
          },
        ],
        files: [],
        terminalContexts: [],
        previewAnnotations: [],
        reviewComments: [],
        threadContexts: [],
        previewTabs: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5.4",
        selectedProviderModels: [],
        selectedPromptEffort: null,
        selectedModelSelection: { instanceId: "codex", model: "gpt-5.4" },
        interactionMode: "default",
        interactionModeEnabled: false,
        shownPendingApprovalIds: [],
        answeringPendingUserInput: false,
      }),
      validateProviderInput: () => true,
      hasPendingAttachments: () => false,
      resetCursorState,
    },
  };
  const sender = await renderCheckoutSend(fixture, {
    input: {
      activeThread: makeThreadFixture({
        id: threadId,
        environmentId,
        projectId,
        branch: "feature",
      }),
      activeProject: { id: projectId, environmentId, workspaceRoot: "/repo" },
      draftId,
      draftThread: store.getDraftSession(draftId),
      composerDraftTarget: draftId,
      routeThreadKey: draftId,
      currentRouteThreadKeyRef: route,
      activeThreadBranch: "feature",
      promptRef,
      composerRef,
    },
    sendContext: {},
  });
  state.normal.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  const sending = sender.send();
  await Promise.race([uploadStarted.promise, sending]);
  expect(uploadCycle).toHaveBeenCalledOnce();
  route.current = "another-thread";
  promptRef.current = "new draft";
  upload.resolve({ status: "uploaded", attachmentId: "uploaded-picture" });
  await sending;
  expect(promptRef.current).toBe("new draft");
  expect(resetCursorState).not.toHaveBeenCalled();
});
