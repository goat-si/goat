import type { AnyRouter } from "@tanstack/react-router";
import type { ChannelAttentionFeedResult } from "@goat/contracts/channel-bot-attention";
import { createElement, useEffect } from "react";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, render, stubGlobal } from "../../test/render";
import {
  attentionEnvironment,
  attentionEvent,
  cursorKey,
  stubAttentionStorage,
  TestNotification,
  thread,
  toV2ThreadShell,
} from "./threadNotificationTestShell";
import { RELEASED_COMPLETION_GRACE_MS } from "./ThreadNotificationCoordinator.logic";

const state = vi.hoisted(() => ({
  foldBuilds: 0,
  feed: vi.fn(),
  task: vi.fn(),
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
  closeToast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  settingsListeners: new Set<() => void>(),
}));
vi.mock(import("@goat/client-runtime/state/launch-fold"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    foldLaunchedThreads: ((...args: Parameters<typeof actual.foldLaunchedThreads>) => {
      state.foldBuilds++;
      return actual.foldLaunchedThreads(...args);
    }) as typeof actual.foldLaunchedThreads,
  };
});
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: state.toast as never,
      close: state.closeToast as never,
    },
  };
});
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
      // Read lazily: the factory runs before this module's own bindings exist.
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
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

let registry: AtomRegistry.AtomRegistry;
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
function decisions(id: string) {
  return decisionAtom(id);
}
const decisionAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const supported = Atom.make(false);
const allowed = Atom.make(true);
const revisions = Atom.make(AsyncResult.success({ value: 0 }));
const presentationAtom = Atom.family((id: string) =>
  Atom.make((get) => ({
    serverConfig: {
      environment: {
        capabilities: id === "one" && get(supported) ? { goatBotAttention: true } : {},
      },
    },
  })),
);
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);
state.shells = { set: (id, value) => registry.set(shellAtom(id), value) };

let focused = false;
let visibility = "visible";

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
// The mocked modules read `state` and the focus flags, so every test resets them before
// starting the service.
function setup() {
  vi.clearAllMocks();
  state.foldBuilds = 0;
  const stack = new AsyncDisposableStack();
  registry = AtomRegistry.make();
  const testRegistry = registry;
  stack.defer(() => testRegistry.dispose());
  state.mode = "notifications";
  state.inApp = false;
  state.settingsListeners.clear();
  registry.set(environmentIdsAtom, ["one", "two"]);
  state.shells.set("one", shell());
  state.shells.set("two", shell());
  focused = false;
  visibility = "visible";
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  stack.use(stubGlobal("Notification", TestNotification));
  stack.use(vi.spyOn(window, "focus").mockImplementation(() => undefined));
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => focused));
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility as DocumentVisibilityState),
  );
  const routeListeners = new Set<() => void>();
  const route = { params: {} as Record<string, string> };
  const router = {
    state: { matches: [route], location: { pathname: "/", search: {} } },
    navigate: state.navigate,
    subscribe: (_event: string, listener: () => void) => {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
  } as unknown as AnyRouter;
  return {
    registry: testRegistry,
    router,
    start: () => {
      stack.defer(startThreadNotifications(testRegistry, router));
    },
    setEnvironmentIds: (ids: ReadonlyArray<string>) => testRegistry.set(environmentIdsAtom, ids),
    openThread: (environmentId: string, threadId: string) => {
      route.params = { environmentId, threadId };
      for (const listener of routeListeners) listener();
    },
    changeSettings: () => {
      for (const listener of state.settingsListeners) listener();
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "badges %s and clears when notifications are disabled",
  async (flag) => {
    await using app = setup();
    app.start();
    state.shells.set("one", shell({ [flag]: true }));
    expect(state.badge).toHaveBeenLastCalledWith(1);
    const notification = TestNotification.sent[0]!;
    notification.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make("one"), threadId: "thread" },
    });
    state.mode = "sound";
    app.changeSettings();
    expect(state.badge).toHaveBeenLastCalledWith(0);
    expect(notification.close).toHaveBeenCalled();
  },
);

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "notifies once per %s request as queued runs start behind it",
  async (flag) => {
    await using app = setup();
    app.start();
    const waiting = (turnId: string, pendingRequestId: string) =>
      shell({
        [flag]: true,
        pendingRequestId,
        latestTurn: { turnId, state: "running", completedAt: null },
      });
    state.shells.set("one", waiting("turn-1", "request-1"));
    state.shells.set("one", waiting("turn-2", "request-1"));
    state.shells.set("one", waiting("turn-2", "request-2"));
    const title = flag === "hasPendingApprovals" ? "Approval needed" : "Input needed";
    expect(TestNotification.sent.map((sent) => sent.title)).toEqual([title, title]);
  },
);

