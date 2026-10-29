import { useAtomValue } from "@effect/atom-react";
import type {
  ConnectionCatalogEntry,
  NetworkStatus,
  PreparedConnection,
} from "@goat/client-runtime/connection";
import type { RpcSession } from "@goat/client-runtime/rpc/session";
import type { ThreadStructure } from "@goat/client-runtime/state/shell";
import type { createEnvironmentThreadDetailAtoms } from "@goat/client-runtime/state/threads";
import {
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
import type * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { useImperativeHandle, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { useQueuedRunEdit } from "./useQueuedRunEdit";

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

function projection(runs: ReadonlyArray<RunStatus>) {
  return { runs, messages: [] } as unknown as ThreadStructure;
}

function setRuns(ref: ScopedThreadRef, status: string) {
  appAtomRegistry.set(mocks.threadRuns(runsKey(ref)), [{ id: RUN, status }]);
}

function Harness(props: {
  readonly threadRef: ScopedThreadRef;
  readonly threadDetailRef: ScopedThreadRef | null;
  readonly runStatus: string;
  readonly hookRef: RefObject<HookResult | null>;
}) {
  const result = useQueuedRunEdit({
    environmentId: ENV,
    routeThreadRef: props.threadRef,
    threadDetailRef: props.threadDetailRef,
    threadDraftTarget: props.threadRef,
    activeThreadId: props.threadRef.threadId,
    serverProjection:
      props.threadDetailRef === null ? null : projection([{ id: RUN, status: props.runStatus }]),
    promptRef: { current: "" },
    composerRef: { current: null },
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
) {
  return (
    <AppAtomRegistryProvider>
      <Harness
        threadRef={threadRef}
        threadDetailRef={threadDetailRef}
        runStatus={runStatus}
        hookRef={hook}
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
