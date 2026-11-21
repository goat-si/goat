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
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
    sideChatOf: null as string | null,
    lineage: { relationshipToParent: null as string | null },
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

import { useSelectedThreadRequests } from "./use-selected-thread-requests";
import { appAtomRegistry } from "./atom-registry";
import { composerDraftsAtom } from "./use-composer-drafts";
import { questionAttachmentDraftKey } from "./question-attachments";

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
    approvals: [],
    userInputs: [
      {
        requestId: RuntimeRequestId.make("input"),
        createdAt: "2026-09-05T00:00:00.000Z",
        responseCapability: "live",
        dismissible: false,
        questions: [state.question],
      },
    ],
  };
  state.thread = { ...state.thread, sideChatOf: null, lineage: { relationshipToParent: null } };
  vi.clearAllMocks();
  state.sideChat
    .mockReset()
    .mockImplementation(
      async (input: { readonly text: string; readonly onStarted?: () => void }) => {
        input.onStarted?.();
        return true;
      },
    );
  state.approve.mockResolvedValue(AsyncResult.success(undefined));
  state.answer.mockResolvedValue(AsyncResult.success(undefined));
  state.feedback.mockResolvedValue(AsyncResult.success({ feedbackId: "feedback" }));
  state.setRuntimeMode.mockResolvedValue(AsyncResult.success(undefined));
  state.grantedEnvironments.add("secondary");
});

// O2/O4, the mobile half: "/side ..." typed as a question's answer opens the thread's side chat
// and leaves the question pending, as in the composer and on web (shared sideChatCommandOverAnswer).
// Mobile also accepts /btw wherever it accepts /side (coordinator D1 (b)).
describe("a side chat command typed as an answer", () => {
  const requestId = RuntimeRequestId.make("input");

  it("opens the side chat for /side and sends no answer", async () => {
    useSelectedThreadRequests().onChangeUserInputCustomAnswer(requestId, "language", "/side why?");
    await useSelectedThreadRequests().onSubmitUserInput();
    expect(state.answer).not.toHaveBeenCalled();
    expect(state.sideChat).toHaveBeenCalledWith(expect.objectContaining({ text: "/side why?" }));
    // The command leaves the answer, so the question waits for a real one.
    expect(useSelectedThreadRequests().activePendingUserInputAnswers).toBeNull();
  });

  it("treats /btw like /side", async () => {
    useSelectedThreadRequests().onChangeUserInputCustomAnswer(requestId, "language", "/btw why?");
    await useSelectedThreadRequests().onSubmitUserInput();
    expect(state.answer).not.toHaveBeenCalled();
    expect(state.sideChat).toHaveBeenCalledWith(expect.objectContaining({ text: "/side why?" }));
  });

  it("keeps the typed answer when the side chat does not start", async () => {
    // useSideChatCommand handles a refusal (not connected, a create failure) with an alert.
    state.sideChat.mockReset().mockResolvedValue(true);
    useSelectedThreadRequests().onChangeUserInputCustomAnswer(requestId, "language", "/side why?");
    await useSelectedThreadRequests().onSubmitUserInput();
    expect(state.answer).not.toHaveBeenCalled();
    expect(useSelectedThreadRequests().activePendingUserInputAnswers).toEqual({
      language: "/side why?",
    });
  });

  it("stays an answer when the question holds attachments", async () => {
    appAtomRegistry.set(composerDraftsAtom, {
      [questionAttachmentDraftKey("secondary" as never, "thread" as never, requestId, "language")]:
        {
          text: "",
          attachments: [
            {
              type: "image",
              id: "photo",
              name: "photo.png",
              mimeType: "image/png",
              sizeBytes: 10,
              fileUri: "file:///photo.png",
              previewUri: "file:///photo.png",
              uploadedAttachmentId: "uploaded",
              uploadEnvironmentId: "secondary",
            },
          ],
        },
    } as never);
    useSelectedThreadRequests().onChangeUserInputCustomAnswer(requestId, "language", "/side why?");
    await useSelectedThreadRequests().onSubmitUserInput();
    appAtomRegistry.set(composerDraftsAtom, {});
    expect(state.sideChat).not.toHaveBeenCalled();
    expect(state.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ answers: { language: "/side why?" } }),
      }),
    );
  });

  it("stays an answer in a side chat, where no side chat can start", async () => {
    state.thread = { ...state.thread, sideChatOf: "parent" };
    useSelectedThreadRequests().onChangeUserInputCustomAnswer(requestId, "language", "/side why?");
    await useSelectedThreadRequests().onSubmitUserInput();
    expect(state.sideChat).not.toHaveBeenCalled();
    expect(state.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ answers: { language: "/side why?" } }),
      }),
    );
  });
});
