import type { AnyRouter } from "@tanstack/react-router";
import { createElement, useEffect } from "react";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";
import {
  stubAttentionStorage,
  TestNotification,
  thread,
  toV2ThreadShell,
} from "./threadNotificationTestShell";

const state = vi.hoisted(() => ({
  feed: vi.fn(),
  task: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
}));

vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, decisionFeed: decisions as never },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationAtom: ((id: string) => presentationAtom(id)) as never,
    },
    environmentSummaries: {
      ...actual.environmentSummaries,
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: (() => () => {}) as never,
  getClientSettings: (() => ({
    notificationMode: "notifications",
    inAppNotificationsEnabled: false,
  })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: state.badge,
}));
vi.mock(import("../state/channels"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    channelEnvironment: {
      ...actual.channelEnvironment,
      listBotAttention: {
        ...actual.channelEnvironment.listBotAttention,
        permissionAtom: () => allowed,
        run: state.feed as never,
      },
      readAttentionTask: {
        ...actual.channelEnvironment.readAttentionTask,
        run: state.task as never,
      },
      taskChanges: (() => revisions) as never,
    },
  };
});

import { startGoatBotAttentionNotifications } from "./goatBot/GoatBotAttentionNotifier";
import { startThreadNotifications } from "./ThreadNotificationCoordinator";

const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const decisionAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
function decisions(id: string) {
  return decisionAtom(id);
}
const supportedIds = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive);
const connectionPhase = Atom.family((_id: string) =>
  Atom.make<string>("connected").pipe(Atom.keepAlive),
);
const allowed = Atom.make(true).pipe(Atom.keepAlive);
const revisions = Atom.make(AsyncResult.success({ value: 0 })).pipe(Atom.keepAlive);
const presentationAtom = Atom.family((id: string) =>
  Atom.make((get) => ({
    connection: { phase: get(connectionPhase(id)) },
    serverConfig: {
      environment: {
        capabilities: get(supportedIds).has(id) ? { goatBotAttention: true } : {},
      },
    },
  })),
);
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);

function shell(overrides: Partial<typeof thread> = {}, ...others: Partial<typeof thread>[]) {
  return {
    status: "live",
    snapshot: Option.some({
      threads: [overrides, ...others].map((override) =>
        toV2ThreadShell({ ...thread, ...override }),
      ),
    }),
  };
}

