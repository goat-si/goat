import type { createEnvironmentThreadDetailAtoms } from "@goat/client-runtime/state/threads";
import {
  BotProfile,
  EnvironmentId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
  type ScopedThreadRef,
} from "@goat/contracts";
import type {
  ConnectionCatalogEntry,
  NetworkStatus,
  PreparedConnection,
} from "@goat/client-runtime/connection";
import type { RpcSession } from "@goat/client-runtime/rpc/session";
import * as DateTime from "effect/DateTime";
import type * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import "../../index.css";

type ThreadDetails = ReturnType<typeof createEnvironmentThreadDetailAtoms>;
type ServerSocket = Queue.Queue<OrchestrationV2ThreadStreamItem>;
const mocks = vi.hoisted(() => ({
  details: null as ThreadDetails | null,
  taskMode: false,
  taskThreads: null as import("effect/reactivity").Atom.Writable<unknown> | null,
  server: {
    threads: new Map<string, OrchestrationV2ThreadProjection>(),
    socket: new Promise<ServerSocket>(() => {}),
    openSocket: (_socket: ServerSocket) => {},
    httpRequests: 0,
  },
}));

vi.mock("./goatBotHooks", async (original) => ({
  ...(await original<typeof import("./goatBotHooks")>()),
  useGoatBotEnvironments: () =>
    mocks.taskMode
      ? [
          {
            environmentId: "g1-sync-snapshot-test",
            connected: true,
            supportsChannelLedger: true,
            primary: true,
          },
        ]
      : [],
}));
vi.mock("~/state/entities", async (original) => {
  const actual = await original<typeof import("~/state/entities")>();
  return {
    ...actual,
    useServerConfigs: () => {
      const configs = actual.useServerConfigs();
      return mocks.taskMode
        ? new Map([
            [
              "g1-sync-snapshot-test",
              { environment: { capabilities: { goatBotTaskThreads: true } } },
            ],
          ])
        : configs;
    },
    useEnvironmentShellsBootstrapped: (
      id: Parameters<typeof actual.useEnvironmentShellsBootstrapped>[0],
    ) => {
      const ready = actual.useEnvironmentShellsBootstrapped(id);
      return mocks.taskMode || ready;
    },
  };
});
vi.mock("~/state/channels", async (original) => {
  const actual = await original<typeof import("~/state/channels")>();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const taskThreads = Atom.make(AsyncResult.success({ rows: [] }));
  mocks.taskThreads = taskThreads as import("effect/reactivity").Atom.Writable<unknown>;
  return {
    ...actual,
    channelEnvironment: {
      ...actual.channelEnvironment,
      listBotThreads: (input: Parameters<typeof actual.channelEnvironment.listBotThreads>[0]) =>
        mocks.taskMode ? taskThreads : actual.channelEnvironment.listBotThreads(input),
    },
  };
});

vi.mock("~/state/threads", async (original) => {
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
  const storage = await import("~/connection/storage");
  const { HttpClient, HttpClientResponse } = await import("effect/http");
  const threads = await import("@goat/client-runtime/state/threads");
  const environment = Layer.unwrap(
    Effect.gen(function* () {
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("g1-sync-snapshot-test"),
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
            initialConfig: Effect.succeed({ threadResumeCompletionMarker: true }),
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
        storage.layer,
        threads.BoundedThreadSnapshotLoader.layer.pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  mocks.server.httpRequests += 1;
                  return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
                }),
              ),
            ),
          ),
        ),
      );
    }),
  );
  const details = threads.createEnvironmentThreadDetailAtoms(
    threads.createEnvironmentThreadStateAtoms(Atom.runtime(environment)).stateAtom,
  );
  mocks.details = details;
  return {
    ...(await original<typeof import("~/state/threads")>()),
    environmentThreadDetails: details,
  };
});

import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadVisibleTurnItems } from "~/state/entities";
import { makeThreadProjectionFixture } from "~/test-fixtures";
import { randomUUID } from "~/lib/utils";
import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { useGoatBotSession } from "./useGoatBotSession";
import { verifySidebarReopen } from "./GoatBotChatView.reopen.test-support";
import { completedTask, taskOutcome, turnItem } from "./GoatBotChatView.sync.fixtures";
import { GoatBotChannelContext, type GoatBotChannelPort } from "./goatBotChannelPort";
import { AsyncResult } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { Persistence } from "@goat/client-runtime/platform";
import { layer as storageLayer } from "~/connection/storage";

