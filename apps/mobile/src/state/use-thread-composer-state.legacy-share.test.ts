import {
  AuthOrchestrationOperateScope,
  RuntimeRequestId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ServerConfig,
} from "@goat/contracts";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import type { PendingThreadRequests } from "@goat/client-runtime/state/thread-requests";
import { AsyncResult, type Atom } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  grantedEnvironments: new Set<string>(),
  connectionState: "connected",
  draft: {
    text: "Keep my draft",
    attachments: [] as DraftComposerImageAttachment[],
    modelSelection: undefined as ModelSelection | undefined,
  },
  serverConfig: null as ServerConfig | null,
  projection: null as OrchestrationV2ThreadProjection | null,
  pendingRequests: { approvals: [], userInputs: [] } as PendingThreadRequests,
  enqueue: vi.fn(async () => undefined),
  compactModel: null as string | null,
  compactDueAt: "",
  sideChat: vi.fn(async (_input: { readonly text: string }) => false),
  clearDraft: vi.fn(),
  approve: vi.fn(),
  answer: vi.fn(),
  feedback: vi.fn(),
  setRuntimeMode: vi.fn(),
  composerError: vi.fn(),
  updateSettings: vi.fn(),
  question: {
    id: "language",
    header: "Language",
    question: "Which language?",
    options: [{ label: "TypeScript", description: "Use the existing code" }],
    multiSelect: false,
  },
  thread: {
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    latestRun: null,
  },
}));

vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: <A>(current: A) => ({ current }),
  useMemo: <A>(factory: () => A) => factory(),
  useState: <A>(initial: A | (() => A)) => [
    typeof initial === "function" ? (initial as () => A)() : initial,
    vi.fn(),
  ],
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "uuid" }));
vi.mock("@goat/client-runtime/state/context-window", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/client-runtime/state/context-window")>()),
  compactBeforeSendTokens: (input: { readonly selection: ModelSelection; readonly now: string }) =>
    input.selection.model === state.compactModel && input.now >= state.compactDueAt
      ? 248_000
      : null,
}));
vi.mock("../lib/clock", () => ({ useNowMinuteMs: () => 0 }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: vi.fn() }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("../features/threads/useSideChatCommand", () => ({
  useSideChatCommand: () => state.sideChat,
}));
vi.mock("./queued-run-edit", () => ({
  useQueuedRunEdit: () => null,
  getQueuedRunEdit: () => null,
}));
vi.mock("./preferences", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make(AsyncResult.success({})) };
});
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("./atom-registry");
  return { useAtomValue: <A>(atom: Atom.Atom<A>) => appAtomRegistry.get(atom) };
});
vi.mock("./entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.grantedEnvironments.has(environmentId),
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: state.thread,
    selectedThreadCreation: null,
    selectedEnvironmentRuntime: {
      connectionState: state.connectionState,
      serverConfig: state.serverConfig,
    },
  }),
}));
vi.mock("./use-thread-detail", () => ({
  useSelectedThreadProjection: () =>
    state.projection === null ? null : { projection: state.projection },
  useSelectedThreadVisibleTurnItems: () => [],
  useSelectedThreadPendingRequests: () => state.pendingRequests,
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: <A>(command: A) => command }));
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadDetails: {
      queueWorkflowAtom: () => Atom.make(null),
      checkpointSummariesAtom: () => Atom.make([]),
      sequenceAtom: () => Atom.make(0),
      pendingRequestsAtom: () => Atom.make(state.pendingRequests),
    },
    threadEnvironment: {
      respondToApproval: state.approve,
      respondToUserInput: state.answer,
      uploadFeedback: state.feedback,
      setRuntimeMode: state.setRuntimeMode,
    },
  };
});
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return { dispatchingQueuedMessageIdAtom: Atom.make(null), useThreadOutboxMessages: () => ({}) };
});
vi.mock("./thread-outbox", () => ({ enqueueThreadOutboxMessage: state.enqueue }));
vi.mock("./composer-attachment-uploads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerAttachmentUploadsAtom: Atom.make({}),
    composerAttachmentUploadBlockReason: () => null,
    composerAttachmentsStillUploading: () => false,
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    composerContextImportsAtom: Atom.make({}),
    getComposerDraftSnapshot: () => state.draft,
    clearComposerDraftContent: state.clearDraft,
    clearComposerDraft: state.clearDraft,
    setComposerDraftText: (_key: string, text: string) => {
      state.draft.text = text;
    },
    updateComposerDraftSettings: state.updateSettings,
    ensureComposerDraftsLoaded: () => {},
    scheduleUnusedComposerAttachmentCleanup: () => {},
    appendComposerDraftAttachments: vi.fn(),
    appendComposerDraftText: vi.fn(),
    mergeComposerDraftContent: vi.fn(),
    removeComposerDraftAttachment: vi.fn(),
    useComposerDraft: () => state.draft,
    useComposerDraftSettings: () => state.draft,
    questionAttachmentDraftsAtom: () => Atom.make({}),
  };
});
vi.mock("../lib/composerImages", () => ({
  convertPastedImagesToAttachments: vi.fn(),
  pasteComposerClipboard: vi.fn(),
  pickComposerFiles: vi.fn(),
  pickComposerMedia: vi.fn(),
}));
vi.mock("../lib/commandMetadata", () => ({
  makeQueuedMessageMetadata: () => ({
    messageId: "message",
    commandId: "command",
    createdAt: "2026-09-05T00:00:00.000Z",
  }),
}));
vi.mock("../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("./use-remote-environment-registry", () => ({ setPendingConnectionError: vi.fn() }));
vi.mock("./thread-composer-error", () => ({
  clearThreadComposerError: vi.fn(),
  setThreadComposerError: state.composerError,
}));

import { useThreadComposerState } from "./use-thread-composer-state";

beforeEach(() => {
  state.grantedEnvironments = new Set(["primary"]);
  state.connectionState = "connected";
  state.draft = { text: "Keep my draft", attachments: [], modelSelection: undefined };
  state.compactModel = null;
  state.compactDueAt = "";
  state.projection = null;
  state.serverConfig = {
    providers: [{ instanceId: "codex", driver: "codex", enabled: true }],
    environment: { capabilities: {} },
  } as unknown as ServerConfig;
  state.pendingRequests = {
    approvals: [
      {
        requestId: RuntimeRequestId.make("approval"),
        requestKind: "command",
        createdAt: "2026-09-05T00:00:00.000Z",
        responseCapability: "live",
      },
    ],
    userInputs: [],
  };
  vi.clearAllMocks();
  state.sideChat.mockReset().mockResolvedValue(false);
  state.approve.mockResolvedValue(AsyncResult.success(undefined));
  state.answer.mockResolvedValue(AsyncResult.success(undefined));
  state.feedback.mockResolvedValue(AsyncResult.success({ feedbackId: "feedback" }));
  state.setRuntimeMode.mockResolvedValue(AsyncResult.success(undefined));
  state.grantedEnvironments.add("secondary");
});

it("loads a legacy share draft and enqueues it exactly once with valid IDs", async () => {
  const drafts =
    await vi.importActual<typeof import("./use-composer-drafts")>("./use-composer-drafts");
  const legacy = {
    id: "share-1:file:0",
    type: "file",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 3,
    fileUri: "file:///shared/report.pdf",
  };
  const loaded = drafts.decodePersistedComposerState({
    schemaVersion: 1,
    drafts: { thread: { text: "", attachments: [legacy] } },
  }).drafts.thread;
  expect(loaded).toBeDefined();
  state.draft = loaded as typeof state.draft;
  state.serverConfig = {
    providers: [{ instanceId: "codex", driver: "codex", enabled: true }],
    environment: {
      capabilities: { attachmentUploads: true, fileAttachments: { maxUploadBytes: 100 } },
    },
  } as unknown as ServerConfig;
  state.pendingRequests = { approvals: [], userInputs: [] };
  expect(await useThreadComposerState().onSendMessage()).toBe("message");
  expect(state.enqueue).toHaveBeenCalledOnce();
  expect(state.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      attachments: [expect.objectContaining({ id: "share-1-file-0" })],
      context: expect.objectContaining({
        records: [expect.objectContaining({ attachmentId: "share-1-file-0" })],
      }),
    }),
  );
});