function setup() {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  registry.set(supportedIds, new Set<string>());
  registry.set(connectionPhase("one"), "connected");
  registry.set(connectionPhase("two"), "connected");
  registry.set(connectionPhase("three"), "connected");
  registry.set(environmentIdsAtom, ["one", "two"]);
  registry.set(shellAtom("one"), shell());
  registry.set(shellAtom("two"), shell());
  registry.set(shellAtom("three"), shell());
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  stack.use(stubGlobal("Notification", TestNotification));
  stack.use(vi.spyOn(window, "focus").mockImplementation(() => undefined));
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => false));
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => "visible" as DocumentVisibilityState),
  );
  const router = {
    state: { matches: [{ params: {} }], location: { pathname: "/", search: {} } },
    navigate: state.navigate,
    subscribe: () => () => {},
  } as unknown as AnyRouter;

  return {
    registry,
    router,
    startThreads: () => {
      const stop = startThreadNotifications(registry, router);
      stack.defer(stop);
      return stop;
    },
    setShell: (id: string, value: unknown) => registry.set(shellAtom(id), value),
    setEnvironmentIds: (ids: ReadonlyArray<string>) => registry.set(environmentIdsAtom, ids),
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

function MountedCoordinators({ app }: { readonly app: ReturnType<typeof setup> }) {
  useEffect(() => {
    const stopThreads = startThreadNotifications(app.registry, app.router);
    const stopAttention = startGoatBotAttentionNotifications(app.registry, app.router);
    return () => {
      stopAttention();
      stopThreads();
    };
  }, [app]);
  return null;
}

it("skips disconnected bot origins and caches worker ownership across repeated notifications", async () => {
  await using app = setup();
  app.setEnvironmentIds(["one", "two", "three"]);
  app.registry.set(supportedIds, new Set(["one", "three"]));
  app.registry.set(connectionPhase("one"), "connected");
  app.registry.set(connectionPhase("two"), "connected");
  app.registry.set(connectionPhase("three"), "offline");
  const worker = {
    id: "mcp:worker-cached",
    title: "Remote MCP task",
    creationSource: "mcp" as const,
  };
  app.setShell("two", shell(worker));
  state.feed.mockResolvedValue(
    AsyncResult.success({
      cursor: 0,
      hasMore: false,
      mode: "needs_you",
      events: [],
      ownsWorker: false,
    }),
  );
  app.startThreads();

  // First notification queries only the connected bot origin ("one"), never offline "three".
  app.setShell("two", shell({ ...worker, hasPendingUserInput: true, pendingRequestId: "req-1" }));
  await vi.waitFor(() => expect(TestNotification.sent).toHaveLength(1));
  expect(state.feed).toHaveBeenCalledTimes(1);
  expect(state.feed).toHaveBeenCalledWith(app.registry, {
    environmentId: "one",
    input: { worker: { environmentId: "two", threadId: "mcp:worker-cached" } },
  });

  // Second notification on the same MCP thread reuses the cached ownership lookup.
  app.setShell("two", shell({ ...worker, hasPendingUserInput: true, pendingRequestId: "req-2" }));
  await vi.waitFor(() => expect(TestNotification.sent).toHaveLength(2));
  expect(state.feed).toHaveBeenCalledTimes(1);
});

it("does not start GoatBotAttentionNotifier polling on disconnected environments", async () => {
  await using app = setup();
  using _storage = stubAttentionStorage();
  app.registry.set(supportedIds, new Set(["one"]));
  app.registry.set(connectionPhase("one"), "offline");
  state.feed.mockResolvedValue(
    AsyncResult.success({ cursor: 1, hasMore: false, mode: "needs_you", events: [] }),
  );

  // Router off: coordinator mounts subscriptions against the injected test router.
  await using _screen = await render(createElement(MountedCoordinators, { app }), {
    router: false,
  });
  app.registry.set(revisions, AsyncResult.success({ value: 1 }));
  expect(state.feed).not.toHaveBeenCalled();

  // Connecting the environment starts the watcher and drains the feed.
  app.registry.set(connectionPhase("one"), "connected");
  await vi.waitFor(() => expect(state.feed).toHaveBeenCalledTimes(1));
});

it("invalidates cached bot ownership when taskChanges advances (negative->positive and positive->negative)", async () => {
  await using app = setup();
  app.setEnvironmentIds(["one", "two"]);
  app.registry.set(supportedIds, new Set(["one"]));
  app.registry.set(connectionPhase("one"), "connected");
  app.registry.set(connectionPhase("two"), "connected");
  app.registry.set(revisions, AsyncResult.success({ value: 0 }));

  const worker = {
    id: "mcp:worker-mutable",
    title: "Mutable remote MCP task",
    creationSource: "mcp" as const,
  };
  let ownsWorker = false;
  state.feed.mockImplementation(async () =>
    AsyncResult.success({
      cursor: 0,
      hasMore: false,
      mode: "needs_you",
      events: [],
      ownsWorker,
    }),
  );
  app.setShell("two", shell(worker));
  app.startThreads();

  // 1. Negative lookup before binding is saved -> delivers thread alert and caches false.
  app.setShell("two", shell({ ...worker, hasPendingUserInput: true, pendingRequestId: "req-1" }));
  await vi.waitFor(() => expect(TestNotification.sent).toHaveLength(1));
  expect(state.feed).toHaveBeenCalledTimes(1);

  // 2. Worker binding is saved on origin "one" -> taskChanges revision advances -> cache invalidates.
  ownsWorker = true;
  app.registry.set(revisions, AsyncResult.success({ value: 1 }));
  app.setShell("two", shell({ ...worker, hasPendingUserInput: true, pendingRequestId: "req-2" }));
  await vi.waitFor(() => expect(state.feed).toHaveBeenCalledTimes(2));
  expect(TestNotification.sent).toHaveLength(1);

  // 3. Binding is later cleared -> taskChanges revision advances -> positive cache invalidates.
  ownsWorker = false;
  app.registry.set(revisions, AsyncResult.success({ value: 2 }));
  app.setShell("two", shell({ ...worker, hasPendingUserInput: true, pendingRequestId: "req-3" }));
  await vi.waitFor(() => expect(TestNotification.sent).toHaveLength(2));
  expect(state.feed).toHaveBeenCalledTimes(3);
});

it("does not cache a stale lookup answer when taskChanges advances while the RPC is in flight", async () => {
  await using app = setup();
  app.setEnvironmentIds(["one", "two"]);
  app.registry.set(supportedIds, new Set(["one"]));
  app.registry.set(connectionPhase("one"), "connected");
  app.registry.set(connectionPhase("two"), "connected");
  app.registry.set(revisions, AsyncResult.success({ value: 0 }));

  const worker = {
    id: "mcp:worker-inflight-race",
    title: "In-flight race worker",
    creationSource: "mcp" as const,
  };
  let resolveFirst: ((value: unknown) => void) | undefined;
  state.feed
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValue(
      AsyncResult.success({
        cursor: 0,
        hasMore: false,
        mode: "needs_you",
        events: [],
        ownsWorker: true,
      }),
    );

  app.setShell("two", shell(worker));
  app.startThreads();

  // Start lookup while taskChanges revision is 0.
  app.setShell("two", shell({ ...worker, hasPendingUserInput: true, pendingRequestId: "req-1" }));
  await vi.waitFor(() => expect(state.feed).toHaveBeenCalledTimes(1));

  // Ownership changes while the first lookup is still pending.
  app.registry.set(revisions, AsyncResult.success({ value: 1 }));
  resolveFirst?.(
    AsyncResult.success({
      cursor: 0,
      hasMore: false,
      mode: "needs_you",
      events: [],
      ownsWorker: false,
    }),
  );
  await vi.waitFor(() => expect(TestNotification.sent).toHaveLength(1));

  // Because taskChanges advanced in flight, the stale false answer must not be cached under revision 1.
  app.setShell("two", shell({ ...worker, hasPendingUserInput: true, pendingRequestId: "req-2" }));
  await vi.waitFor(() => expect(state.feed).toHaveBeenCalledTimes(2));
  expect(TestNotification.sent).toHaveLength(1);
});

it("does not cache or recreate taskChanges subscriptions when origin is removed while lookup is in flight", async () => {
  await using app = setup();
  app.setEnvironmentIds(["one", "two"]);
  app.registry.set(supportedIds, new Set(["one"]));
  app.registry.set(connectionPhase("one"), "connected");
  app.registry.set(connectionPhase("two"), "connected");
  app.registry.set(revisions, AsyncResult.success({ value: 0 }));

  const subscribeSpy = vi.spyOn(app.registry, "subscribe");
  const worker = {
    id: "mcp:worker-removed-origin",
    title: "Removed origin worker",
    creationSource: "mcp" as const,
  };

  let resolveRemoved: ((value: unknown) => void) | undefined;
  state.feed.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRemoved = resolve;
      }),
  );
  app.setShell("two", shell(worker));
  app.startThreads();
  subscribeSpy.mockClear();

  app.setShell("two", shell({ ...worker, hasPendingUserInput: true, pendingRequestId: "req-1" }));
  await vi.waitFor(() => expect(state.feed).toHaveBeenCalledTimes(1));

  app.setEnvironmentIds(["two"]);
  resolveRemoved?.(
    AsyncResult.success({
      cursor: 0,
      hasMore: false,
      mode: "needs_you",
      events: [],
      ownsWorker: false,
    }),
  );
  // Wait for ownedByBot and its .then() handler to finish delivering the notification.
  await vi.waitFor(() => expect(TestNotification.sent).toHaveLength(1));
  expect(subscribeSpy.mock.calls.filter(([atom]) => atom === revisions)).toHaveLength(0);
});