const environmentId = EnvironmentId.make("g1-sync-snapshot-test");
const at = DateTime.makeUnsafe("2026-10-12T09:40:00Z");
const decodeProfile = Schema.decodeSync(BotProfile);
const profile = (threadId: ThreadId) =>
  decodeProfile({
    botId: threadId,
    role: "member",
    name: "Research",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId,
    sessionThreadId: threadId,
    createdAt: "2026-10-12T09:40:00.000Z",
    updatedAt: "2026-10-12T09:40:00.000Z",
  });

function MemberChat({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const items = useThreadVisibleTurnItems(threadRef);
  const member = profile(threadRef.threadId);
  const session = useGoatBotSession(items, null, member);
  return (
    <div style={{ display: "flex", height: 400, width: 360 }}>
      <GoatBotMemberContext value={member}>
        <GoatBotChatView
          {...session}
          projectionRef={threadRef}
          environmentId={environmentId}
          legacyAgentRoute={null}
        />
      </GoatBotMemberContext>
    </div>
  );
}

function TaskChat({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const [port] = useState<GoatBotChannelPort>(() => ({
    ensureBot: async () => ({
      environmentId,
      projectId: ProjectId.make("project"),
      threadId: threadRef.threadId,
    }),
    getBotStatus: async () => {
      throw new Error("unexpected status read");
    },
    ingest: async () => {
      throw new Error("unexpected send");
    },
    listTasks: async () => {
      throw new Error("unexpected task read");
    },
    useCanSend: () => true,
  }));
  return (
    <GoatBotChannelContext value={port}>
      <MemberChat threadRef={threadRef} />
    </GoatBotChannelContext>
  );
}

async function taskList(taskIds: readonly string[]) {
  if (!mocks.taskThreads) throw new Error("task list atom unavailable");
  await act(() =>
    appAtomRegistry.set(
      mocks.taskThreads!,
      AsyncResult.success({ rows: taskIds.map((taskId) => ({ kind: "task", task: { taskId } })) }),
    ),
  );
}

function projected(item: OrchestrationV2TurnItem, position: number) {
  return {
    position,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
}

function nextAtom<A>(atom: Atom.Atom<A>, predicate: (value: A) => boolean): Promise<A> {
  const current = appAtomRegistry.get(atom);
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let done = false;
    const receive = (value: A) => {
      if (done || !predicate(value)) return;
      done = true;
      unsubscribe?.();
      resolve(value);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, receive);
    if (done) unsubscribe();
    else receive(appAtomRegistry.get(atom));
  });
}

function setup(thread: string, history: ReadonlyArray<OrchestrationV2TurnItem> = []) {
  mocks.taskMode = false;
  const threadRef = { environmentId, threadId: ThreadId.make(`${thread}-${randomUUID()}`) };
  const fixture = makeThreadProjectionFixture();
  mocks.server.threads.set(threadRef.threadId, {
    ...fixture,
    thread: { ...fixture.thread, id: threadRef.threadId },
    turnItems: history.map((item) => ({ ...item, threadId: threadRef.threadId })),
    visibleTurnItems: history.map((item, position) =>
      projected({ ...item, threadId: threadRef.threadId }, position),
    ),
  });
  mocks.server.socket = new Promise<ServerSocket>((resolve) => {
    mocks.server.openSocket = resolve;
  });
  mocks.server.httpRequests = 0;
  return threadRef;
}

async function synchronized(threadRef: ScopedThreadRef) {
  const socket = await mocks.server.socket;
  expect(mocks.server.httpRequests).toBeGreaterThan(0);
  const details = mocks.details;
  if (!details) throw new Error("thread details were not installed");
  await act(async () => {
    const projection = mocks.server.threads.get(threadRef.threadId);
    if (!projection) throw new Error("missing server snapshot");
    Queue.offerUnsafe(socket, { kind: "snapshot", snapshotSequence: 1, projection });
    await nextAtom(details.threadAtom(threadRef), (value) => value !== null);
    expect(appAtomRegistry.get(details.statusAtom(threadRef))).toBe("synchronizing");
    Queue.offerUnsafe(socket, { kind: "synchronized" });
    await nextAtom(details.statusAtom(threadRef), (status) => status === "live");
  });
  return { socket, details };
}

async function deliver(
  socket: ServerSocket,
  details: ThreadDetails,
  threadRef: ScopedThreadRef,
  item: OrchestrationV2TurnItem,
  sequence: number,
) {
  await act(async () => {
    Queue.offerUnsafe(socket, {
      kind: "event",
      sequence,
      event: {
        id: EventId.make(`event-${item.id}`),
        type: "turn-item.updated",
        threadId: threadRef.threadId,
        occurredAt: at,
        payload: item,
      },
    });
    await nextAtom(details.visibleTurnItemsAtom(threadRef), (items) =>
      items.some(({ item: next }) => next.id === item.id),
    );
  });
}

it("guard: an outcome hidden at baseline stays silent when the task list resolves", async () => {
  const id = ThreadId.make("task-history");
  const threadRef = setup(id, [
    turnItem(
      id,
      "history",
      "user",
      Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n"),
      1,
    ),
    completedTask(id, "card", "task-1", 2),
    taskOutcome(id, "old-outcome", "task-1", 3),
  ]);
  mocks.taskMode = true;
  await taskList([]);
  await using screen = await render(
    <AppAtomRegistryProvider>
      <TaskChat threadRef={threadRef} />
    </AppAtomRegistryProvider>,
  );
  const { details } = await synchronized(threadRef);
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Outcome"));
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  expect(screen.container.textContent).not.toContain("Outcome old-outcome");
  const source = appAtomRegistry.get(details.visibleTurnItemsAtom(threadRef));
  await taskList(["task-1"]);
  expect(appAtomRegistry.get(details.visibleTurnItemsAtom(threadRef))).toBe(source);
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Outcome old-outcome"));
  expect(screen.container.querySelector("[data-goat-bot-reply-status]")?.textContent).toBe("");
  expect(screen.container.textContent).not.toContain("Jump to latest");
});

it("announces a new hidden outcome once when the task list exposes it", async () => {
  const id = ThreadId.make("task-new");
  const threadRef = setup(id, [
    turnItem(
      id,
      "history",
      "user",
      Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n"),
      1,
    ),
    completedTask(id, "card", "task-1", 2),
  ]);
  mocks.taskMode = true;
  await taskList([]);
  await using screen = await render(
    <AppAtomRegistryProvider>
      <TaskChat threadRef={threadRef} />
    </AppAtomRegistryProvider>,
  );
  const { socket, details } = await synchronized(threadRef);
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  const outcome = taskOutcome(threadRef.threadId, "new-outcome", "task-1", 3);
  await deliver(socket, details, threadRef, outcome, 2);
  const status = screen.container.querySelector("[data-goat-bot-reply-status]");
  expect(status?.textContent).toBe("");
  expect(screen.container.textContent).not.toContain("Jump to latest");
  const source = appAtomRegistry.get(details.visibleTurnItemsAtom(threadRef));
  await taskList(["task-1"]);
  expect(appAtomRegistry.get(details.visibleTurnItemsAtom(threadRef))).toBe(source);
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Outcome new-outcome"));
  expect(status?.textContent).toMatch(/Research posted an update\.|New update from Research\./);
  await expect
    .element(screen.getByRole("button", { name: "Jump to latest", exact: true }))
    .toBeVisible();
  const announced = status?.textContent;
  await taskList([]);
  await taskList(["task-1"]);
  expect(status?.textContent).toBe(announced);
  expect(screen.container.textContent).not.toContain("Jump to latest");
});

it("does not reannounce older replies when a task card hides and restores the newest outcome", async () => {
  const id = ThreadId.make("task-revision");
  const finished = completedTask(id, "card", "task-1", 2);
  if (finished.type !== "notification" || !finished.ledgerTask)
    throw new Error("expected task card");
  const running = {
    ...finished,
    ledgerTask: { ...finished.ledgerTask, status: "running" as const, summary: "In progress" },
  };
  const threadRef = setup(id, [turnItem(id, "history", "user", "History", 1), running]);
  mocks.taskMode = true;
  await taskList([]);
  await using screen = await render(
    <AppAtomRegistryProvider>
      <TaskChat threadRef={threadRef} />
    </AppAtomRegistryProvider>,
  );
  const { socket, details } = await synchronized(threadRef);
  await deliver(
    socket,
    details,
    threadRef,
    turnItem(threadRef.threadId, "older", "assistant", "Older reply", 3),
    2,
  );
  await deliver(
    socket,
    details,
    threadRef,
    taskOutcome(threadRef.threadId, "newest", "task-1", 4),
    3,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Outcome newest"));
  const status = screen.container.querySelector("[data-goat-bot-reply-status]");
  const spoken = status?.textContent;
  expect(spoken).toMatch(/update/);
  const revise = async (card: OrchestrationV2TurnItem, sequence: number) => {
    if (card.type !== "notification") throw new Error("expected task notification");
    await act(async () => {
      Queue.offerUnsafe(socket, {
        kind: "event",
        sequence,
        event: {
          id: EventId.make(`card-${sequence}`),
          type: "turn-item.updated",
          threadId: threadRef.threadId,
          occurredAt: at,
          payload: { ...card, threadId: threadRef.threadId },
        },
      });
      await nextAtom(details.visibleTurnItemsAtom(threadRef), (items) =>
        items.some(
          ({ item }) =>
            item.type === "notification" &&
            item.id === card.id &&
            item.ledgerTask?.status === card.ledgerTask?.status,
        ),
      );
    });
  };
  await revise({ ...running, ledgerTask: { ...finished.ledgerTask, taskVersion: 2 } }, 4);
  expect(screen.container.textContent).not.toContain("Outcome newest");
  expect(status?.textContent).toBe(spoken);
  await revise({ ...running, ledgerTask: { ...running.ledgerTask, taskVersion: 3 } }, 5);
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Outcome newest"));
  expect(status?.textContent).toBe(spoken);
});

it("guard: a synchronized empty mounted chat has an empty baseline and status", async () => {
  const threadRef = setup("empty-guard");
  await using screen = await render(
    <AppAtomRegistryProvider>
      <MemberChat threadRef={threadRef} />
    </AppAtomRegistryProvider>,
  );
  const { details } = await synchronized(threadRef);
  expect(appAtomRegistry.get(details.visibleTurnItemsAtom(threadRef))).toHaveLength(0);
  expect(screen.container.querySelector("[data-goat-bot-reply-status]")?.textContent).toBe("");
});

it("baselines persisted cached history when the mounted chat becomes live", async () => {
  const id = ThreadId.make("cached-history");
  const threadRef = setup(id, [turnItem(id, "cached-reply", "assistant", "Cached reply", 1)]);
  const projection = mocks.server.threads.get(threadRef.threadId);
  if (!projection) throw new Error("missing cached snapshot");
  const save = Atom.runtime(storageLayer).atom(
    Effect.gen(function* () {
      const store = yield* Persistence.EnvironmentCacheStore;
      yield* store.saveThread(environmentId, { snapshotSequence: 1, projection });
    }),
  );
  const saved = await nextAtom(
    save,
    (result) => result._tag === "Success" || result._tag === "Failure",
  );
  if (saved._tag === "Failure") throw new Error("could not seed cached thread");
  await using screen = await render(
    <AppAtomRegistryProvider>
      <MemberChat threadRef={threadRef} />
    </AppAtomRegistryProvider>,
  );
  const details = mocks.details;
  if (!details) throw new Error("thread details were not installed");
  await nextAtom(details.visibleTurnItemsAtom(threadRef), (items) =>
    items.some(({ item }) => item.id === "cached-reply"),
  );
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Cached reply"));
  const status = screen.container.querySelector("[data-goat-bot-reply-status]");
  expect(status?.textContent).toBe("");
  const socket = await mocks.server.socket;
  await act(async () => {
    Queue.offerUnsafe(socket, { kind: "synchronized" });
    await nextAtom(details.statusAtom(threadRef), (value) => value === "live");
  });
  expect(status?.textContent).toBe("");
  await deliver(
    socket,
    details,
    threadRef,
    turnItem(threadRef.threadId, "catch-up", "assistant", "Catch-up reply", 2),
    2,
  );
  expect(status?.textContent).toMatch(/Research replied\.|New reply from Research\./);
});

it("reopens live history silently and announces one reply arriving afterward", () =>
  verifySidebarReopen({ setup, synchronized, deliver, MemberChat }));

it.each(["above", "following"] as const)(
  "the first reply after an empty synchronized member snapshot is new while %s",
  async (mode) => {
    const threadRef = setup(`empty-${mode}`);
    await using screen = await render(
      <AppAtomRegistryProvider>
        <MemberChat threadRef={threadRef} />
      </AppAtomRegistryProvider>,
    );
    const { socket, details } = await synchronized(threadRef);
    expect(appAtomRegistry.get(details.visibleTurnItemsAtom(threadRef))).toHaveLength(0);
    expect(screen.container.textContent).not.toContain("Jump to latest");
    const message = turnItem(
      threadRef.threadId,
      `user-${mode}`,
      "user",
      Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n"),
      1,
    );
    await deliver(socket, details, threadRef, message, 2);
    const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    if (mode === "above")
      await act(() => {
        scroll.scrollTop = 0;
        scroll.dispatchEvent(new Event("scroll"));
      });
    const answer = turnItem(
      threadRef.threadId,
      `reply-${mode}`,
      "assistant",
      `First reply ${mode}`,
      2,
    );
    await deliver(socket, details, threadRef, answer, 3);
    expect(screen.container.querySelector("[data-goat-bot-reply-status]")?.textContent).toMatch(
      /Research replied\.|New reply from Research\./,
    );
    const row = screen.container.querySelector<HTMLElement>(`[data-bot-row="${answer.id}"]`)!;
    expect(row).not.toBeNull();
    if (mode === "above") {
      expect(screen.container.textContent).toContain("Jump to latest");
      expect(row.getBoundingClientRect().top).toBeGreaterThan(
        scroll.getBoundingClientRect().bottom,
      );
    } else {
      expect(screen.container.textContent).not.toContain("Jump to latest");
      expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        scroll.getBoundingClientRect().bottom + 1,
      );
    }
  },
);

it("keeps a new-reply cue while a live projected reply streams, then counts a new reply", async () => {
  const threadId = ThreadId.make("member-stream");
  const history = [
    turnItem(
      threadId,
      "history",
      "user",
      Array.from({ length: 80 }, (_, i) => `History ${i}`).join("\n"),
      1,
    ),
  ];
  const threadRef = setup(threadId, history);
  await using screen = await render(
    <AppAtomRegistryProvider>
      <MemberChat threadRef={threadRef} />
    </AppAtomRegistryProvider>,
  );
  const { socket, details } = await synchronized(threadRef);
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  const item = turnItem(threadRef.threadId, "stream", "assistant", "Alpha", 2);
  if (item.type !== "assistant_message") throw new Error("expected assistant message");
  await deliver(socket, details, threadRef, { ...item, streaming: true }, 2);
  await expect.element(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  using writes = vi.spyOn(scroll, "scrollTop", "set");
  await act(async () => {
    Queue.offerUnsafe(socket, {
      kind: "event",
      sequence: 3,
      event: {
        id: EventId.make("stream-text"),
        type: "turn-item.updated",
        threadId: threadRef.threadId,
        occurredAt: at,
        payload: { ...item, text: "Bravo", streaming: true },
      },
    });
    await nextAtom(details.visibleTurnItemsAtom(threadRef), (items) =>
      items.some(
        ({ item: next }) =>
          next.type === "assistant_message" && next.id === item.id && next.text === "Bravo",
      ),
    );
  });
  expect(screen.container.textContent).toContain("Bravo");
  expect(screen.container.textContent).not.toContain("Alpha");
  expect(writes).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await deliver(
    socket,
    details,
    threadRef,
    turnItem(threadRef.threadId, "second", "assistant", "Next reply", 3),
    4,
  );
  await expect
    .element(screen.getByRole("button", { name: "Jump to latest (2 new)" }))
    .toBeVisible();
});

it("a reply after a member snapshot's history is new", async () => {
  const threadId = ThreadId.make("member-history");
  const history = [
    turnItem(threadId, "history-reply", "assistant", "Old reply", 1),
    turnItem(
      threadId,
      "history-user",
      "user",
      Array.from({ length: 80 }, (_, i) => `History ${i}`).join("\n"),
      2,
    ),
  ];
  const threadRef = setup(threadId, history);
  await using screen = await render(
    <AppAtomRegistryProvider>
      <MemberChat threadRef={threadRef} />
    </AppAtomRegistryProvider>,
  );
  const { socket, details } = await synchronized(threadRef);
  expect(appAtomRegistry.get(details.visibleTurnItemsAtom(threadRef))).toHaveLength(2);
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  expect(screen.container.textContent).toContain("Old reply");
  expect(screen.container.textContent).not.toContain("Jump to latest");
  const answer = turnItem(threadRef.threadId, "after-history", "assistant", "New reply", 3);
  await deliver(socket, details, threadRef, answer, 2);
  expect(screen.container.textContent).toContain("Jump to latest");
});

it("guard: snapshot history alone does not create a new-reply cue", async () => {
  const threadId = ThreadId.make("member-history-guard");
  const history = [
    turnItem(threadId, "guard-reply", "assistant", "Old reply", 1),
    turnItem(
      threadId,
      "guard-user",
      "user",
      Array.from({ length: 80 }, (_, i) => `History ${i}`).join("\n"),
      2,
    ),
  ];
  const threadRef = setup(threadId, history);
  await using screen = await render(
    <AppAtomRegistryProvider>
      <MemberChat threadRef={threadRef} />
    </AppAtomRegistryProvider>,
  );
  const { details } = await synchronized(threadRef);
  expect(appAtomRegistry.get(details.visibleTurnItemsAtom(threadRef))).toHaveLength(2);
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  expect(screen.container.textContent).toContain("Old reply");
  expect(screen.container.textContent).not.toContain("Jump to latest");
});
