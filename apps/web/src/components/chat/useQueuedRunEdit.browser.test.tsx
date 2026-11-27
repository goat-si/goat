import { useAtomValue } from "@effect/atom-react";
import type {
  ConnectionCatalogEntry,
  NetworkStatus,
  PreparedConnection,
} from "@goat/client-runtime/connection";
import { scopedThreadKey } from "@goat/client-runtime/environment";
import type { RpcSession } from "@goat/client-runtime/rpc/session";
import type { ThreadStructure } from "@goat/client-runtime/state/shell";
import type { createEnvironmentThreadDetailAtoms } from "@goat/client-runtime/state/threads";
import {
  ChatAttachmentId,
  EnvironmentId,
  EventId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ScopedThreadRef,
} from "@goat/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@goat/shared/composerContextReferences";
import type * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { useImperativeHandle, useLayoutEffect, useRef, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { readAttachmentUpload, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "../../lib/terminalContext";

import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextRecord, threadContextReference } from "../../lib/composerContextRecords";
import { environmentServerConfigsAtom } from "../../state/server";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { useQueuedRunEdit } from "./useQueuedRunEdit";
import type { ChatComposerHandle } from "./ChatComposer";

interface RunStatus {
  readonly id: RunId;
  readonly status: string;
}

type ThreadDetails = ReturnType<typeof createEnvironmentThreadDetailAtoms>;
type ServerSocket = Queue.Queue<OrchestrationV2ThreadStreamItem>;

const mocks = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editQueuedRun: vi.fn<(value: unknown) => Promise<{ readonly _tag: "Success" | "Failure" }>>(),
    // The projection's runs per thread, written by each test to stand in for the server.
    threadRuns: Atom.family((_key: string) =>
      Atom.make<ReadonlyArray<RunStatus> | null>(null).pipe(Atom.keepAlive),
    ),
    // Real thread detail atoms over a fake environment: the server's threads and its socket.
    details: null as ThreadDetails | null,
    server: {
      threads: new Map<string, OrchestrationV2ThreadProjection>(),
      // Resolves when the thread's live socket subscription opens.
      socket: new Promise<ServerSocket>(() => {}),
      openSocket: (_socket: ServerSocket) => {},
    },
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.editQueuedRun,
}));

const runsKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const Queue = await import("effect/Queue");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { EnvironmentId, ORCHESTRATION_V2_WS_METHODS } = await import("@goat/contracts");
  const {
    AVAILABLE_CONNECTION_STATE,
    EnvironmentRegistry,
    EnvironmentSupervisor,
    PrimaryConnectionTarget,
  } = await import("@goat/client-runtime/connection");
  const { Persistence } = await import("@goat/client-runtime/platform");
  const threads = await import("@goat/client-runtime/state/threads");
  const key = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;
  const environment = Layer.unwrap(
    Effect.gen(function* () {
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("env-1"),
        label: "Test environment",
        httpBaseUrl: "https://environment.example.test",
        wsBaseUrl: "wss://environment.example.test",
      });
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: () =>
          Stream.unwrap(
            Queue.unbounded<OrchestrationV2ThreadStreamItem>().pipe(
              Effect.tap((socket) => Effect.sync(() => mocks.server.openSocket(socket))),
              Effect.map((socket) => Stream.fromQueue(socket)),
            ),
          ),
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
          Option.some({
            client,
            initialConfig: Effect.succeed({}),
            subscribeServerConfig: () => Stream.never,
            ready: Effect.void,
            probe: Effect.void,
            inboundFrames: Effect.succeed(0),
            closed: Effect.never,
          } as never),
        ),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
          Option.some({
            environmentId: target.environmentId,
            label: target.label,
            httpBaseUrl: target.httpBaseUrl,
            socketUrl: target.wsBaseUrl,
            httpAuthorization: null,
            target,
          }),
        ),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const unexpected = () => Effect.die("Unexpected environment registry call");
      return Layer.mergeAll(
        Layer.succeed(
          EnvironmentRegistry.EnvironmentRegistry,
          EnvironmentRegistry.EnvironmentRegistry.of({
            entries: yield* SubscriptionRef.make<
              ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
            >(new Map()),
            networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
            start: Effect.void,
            register: unexpected,
            assertKnownAddress: unexpected,
            registerPlatform: unexpected,
            reconcilePlatform: unexpected,
            remove: unexpected,
            removeRoute: unexpected,
            reorderRoutes: unexpected,
            removeRelayEnvironments: unexpected,
            retryNow: () => Effect.void,
            reconnect: () => Effect.void,
            setEnabled: unexpected,
            setCompatibility: unexpected,
            state: () => SubscriptionRef.get(supervisor.state),
            stateChanges: () => SubscriptionRef.changes(supervisor.state),
            run: (_id, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
            runStream: (_id, stream) =>
              Stream.provideService(
                stream,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
            followStream: (_id, stream) =>
              Stream.provideService(
                stream,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          }),
        ),
        Layer.succeed(
          Persistence.EnvironmentCacheStore,
          Persistence.EnvironmentCacheStore.of({
            loadShellMeta: () => Effect.succeedNone,
            saveShellMeta: () => Effect.void,
            loadShell: () => Effect.succeedNone,
            saveShell: () => Effect.void,
            loadThread: () => Effect.succeedNone,
            saveThread: () => Effect.void,
            removeThread: () => Effect.void,
            loadServerConfig: () => Effect.succeedNone,
            saveServerConfig: () => Effect.void,
            loadVcsRefs: () => Effect.succeedNone,
            saveVcsRefs: () => Effect.void,
            removeVcsRefs: () => Effect.void,
            clearVcsRefs: () => Effect.void,
            clear: () => Effect.void,
          }),
        ),
        Layer.succeed(
          threads.ThreadSnapshotLoader,
          threads.ThreadSnapshotLoader.of({
            load: (_prepared, threadId) =>
              Effect.sync(() => {
                const projection = mocks.server.threads.get(`env-1:${threadId}`);
                return projection === undefined
                  ? { _tag: "missing" as const }
                  : {
                      _tag: "present" as const,
                      snapshot: { snapshotSequence: 1, projection },
                    };
              }),
          }),
        ),
      );
    }),
  );
  const details = threads.createEnvironmentThreadDetailAtoms(
    threads.createEnvironmentThreadStateAtoms(Atom.runtime(environment)).stateAtom,
  );
  mocks.details = details;
  return {
    threadEnvironment: {
      snapshotAtom: () => Atom.make(null),
      editQueuedRun: {},
    },
    environmentThreadDetails: {
      statusAtom: () => Atom.make("ready"),
      quietThreadAtom: (ref: ScopedThreadRef) =>
        Atom.make((get) => {
          const runs = get(mocks.threadRuns(key(ref)));
          return runs === null ? null : { projection: { runs } };
        }),
      pendingRequestsAtom: details.pendingRequestsAtom,
    },
    environmentThreadShells: {
      threadShellAtom: () => Atom.make(null),
    },
  };
});

const ENV = EnvironmentId.make("env-1");
const THREAD_A: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("thread-a") };
const THREAD_B: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("thread-b") };
const RUN = RunId.make("run-1");

type HookResult = ReturnType<typeof useQueuedRunEdit>;

function projection(runs: ReadonlyArray<RunStatus>, messages: ReadonlyArray<unknown>) {
  return { runs, messages } as unknown as ThreadStructure;
}

function setRuns(ref: ScopedThreadRef, status: string) {
  appAtomRegistry.set(mocks.threadRuns(runsKey(ref)), [{ id: RUN, status }]);
}

interface ComposerRefs {
  readonly promptRef: RefObject<string>;
  readonly composerRef: Parameters<typeof useQueuedRunEdit>[0]["composerRef"];
}

function Harness(props: {
  readonly threadRef: ScopedThreadRef;
  readonly threadDetailRef: ScopedThreadRef | null;
  readonly runStatus: string;
  readonly hookRef: RefObject<HookResult | null>;
  readonly messages: ReadonlyArray<unknown>;
  readonly composer?: ComposerRefs | undefined;
}) {
  const threadKey = scopedThreadKey(props.threadRef);
  const currentRouteThreadKeyRef = useRef<string | null>(threadKey);
  useLayoutEffect(() => {
    currentRouteThreadKeyRef.current = threadKey;
    return () => {
      currentRouteThreadKeyRef.current = null;
    };
  }, [threadKey]);
  const result = useQueuedRunEdit({
    environmentId: ENV,
    routeThreadRef: props.threadRef,
    currentRouteThreadKeyRef,
    threadDetailRef: props.threadDetailRef,
    threadDraftTarget: props.threadRef,
    activeThreadId: props.threadRef.threadId,
    serverProjection:
      props.threadDetailRef === null
        ? null
        : projection([{ id: RUN, status: props.runStatus }], props.messages),
    promptRef: props.composer?.promptRef ?? { current: "" },
    composerRef: props.composer?.composerRef ?? { current: null },
  });
  useImperativeHandle(props.hookRef, () => result);
  return null;
}