it("never notifies for a GOAT Bot session thread, whose replies reach the person in the bot", async () => {
  await using app = setup();
  app.start();
  const session = { id: "goat-bot-session:abc", title: "GOAT Bot" };
  const ordinary = {};
  state.shells.set("one", shell(session, ordinary));
  state.shells.set("one", shell({ ...session, hasPendingApprovals: true }, ordinary));
  state.shells.set(
    "one",
    shell(
      { ...session, latestTurn: { turnId: "failed", state: "error", completedAt: null } },
      ordinary,
    ),
  );
  state.shells.set(
    "one",
    shell(
      {
        ...session,
        latestTurn: { turnId: "done", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
      },
      ordinary,
    ),
  );
  expect(TestNotification.sent).toEqual([]);
  expect(state.badge).not.toHaveBeenCalledWith(1);
  state.shells.set("one", shell(session, { hasPendingApprovals: true }));
  expect(TestNotification.sent.map((sent) => sent.title)).toHaveLength(1);
});

it("presents completion notifications and sound as soon as the shell completes", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  app.start();
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:00:01.000Z" },
    }),
  );
  expect(TestNotification.sent.map((sent) => sent.title)).toEqual(["Thread completed"]);
  expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
});

it("keeps silent completion quiet and alerts for the next meaningful completion and approval", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  state.inApp = true;
  app.start();
  state.shells.set(
    "one",
    shell({
      completionNotification: "silent",
      latestTurn: { turnId: "quiet", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.sound).not.toHaveBeenCalled();
  expect(state.badge).toHaveBeenLastCalledWith(0);
  state.shells.set(
    "one",
    shell({
      completionNotification: "notify",
      latestTurn: {
        turnId: "meaningful",
        state: "completed",
        completedAt: "2026-09-13T07:02:00.000Z",
      },
    }),
  );
  expect(TestNotification.sent).toHaveLength(1);
  expect(state.sound).toHaveBeenCalledExactlyOnceWith("completion", expect.any(Function));
  state.shells.set(
    "one",
    shell({
      completionNotification: "silent",
      hasPendingApprovals: true,
      latestTurn: {
        turnId: "approval",
        state: "completed",
        completedAt: "2026-09-13T07:03:00.000Z",
      },
    }),
  );
  expect(TestNotification.sent).toHaveLength(2);
  expect(state.sound).toHaveBeenCalledTimes(2);
  expect(state.sound).toHaveBeenLastCalledWith("input", expect.any(Function));
});

it("suppresses silent completion toasts while focused and toasts the next notifying completion", async () => {
  await using app = setup();
  focused = true;
  state.inApp = true;
  app.start();
  state.shells.set(
    "one",
    shell({
      completionNotification: "silent",
      latestTurn: { turnId: "quiet", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  expect(state.toast).not.toHaveBeenCalled();
  state.shells.set(
    "one",
    shell({
      completionNotification: "notify",
      latestTurn: {
        turnId: "meaningful",
        state: "completed",
        completedAt: "2026-09-13T07:02:00.000Z",
      },
    }),
  );
  expect(state.toast).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: "success",
      title: "Thread completed",
      description: "Test thread",
    }),
  );
});
it.each([false, true])(
  "presents one completion when a monitor ends with a final wake (disconnected: %s)",
  async (disconnect) => {
    await using app = setup();
    using _timers = fakeTimers();
    state.mode = "notifications-and-sound";
    app.start();
    const watching = (
      turnId: string,
      turnState: string,
      completedAt: string | null,
      latestRunBackgroundWake: boolean,
      pendingBackgroundTasks: ReadonlyArray<{ taskId: string; kind: "monitor" }>,
    ) => ({
      status: "live",
      snapshot: Option.some({
        threads: [
          {
            ...toV2ThreadShell({
              ...thread,
              latestTurn: { turnId, state: turnState, completedAt },
            }),
            latestRunBackgroundWake,
            pendingBackgroundTasks,
          },
        ],
      }),
    });
    const monitor = [{ taskId: "watch", kind: "monitor" as const }];
    const titles = () => TestNotification.sent.map(({ title }) => title);
    state.shells.set(
      "one",
      watching("turn", "completed", "2026-09-13T07:00:01.000Z", false, monitor),
    );
    expect(titles()).toEqual(["Thread completed"]);

    state.shells.set("one", watching("wake", "running", null, true, monitor));
    state.shells.set(
      "one",
      watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, monitor),
    );
    expect(titles()).toEqual(["Thread completed"]);

    // The adapter drains the roster before the final wake starts.
    state.shells.set("one", watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, []));
    expect(titles()).toEqual(["Thread completed"]);
    if (disconnect) {
      state.shells.set("one", {
        ...watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, []),
        status: "cached",
      });
      vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
      expect(titles()).toEqual(["Thread completed"]);
    }

    state.shells.set("one", watching("final", "running", null, false, []));
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    state.shells.set("one", watching("final", "completed", "2026-09-13T07:00:11.000Z", false, []));
    expect(titles()).toEqual(["Thread completed", "Thread completed"]);
    expect(state.sound).toHaveBeenCalledTimes(2);
  },
);

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "notifies for offline completion and %s once across reconnects",
  async (flag) => {
    await using app = setup();
    const asking = { id: "asking", hasPendingApprovals: true };
    const offline = { id: "offline", [flag]: true };
    const done = {
      id: "done",
      latestTurn: {
        turnId: "done-turn",
        state: "completed",
        completedAt: "2026-09-13T07:00:00.000Z",
      },
    };
    state.shells.set("one", shell({ id: "working" }, { id: "asking" }, { id: "offline" }, done));
    app.start();
    state.shells.set("one", shell({ id: "working" }, asking, { id: "offline" }, done));
    state.shells.set("one", {
      ...shell({ id: "working" }, asking, { id: "offline" }, done),
      status: "cached",
    });

    const completed = {
      id: "working",
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:05:00.000Z" },
    };
    state.shells.set("one", {
      ...shell(completed, asking, offline, done),
      status: "synchronizing",
    });
    state.shells.set("one", shell(completed, asking, offline, done));

    expect(TestNotification.sent.map(({ title }) => title)).toEqual([
      "Approval needed",
      "Thread completed",
      flag === "hasPendingApprovals" ? "Approval needed" : "Input needed",
    ]);
    state.shells.set("one", { ...shell(completed, asking, offline, done), status: "cached" });
    state.shells.set("one", shell(completed, asking, offline, done));
    expect(TestNotification.sent.map(({ title }) => title)).toEqual([
      "Approval needed",
      "Thread completed",
      flag === "hasPendingApprovals" ? "Approval needed" : "Input needed",
    ]);
  },
);