it("does not recreate taskChanges subscriptions when coordinator is disposed while lookup is in flight", async () => {
  await using app = setup();
  app.setEnvironmentIds(["one", "two"]);
  app.registry.set(supportedIds, new Set(["one"]));
  app.registry.set(connectionPhase("one"), "connected");
  app.registry.set(connectionPhase("two"), "connected");
  app.registry.set(revisions, AsyncResult.success({ value: 0 }));

  const subscribeSpy = vi.spyOn(app.registry, "subscribe");
  const worker = {
    id: "mcp:worker-disposed-coord",
    title: "Disposed coordinator worker",
    creationSource: "mcp" as const,
  };

  let resolveDisposed: ((value: unknown) => void) | undefined;
  const pending = new Promise((resolve) => {
    resolveDisposed = resolve;
  });
  state.feed.mockImplementationOnce(() => pending);
  app.setShell("two", shell(worker));
  const stop = app.startThreads();
  subscribeSpy.mockClear();

  app.setShell("two", shell({ ...worker, hasPendingUserInput: true, pendingRequestId: "req-1" }));
  await vi.waitFor(() => expect(state.feed).toHaveBeenCalledTimes(1));

  stop();
  resolveDisposed?.(
    AsyncResult.success({
      cursor: 0,
      hasMore: false,
      mode: "needs_you",
      events: [],
      ownsWorker: false,
    }),
  );
  await pending;
  // Drain microtasks for runAtomCommand + Promise.all + ownedByBot continuation.
  for (let tick = 0; tick < 6; tick++) await Promise.resolve();
  expect(subscribeSpy.mock.calls.filter(([atom]) => atom === revisions)).toHaveLength(0);
  expect(TestNotification.sent).toHaveLength(0);
});