function requireDetails(): ThreadDetails {
  if (mocks.details === null) throw new Error("thread details mock did not load");
  return mocks.details;
}

/** Reads the thread the way ChatView's timeline does once its detail ref resolves. */
function ThreadReader(props: { readonly threadRef: ScopedThreadRef }) {
  const details = requireDetails();
  const status = useAtomValue(details.statusAtom(props.threadRef));
  const thread = useAtomValue(details.threadAtom(props.threadRef));
  return (
    <section aria-label="thread">
      <p>{`status ${status}`}</p>
      {thread?.projection.messages.map((message) => (
        <p key={message.id}>{message.text}</p>
      ))}
    </section>
  );
}

function view(
  threadRef: ScopedThreadRef,
  runStatus: string,
  hook: { current: HookResult | null },
  threadDetailRef: ScopedThreadRef | null = threadRef,
  messages: ReadonlyArray<unknown> = [],
  composer?: ComposerRefs,
) {
  return (
    <AppAtomRegistryProvider>
      <Harness
        threadRef={threadRef}
        threadDetailRef={threadDetailRef}
        runStatus={runStatus}
        hookRef={hook}
        messages={messages}
        composer={composer}
      />
      {threadDetailRef === null ? null : <ThreadReader threadRef={threadDetailRef} />}
    </AppAtomRegistryProvider>
  );
}

function setup() {
  mocks.editQueuedRun.mockReset();
  mocks.server.threads.clear();
  mocks.server.socket = new Promise<ServerSocket>((resolve) => {
    mocks.server.openSocket = resolve;
  });
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  setRuns(THREAD_A, "queued");
  setRuns(THREAD_B, "queued");
  return { hook: { current: null as HookResult | null } };
}

function conversationMessage(
  threadId: ThreadId,
  role: "user" | "assistant",
  text: string,
): OrchestrationV2ConversationMessage {
  const now = makeThreadProjectionFixture().updatedAt;
  return {
    id: MessageId.make(`message-${role}`),
    threadId,
    runId: RUN,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider",
    createdAt: now,
    updatedAt: now,
  };
}

/** The server creates the draft's reserved thread with its first message. */
function createThreadOnServer(ref: ScopedThreadRef, firstMessage: string) {
  const fixture = makeThreadProjectionFixture();
  mocks.server.threads.set(runsKey(ref), {
    ...fixture,
    thread: { ...fixture.thread, id: ref.threadId },
    messages: [conversationMessage(ref.threadId, "user", firstMessage)],
  });
}

function requireHook(hook: { current: HookResult | null }): HookResult {
  if (hook.current === null) throw new Error("hook did not render");
  return hook.current;
}

async function beginChangedEdit(hook: { current: HookResult | null }) {
  await act(() =>
    requireHook(hook).beginEdit({
      runId: RUN,
      messageId: MessageId.make("message-1"),
      text: "original",
      attachments: [],
    }),
  );
  await act(() =>
    useComposerDraftStore.getState().setPrompt(requireHook(hook).draftTarget, "changed"),
  );
}

const savedContent = (prompt: string) => ({
  prompt,
  images: [],
  files: [],
  terminalContexts: [],
  reviewComments: [],
  previewAnnotations: [],
  threadContexts: [],
});

const promptOf = (ref: ScopedThreadRef) =>
  useComposerDraftStore.getState().getComposerDraft(ref)?.prompt ?? "";