it.each([false, true])(
  "does not replay a notified completion after reconnect (continued: %s)",
  async (continued) => {
    await using app = setup();
    app.start();
    const completed = shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:05:00.000Z" },
    });
    state.shells.set("one", completed);
    state.shells.set("one", { ...completed, status: "cached" });
    expect(TestNotification.sent.map(({ title }) => title)).toEqual(["Thread completed"]);
    state.shells.set("one", continued ? shell() : completed);
    expect(TestNotification.sent.map(({ title }) => title)).toEqual(["Thread completed"]);
  },
);

it("suppresses a remote child's completion under a live parent but keeps its approval visible", async () => {
  await using app = setup();
  const child = {
    id: "child",
    title: "Child",
    launchedBy: {
      kind: "launch" as const,
      via: "delegate_task" as const,
      threadId: "thread",
      environmentId: "one",
      environmentLabel: null,
      threadTitle: null,
    },
  };
  state.shells.set("two", shell(child));
  app.start();
  using _timers = fakeTimers();
  state.shells.set(
    "two",
    shell({
      ...child,
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  expect(TestNotification.sent).toEqual([]);
  state.shells.set("two", shell({ ...child, hasPendingApprovals: true }));
  expect(TestNotification.sent.map(({ title, options }) => [title, options.body])).toEqual([
    ["Approval needed", "Test thread"],
  ]);
  TestNotification.sent[0]!.dispatchEvent(new Event("click"));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "one", threadId: "thread" },
  });
});