describe("useQueuedRunEdit", () => {
  it.each([
    { navigation: "switches before the reply", resets: false, focuses: false },
    { navigation: "switches before the frame", resets: true, focuses: false },
    { navigation: "stays on thread", resets: true, focuses: true },
  ])("finishes a successful queued edit when the user $navigation", async (scenario) => {
    const { hook } = setup();
    const requested = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<{ readonly _tag: "Success" }>();
    mocks.editQueuedRun.mockImplementation(() => {
      requested.resolve();
      return reply.promise;
    });
    const focusAtEnd = vi.fn();
    const resetCursorState = vi.fn();
    const composer: ComposerRefs = {
      promptRef: { current: "changed" },
      composerRef: { current: null },
    };
    await using screen = await render(view(THREAD_A, "queued", hook, THREAD_A, [], composer));
    const frames: FrameRequestCallback[] = [];
    using _frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return 0;
    });
    await beginChangedEdit(hook);
    await act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    composer.composerRef.current = {
      focusAtEnd,
      resetCursorState,
    } as unknown as ChatComposerHandle;

    const setThreadError = vi.fn();
    const saved = requireHook(hook).saveEdit(savedContent("changed"), setThreadError);
    await requested.promise;
    const openOtherThread = async () => {
      await screen.rerender(view(THREAD_B, "queued", hook, THREAD_B, [], composer));
      composer.promptRef.current = "other thread draft";
    };
    if (scenario.navigation === "switches before the reply") await openOtherThread();
    reply.resolve({ _tag: "Success" });
    await act(() => saved);
    expect(setThreadError).toHaveBeenCalledExactlyOnceWith(THREAD_A.threadId, null);
    expect(resetCursorState).toHaveBeenCalledTimes(Number(scenario.resets));

    if (scenario.navigation === "switches before the frame") await openOtherThread();
    await act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(focusAtEnd).toHaveBeenCalledTimes(Number(scenario.focuses));
    expect(composer.promptRef.current).toBe(
      scenario.navigation === "stays on thread" ? "" : "other thread draft",
    );
  });

  it("hides an attachment-only placeholder while editing and restores it when saving", async () => {
    const { hook } = setup();
    mocks.editQueuedRun.mockResolvedValue({ _tag: "Success" });
    await using _screen = await render(view(THREAD_A, "queued", hook));
    await act(() =>
      requireHook(hook).beginEdit({
        runId: RUN,
        messageId: MessageId.make("message-1"),
        text: `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
        attachments: [
          {
            type: "image",
            id: ChatAttachmentId.make("kept"),
            name: "kept.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ],
      }),
    );
    const prompt = useComposerDraftStore
      .getState()
      .getComposerDraft(requireHook(hook).draftTarget)?.prompt;
    expect(prompt).toBe("Ultrathink:");
    await act(() => requireHook(hook).saveEdit(savedContent(prompt ?? ""), () => {}));
    expect(mocks.editQueuedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          text: `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
        }),
      }),
    );
  });
  it("lets a thread started from a draft go live and show its first message and reply without a remount", async () => {
    const { hook } = setup();
    const draftRef: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("draft") };
    // ChatView passes no detail ref while the draft waits for the server's shell.
    await using screen = await render(view(draftRef, "queued", hook, null));

    createThreadOnServer(draftRef, "Fix the flaky login test");
    await screen.rerender(view(draftRef, "queued", hook, draftRef));

    await expect.element(screen.getByText("status live")).toBeInTheDocument();
    await expect.element(screen.getByText("Fix the flaky login test")).toBeInTheDocument();
    Queue.offerUnsafe(await mocks.server.socket, {
      kind: "event",
      sequence: 2,
      event: {
        id: EventId.make("event-reply"),
        type: "message.updated",
        threadId: draftRef.threadId,
        occurredAt: makeThreadProjectionFixture().updatedAt,
        payload: conversationMessage(draftRef.threadId, "assistant", "On it."),
      },
    });
    await expect.element(screen.getByText("On it.")).toBeInTheDocument();
  });

  it("adds terminal context to the queued message being edited", async () => {
    const { hook } = setup();
    await using _screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);
    const target = requireHook(hook).draftTarget;
    const inserted = useComposerDraftStore.getState().insertTerminalContext(
      target,
      `changed${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}`,
      {
        id: "terminal-context-1",
        threadId: THREAD_A.threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 3,
        lineEnd: 3,
        text: "hello",
      },
      0,
    );
    expect(inserted).toBe(true);
    expect(
      useComposerDraftStore.getState().getComposerDraft(target)?.terminalContexts,
    ).toHaveLength(1);
  });

  it("opens an edit with only thread records its text still mentions", async () => {
    const { hook } = setup();
    const thread = threadContextRecord(THREAD_B, "Support Any File Uploads");
    const unreferenced = threadContextRecord(THREAD_A, "Removed earlier");
    const messageId = MessageId.make("message-1");
    const text = `wait for ${formatInlineContextReference(threadContextReference(thread))}`;
    const messages = [
      { id: messageId, text, context: { version: 1, records: [thread, unreferenced] } },
    ];
    await using _screen = await render(view(THREAD_A, "queued", hook, THREAD_A, messages));

    await act(() => requireHook(hook).beginEdit({ runId: RUN, messageId, text, attachments: [] }));

    const draft = useComposerDraftStore.getState().getComposerDraft(requireHook(hook).draftTarget);
    expect(draft?.prompt).toBe(text);
    expect(draft?.threadContexts).toEqual([thread]);
  });

  it("saves only the thread mentions still in the edited message", async () => {
    const { hook } = setup();
    mocks.editQueuedRun.mockResolvedValue({ _tag: "Success" });
    const kept = threadContextRecord(THREAD_B, "Kept");
    const removed = threadContextRecord(THREAD_A, "Removed");
    const messageId = MessageId.make("message-1");
    const text = [kept, removed]
      .map((record) => formatInlineContextReference(threadContextReference(record)))
      .join(" and ");
    const messages = [{ id: messageId, text, context: { version: 1, records: [kept, removed] } }];
    await using _screen = await render(view(THREAD_A, "queued", hook, THREAD_A, messages));
    await act(() => requireHook(hook).beginEdit({ runId: RUN, messageId, text, attachments: [] }));
    const target = requireHook(hook).draftTarget;
    await act(() => useComposerDraftStore.getState().setThreadContexts(target, [kept]));

    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    await requireHook(hook).saveEdit(
      { ...savedContent(draft?.prompt ?? ""), threadContexts: draft?.threadContexts ?? [] },
      () => {},
    );

    expect(mocks.editQueuedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          edit: expect.objectContaining({ context: { version: 1, records: [kept] } }),
        }),
      }),
    );
  });

  it("keeps an open edit when the user leaves the thread and comes back", async () => {
    const { hook } = setup();
    await using screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);

    await screen.rerender(view(THREAD_B, "queued", hook));
    expect(requireHook(hook).isEditing).toBe(false);
    await screen.rerender(view(THREAD_A, "queued", hook));

    expect(requireHook(hook).editingRunId).toBe(RUN);
    expect(
      useComposerDraftStore.getState().getComposerDraft(requireHook(hook).draftTarget)?.prompt,
    ).toBe("changed");
  });

  it("moves a changed edit into the thread draft when its run starts while the user is away", async () => {
    const { hook } = setup();
    await using screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);

    await screen.rerender(view(THREAD_B, "queued", hook));
    expect(promptOf(THREAD_A)).toBe("");
    await act(() => setRuns(THREAD_A, "running"));

    expect(promptOf(THREAD_A)).toBe("changed");
  });

  it("does not copy a saved edit into the thread draft when the run starts mid-save", async () => {
    const { hook } = setup();
    let finishSave: (result: { readonly _tag: "Success" }) => void = () => {};
    mocks.editQueuedRun.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    await using screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);

    // Not inside act(): act would hold the projection update until the save settles.
    const saved = requireHook(hook).saveEdit(savedContent("changed"), () => {});
    await vi.waitFor(() => expect(mocks.editQueuedRun).toHaveBeenCalledOnce());
    // The server applied the edit and then started the run; the projection
    // reports the start before the edit's acknowledgement arrives.
    await act(() => setRuns(THREAD_A, "running"));
    await screen.rerender(view(THREAD_A, "running", hook));
    finishSave({ _tag: "Success" });
    await act(() => saved);

    expect(requireHook(hook).isEditing).toBe(false);
    expect(promptOf(THREAD_A)).toBe("");
  });

  it.each(["discard", "success", "failure", "newer", "recovery"] as const)(
    "preserves staged ownership through queued edit $case",
    async (scenario) => {
      const { hook } = setup();
      let finish!: (result: { readonly _tag: "Success" | "Failure" }) => void;
      let started!: () => void;
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      mocks.editQueuedRun.mockImplementation(() => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      await using _screen = await render(view(THREAD_A, "queued", hook));
      await beginChangedEdit(hook);
      const image = {
        type: "image" as const,
        id: `owned-${scenario}`,
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 5,
        file: new File(["image"], "image.png", { type: "image/png" }),
        previewUrl: `blob:owned-${scenario}`,
      };
      using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      const target = requireHook(hook).draftTarget;
      await act(() => useComposerDraftStore.getState().addImages(target, [image]));
      useAttachmentUploadStore.setState({
        uploadsByImageId: {
          [image.id]: { status: "ready", environmentId: ENV, attachmentId: "upload" },
        },
      });
      if (scenario === "discard") {
        await act(() => requireHook(hook).cancelEdit());
        expect(readAttachmentUpload(image.id)).toBeUndefined();
        expect(revoke).toHaveBeenCalledExactlyOnceWith(image.previewUrl);
        return;
      }
      const saved = requireHook(hook).saveEdit(
        { ...savedContent("changed"), images: [image] },
        () => {},
      );
      await requested;
      if (scenario === "newer") {
        await beginChangedEdit(hook);
        await act(() => useComposerDraftStore.getState().addImages(target, [image]));
      }
      if (scenario === "recovery") await act(() => setRuns(THREAD_A, "running"));
      expect(readAttachmentUpload(image.id)).toBeDefined();
      expect(revoke).not.toHaveBeenCalled();
      finish({ _tag: scenario === "failure" || scenario === "recovery" ? "Failure" : "Success" });
      await act(() => saved);
      if (scenario === "success") {
        expect(readAttachmentUpload(image.id)).toBeUndefined();
        expect(revoke).toHaveBeenCalledExactlyOnceWith(image.previewUrl);
      } else {
        expect(readAttachmentUpload(image.id)).toBeDefined();
        expect(revoke).not.toHaveBeenCalled();
      }
    },
  );

  it("retries the same queued edit and staged upload with the latest content", async () => {
    const { hook } = setup();
    mocks.editQueuedRun
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValueOnce({ _tag: "Success" });
    await using _screen = await render(view(THREAD_A, "queued", hook));
    const original = appAtomRegistry.get.bind(appAtomRegistry);
    using get = vi.spyOn(appAtomRegistry, "get");
    get.mockImplementation(((atom: unknown) =>
      atom === environmentServerConfigsAtom
        ? new Map([
            [
              ENV,
              {
                environment: {
                  capabilities: {
                    attachmentUploads: true,
                    fileAttachments: { maxUploadBytes: 100000 },
                  },
                },
              },
            ],
          ])
        : original(atom as never)) as never);
    using upload = vi.spyOn(XMLHttpRequest.prototype, "open");
    await beginChangedEdit(hook);
    const file = {
      type: "file" as const,
      id: "retry-file",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 6,
      file: new File(["report"], "report.pdf", { type: "application/pdf" }),
    };
    const target = requireHook(hook).draftTarget;
    await act(() => useComposerDraftStore.getState().addFiles(target, [file]));
    useAttachmentUploadStore.setState({
      uploadsByImageId: {
        [file.id]: { status: "ready", environmentId: ENV, attachmentId: "staged-upload" },
      },
    });
    const errors: Array<string | null> = [];
    await act(() =>
      requireHook(hook).saveEdit({ ...savedContent("first"), files: [file] }, (_, error) =>
        errors.push(error),
      ),
    );
    expect(errors).toEqual(["Could not save the edited queued message."]);
    expect(readAttachmentUpload(file.id)).toBeDefined();
    await act(() =>
      requireHook(hook).saveEdit({ ...savedContent("latest"), files: [file] }, () => {}),
    );
    expect(upload).not.toHaveBeenCalled();
    expect(mocks.editQueuedRun).toHaveBeenCalledTimes(2);
    const calls = mocks.editQueuedRun.mock.calls.map(
      ([call]) =>
        call as {
          environmentId: EnvironmentId;
          input: {
            threadId: ThreadId;
            runId: RunId;
            text: string;
            edit: { messageId: MessageId; attachments: Array<{ id: string }> };
          };
        },
    );
    for (const call of calls) {
      expect(call.environmentId).toBe(ENV);
      expect(call.input.threadId).toBe(THREAD_A.threadId);
      expect(call.input.runId).toBe(RUN);
      expect(call.input.edit.messageId).toBe(MessageId.make("message-1"));
      expect(call.input.edit.attachments[0]?.id).toBe("staged-upload");
    }
    expect(calls[1]?.input.text).toBe("latest");
    expect(readAttachmentUpload(file.id)).toBeUndefined();
  });

  it.each([8000, 8001] as const)("keeps a queued annotation at length %i safe", async (length) => {
    const { hook } = setup();
    mocks.editQueuedRun.mockResolvedValue({ _tag: "Success" });
    await using _screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);
    const target = requireHook(hook).draftTarget;
    const annotation = {
      id: "annotation",
      pageUrl: "https://example.test",
      pageTitle: null,
      comment: "x".repeat(length),
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await act(() => useComposerDraftStore.getState().addPreviewAnnotation(target, annotation));
    const error = vi.fn();
    await act(() =>
      requireHook(hook).saveEdit(
        { ...savedContent("changed"), previewAnnotations: [annotation] },
        error,
      ),
    );
    if (length === 8000) expect(mocks.editQueuedRun).toHaveBeenCalledOnce();
    else {
      expect(mocks.editQueuedRun).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        THREAD_A.threadId,
        "Annotation comments must be 8,000 characters or fewer.",
      );
      expect(
        useComposerDraftStore.getState().getComposerDraft(target)?.previewAnnotations[0]?.comment,
      ).toHaveLength(8001);
    }
  });

  it("leaves a newer edit alone when a save from before navigation finishes", async () => {
    const { hook } = setup();
    let finishSave: (result: { readonly _tag: "Success" }) => void = () => {};
    mocks.editQueuedRun.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    await using screen = await render(view(THREAD_A, "queued", hook));
    await beginChangedEdit(hook);
    // Not inside act(): act would hold the rerenders until the save settles.
    const saved = requireHook(hook).saveEdit(savedContent("changed"), () => {});
    await vi.waitFor(() => expect(mocks.editQueuedRun).toHaveBeenCalledOnce());

    // Leaving the thread unmounts the chat view; coming back mounts a new one.
    await screen.rerender(<AppAtomRegistryProvider>{null}</AppAtomRegistryProvider>);
    await screen.rerender(view(THREAD_A, "queued", hook));
    expect(requireHook(hook).isSaving).toBe(true);
    await beginChangedEdit(hook);
    await act(() =>
      useComposerDraftStore.getState().setPrompt(requireHook(hook).draftTarget, "newer"),
    );

    finishSave({ _tag: "Success" });
    await act(() => saved);

    expect(requireHook(hook).editingRunId).toBe(RUN);
    expect(requireHook(hook).isSaving).toBe(false);
    expect(
      useComposerDraftStore.getState().getComposerDraft(requireHook(hook).draftTarget)?.prompt,
    ).toBe("newer");
  });
});

it("recovers a reply-only edit when the queued run starts", async () => {
  const { TurnItemId } = await import("@goat/contracts");
  const { responseContextRecord } = await import("../../lib/composerContextRecords");
  const { hook } = setup();
  await using _screen = await render(view(THREAD_A, "queued", hook));
  await act(() =>
    requireHook(hook).beginEdit({
      runId: RUN,
      messageId: MessageId.make("message-1"),
      text: "original",
      attachments: [],
    }),
  );
  const reply = responseContextRecord({
    citation: {
      version: 1,
      environmentId: ENV,
      threadId: THREAD_A.threadId,
      messageId: MessageId.make("answer"),
      text: "Done",
      start: 0,
      end: 4,
      prefix: "",
      suffix: "",
    },
    itemId: TurnItemId.make("answer-item"),
    subagents: [],
  });
  await act(() =>
    useComposerDraftStore.getState().setReplyTo(requireHook(hook).draftTarget, reply),
  );
  await act(() => setRuns(THREAD_A, "running"));
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().getComposerDraft(THREAD_A)?.replyTo).toEqual(reply),
  );
});