it("notifies for a remote child when the parent environment is offline", async () => {
  await using app = setup();
  const child = {
    id: "child",
    title: "Child",
    launchedBy: {
      kind: "launch" as const,
      via: "delegate_task" as const,
      threadId: "thread",
      environmentId: "one",
      environmentLabel: null,
      threadTitle: null,
    },
  };
  state.shells.set("one", { ...shell(), status: "cached" });
  state.shells.set("two", shell(child));
  app.start();
  using _timers = fakeTimers();
  state.shells.set(
    "two",
    shell({
      ...child,
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  expect(TestNotification.sent.map(({ title, options }) => [title, options.body])).toEqual([
    ["Thread completed", "Child"],
  ]);
});

it("reuses one launch fold for a burst of remote child completions", async () => {
  await using app = setup();
  const children = Array.from({ length: 12 }, (_, index) => ({
    id: `child-${index}`,
    launchedBy: {
      kind: "launch" as const,
      via: "delegate_task" as const,
      threadId: "thread",
      environmentId: "one",
      environmentLabel: null,
      threadTitle: null,
    },
  }));
  state.shells.set("two", shell(children[0]!, ...children.slice(1)));
  app.start();
  using _timers = fakeTimers();
  const completed = children.map((child) => ({
    ...child,
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
  }));
  state.shells.set("two", shell(completed[0]!, ...completed.slice(1)));
  expect(TestNotification.sent).toEqual([]);
  expect(state.foldBuilds).toBe(1);
});

it("refreshes the notification fold when the parent goes offline", async () => {
  await using app = setup();
  const child = {
    id: "child",
    title: "Remote child",
    launchedBy: {
      kind: "launch" as const,
      via: "delegate_task" as const,
      threadId: "thread",
      environmentId: "one",
      environmentLabel: null,
      threadTitle: null,
    },
  };
  state.shells.set("two", shell(child));
  app.start();
  state.shells.set("two", shell({ ...child, hasPendingApprovals: true }));
  expect(TestNotification.sent.map(({ options }) => options.body)).toEqual(["Test thread"]);
  state.shells.set("one", { ...shell(), status: "cached" });
  state.shells.set("two", shell(child));
  state.shells.set("two", shell({ ...child, hasPendingUserInput: true }));
  expect(TestNotification.sent.map(({ options }) => options.body)).toEqual([
    "Test thread",
    "Remote child",
  ]);
  expect(state.foldBuilds).toBe(2);
});

it("reuses the fold for separately timed completions across cursor-only snapshots", async () => {
  await using app = setup();
  const children = Array.from({ length: 12 }, (_, index) => ({
    id: `child-${index}`,
    launchedBy: {
      kind: "launch" as const,
      via: "delegate_task" as const,
      threadId: "thread",
      environmentId: "one",
      environmentLabel: null,
      threadTitle: null,
    },
  }));
  state.shells.set("two", shell(children[0]!, ...children.slice(1)));
  app.start();
  using _timers = fakeTimers();
  let latest = shell(children[0]!, ...children.slice(1));
  for (let index = 0; index < children.length; index++) {
    const rows = children.map((child, row) =>
      row <= index
        ? {
            ...child,
            latestTurn: {
              turnId: "turn",
              state: "completed",
              completedAt: "2026-09-13T07:01:00.000Z",
            },
          }
        : child,
    );
    latest = shell(rows[0]!, ...rows.slice(1));
    state.shells.set("two", latest);
    await vi.advanceTimersByTimeAsync(1);
  }
  const stableSnapshot = Option.getOrThrow(latest.snapshot);
  for (let index = 0; index < children.length; index++) {
    state.shells.set("two", {
      ...latest,
      snapshot: Option.some({ ...stableSnapshot, cursor: index }),
    });
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(TestNotification.sent).toEqual([]);
  expect(state.foldBuilds).toBe(1);
});

it("refreshes the notification parent when its thread rows change", async () => {
  await using app = setup();
  const child = {
    id: "child",
    launchedBy: {
      kind: "launch" as const,
      via: "delegate_task" as const,
      threadId: "thread",
      environmentId: "one",
      environmentLabel: null,
      threadTitle: null,
    },
  };
  state.shells.set("two", shell(child));
  app.start();
  state.shells.set("two", shell({ ...child, hasPendingApprovals: true }));
  state.shells.set("two", shell(child));
  state.shells.set("one", shell({ title: "Renamed parent" }));
  state.shells.set("two", shell({ ...child, hasPendingUserInput: true }));
  expect(TestNotification.sent.map(({ options }) => options.body)).toEqual([
    "Test thread",
    "Renamed parent",
  ]);
  expect(state.foldBuilds).toBe(2);
});

it("avoids rebuilding a fold for interleaved remote child completions", async () => {
  await using app = setup();
  const children = Array.from({ length: 12 }, (_, index) => ({
    id: `child-${index}`,
    launchedBy: {
      kind: "launch" as const,
      via: "delegate_task" as const,
      threadId: "thread",
      environmentId: "one",
      environmentLabel: null,
      threadTitle: null,
    },
  }));
  state.shells.set("two", shell(children[0]!, ...children.slice(1)));
  app.start();
  using _timers = fakeTimers();
  for (let index = 0; index < children.length; index++) {
    const rows = children.map((child, at) =>
      at <= index
        ? {
            ...child,
            latestTurn: {
              turnId: "turn",
              state: "completed",
              completedAt: "2026-09-13T07:01:00.000Z",
            },
          }
        : child,
    );
    state.shells.set("two", shell(rows[0]!, ...rows.slice(1)));
  }
  expect(TestNotification.sent).toEqual([]);
  expect(state.foldBuilds).toBeLessThanOrEqual(1);
});

it("directs a subagent approval to its remote child when the launcher is snoozed", async () => {
  await using app = setup();
  const child = {
    id: "child",
    title: "Remote child",
    launchedBy: {
      kind: "launch" as const,
      via: "delegate_task" as const,
      threadId: "thread",
      environmentId: "one",
      environmentLabel: null,
      threadTitle: null,
    },
  };
  const subagent = { id: "subagent", subagentOf: "child" };
  state.shells.set("one", shell({ snoozedUntil: "2099-01-01T00:00:00.000Z" }));
  state.shells.set("two", shell(child, subagent));
  app.start();
  state.shells.set("two", shell(child, { ...subagent, hasPendingApprovals: true }));
  expect(TestNotification.sent.map(({ title, options }) => [title, options.body])).toEqual([
    ["Approval needed", "Remote child"],
  ]);
  TestNotification.sent[0]!.dispatchEvent(new Event("click"));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "two", threadId: "child" },
  });
});

it("suppresses a completion that happened during snooze even if observed after expiry", async () => {
  await using app = setup();
  using _timers = fakeTimers();
  vi.setSystemTime(new Date("2026-09-14T07:00:00Z"));
  app.start();
  state.shells.set(
    "one",
    shell({
      snoozedUntil: "2026-09-13T08:00:00Z",
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:30:00Z" },
    }),
  );
  expect(TestNotification.sent).toHaveLength(0);
});

it("closes only removed environments' in-app toasts", async () => {
  await using app = setup();
  state.inApp = true;
  focused = true;
  state.toast.mockReturnValueOnce("one-completed").mockReturnValueOnce("two-completed");
  app.start();
  const completed = {
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00Z" },
  };
  state.shells.set("one", shell(completed));
  state.shells.set("two", shell(completed));
  expect(state.toast).toHaveBeenCalledTimes(2);
  app.setEnvironmentIds(["one"]);
  expect(state.closeToast.mock.calls).toEqual([["two-completed"]]);
});

it("opening a thread closes only its in-app toasts, and disabling notifications closes the rest", async () => {
  await using app = setup();
  state.inApp = true;
  focused = true;
  state.toast
    .mockReturnValueOnce("one-completed")
    .mockReturnValueOnce("one-approval")
    .mockReturnValueOnce("one-other")
    .mockReturnValueOnce("two-completed");
  state.shells.set("one", shell({}, { id: "other" }));
  app.start();
  const completed = {
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00Z" },
  };
  state.shells.set("one", shell(completed, { id: "other" }));
  state.shells.set("one", shell({ ...completed, hasPendingApprovals: true }, { id: "other" }));
  state.shells.set(
    "one",
    shell({ ...completed, hasPendingApprovals: true }, { ...completed, id: "other" }),
  );
  state.shells.set("two", shell(completed));
  expect(state.toast).toHaveBeenCalledTimes(4);

  app.openThread("one", "thread");
  expect(state.closeToast.mock.calls).toEqual([["one-completed"], ["one-approval"]]);

  state.mode = "off";
  state.inApp = false;
  app.changeSettings();
  expect(state.closeToast.mock.calls.slice(2).flat().toSorted()).toEqual([
    "one-other",
    "two-completed",
  ]);
});

function MountedCoordinators({
  app,
  legacyClient = false,
}: {
  readonly app: ReturnType<typeof setup>;
  readonly legacyClient?: boolean;
}) {
  useEffect(() => {
    const stopThreads = startThreadNotifications(app.registry, app.router);
    const stopAttention = legacyClient
      ? undefined
      : startGoatBotAttentionNotifications(app.registry, app.router);
    return () => {
      stopAttention?.();
      stopThreads();
    };
  }, [app, legacyClient]);
  return null;
}

it.each([
  ["handoff only", "needs_you", "one", "channel-worker:abc", ["Scout needs approval"]],
  ["handoff only", "off", "one", "channel-worker:abc", []],
  ["older SSH destination", "needs_you", "two", "mcp:worker", ["Scout has a question"]],
  ["older SSH destination", "off", "two", "mcp:worker", []],
] as const)(
  "%s routes only through bot alerts in %s mode",
  async (scenario, mode, destination, id, titles) => {
    await using app = setup();
    using _storage = stubAttentionStorage();
    app.registry.set(supported, true);
    const worker = { id, title: "Private task", creationSource: "mcp" as const };
    state.shells.set(destination, shell(worker));
    app.registry.set(decisionAtom(destination), { handoffs: [] });
    const handoff = scenario === "handoff only";
    state.feed.mockResolvedValue(
      AsyncResult.success({ cursor: 0, hasMore: false, mode, events: [] }),
    );

    // Both coordinators use the supplied registry and router.
    await using screen = await render(createElement(MountedCoordinators, { app }), {
      router: false,
    });
    await vi.waitFor(() => expect(state.feed).toHaveBeenCalled());
    state.feed.mockImplementation(async (_registry, target) =>
      AsyncResult.success(
        target.input.worker === undefined
          ? {
              cursor: 1,
              hasMore: false,
              mode,
              events: [
                handoff
                  ? { ...attentionEvent, kind: "approval", requestId: "approval" }
                  : attentionEvent,
              ],
            }
          : {
              cursor: 0,
              hasMore: false,
              mode,
              events: [],
              ownsWorker:
                target.environmentId === "one" &&
                target.input.worker.environmentId === destination &&
                target.input.worker.threadId === id,
            },
      ),
    );
    if (handoff) {
      app.registry.set(decisionAtom(destination), {
        handoffs: [
          {
            handoff: {
              handoffId: "approval",
              requestedBy: { threadId: id },
              title: "Private approval",
              createdAt: DateTime.makeUnsafe("2026-11-21T00:00:00Z"),
            },
            threadTitle: worker.title,
            botAttentionOwned: true,
          },
        ],
      });
    } else {
      app.registry.set(revisions, AsyncResult.success({ value: 1 }));
      state.shells.set(destination, shell({ ...worker, hasPendingUserInput: true }));
      await vi.waitFor(() =>
        expect(state.feed).toHaveBeenCalledWith(app.registry, {
          environmentId: "one",
          input: { worker: { environmentId: "two", threadId: id } },
        }),
      );
    }
    await vi.waitFor(() => expect(localStorage.getItem(cursorKey)).toBe("1"));
    expect(TestNotification.sent.map(({ title, options }) => [title, options.body])).toEqual(
      titles.map((title) => [title, undefined]),
    );
    expect(screen.container.textContent).toBe("");
  },
);

it.each([false, true])("opens the freshly read Slack request (answered: %s)", async (answered) => {
  await using app = setup();
  using _storage = stubAttentionStorage();
  app.registry.set(supported, true);
  state.feed.mockResolvedValue(
    AsyncResult.success({
      cursor: 1,
      hasMore: false,
      mode: "needs_you",
      events: [attentionEvent],
    } satisfies ChannelAttentionFeedResult),
  );
  state.task.mockResolvedValue(
    AsyncResult.success({
      generation: 1,
      originAddress: { kind: "slack" },
      openQuestions: answered ? [] : [{ questionId: "ask", text: "Pick one" }],
      answeredQuestions: answered ? [{ questionId: "ask", answerText: "Option A" }] : [],
    }),
  );

  // The production notification handlers use the supplied app router.
  await using screen = await render(createElement(MountedCoordinators, { app }), { router: false });
  await vi.waitFor(() => expect(TestNotification.sent).toHaveLength(1));
  TestNotification.sent[0]!.dispatchEvent(new Event("click"));
  await vi.waitFor(() => expect(state.navigate).toHaveBeenCalledOnce());
  expect(state.task).toHaveBeenCalledWith(app.registry, {
    environmentId: attentionEnvironment,
    input: { taskId: "task", botId: "main", attentionRequest: "ask" },
  });
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/bot",
    search: {
      task: "task",
      attentionEnvironment,
      attentionRequest: "ask",
      attentionDetail: "external",
    },
  });
  expect(screen.container.textContent).toBe("");
});

it.each([false, true])(
  "never calls the feed RPC across a mixed-version connection (older client: %s)",
  async (legacyClient) => {
    await using app = setup();
    using _storage = stubAttentionStorage();
    using warn = vi.spyOn(console, "warn");
    app.registry.set(supported, legacyClient);
    state.feed.mockImplementation(() => {
      throw new Error("unknown RPC");
    });

    // No UI route is needed to exercise either version's notification installation.
    await using screen = await render(createElement(MountedCoordinators, { app, legacyClient }), {
      router: false,
    });
    app.registry.set(revisions, AsyncResult.success({ value: 1 }));
    state.shells.set("one", shell({ hasPendingUserInput: true }));
    expect(TestNotification.sent.map(({ title }) => title)).toEqual(["Input needed"]);
    expect(state.feed).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(screen.container.textContent).toBe("");
  },
);
