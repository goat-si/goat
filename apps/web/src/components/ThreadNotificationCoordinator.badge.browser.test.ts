import type { AnyRouter } from "@tanstack/react-router";
import { EnvironmentId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  foldBuilds: 0,
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
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
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast as never } };
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
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
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

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

let registry: AtomRegistry.AtomRegistry;
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);
state.shells = { set: (id, value) => registry.set(shellAtom(id), value) };

class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  close = vi.fn();
  get tag() {
    return this.options.tag ?? "";
  }
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}

const thread = {
  id: "thread",
  title: "Test thread",
  archivedAt: null as string | null,
  snoozedUntil: null as string | null,
  subagentOf: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingRequestId: "request-1",
  session: null as { status: string } | null,
  completionNotification: undefined as string | undefined,
  launchedBy: undefined as
    | undefined
    | {
        kind: "launch";
        via: "delegate_task";
        threadId: string;
        environmentId: string;
        environmentLabel: null;
        threadTitle: null;
      },
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
};
let focused = false;
let visibility = "visible";

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T07:00:00.000Z");

function toV2ThreadShell(input: typeof thread) {
  const latestTurn = input.latestTurn;
  return {
    id: input.id,
    projectId: "project",
    title: input.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: input.subagentOf ?? input.id,
      parentThreadId: input.subagentOf,
      relationshipToParent: input.subagentOf === null ? null : "subagent",
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: input.subagentOf === null ? "web" : "mcp",
    launchedBy: input.launchedBy,
    latestRunId: latestTurn.turnId,
    activeRunId: null,
    status:
      latestTurn.state === "completed"
        ? "completed"
        : latestTurn.state === "error" || input.session?.status === "error"
          ? "failed"
          : "running",
    pendingRuntimeRequest: input.hasPendingUserInput
      ? { id: input.pendingRequestId, kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: input.pendingRequestId, kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletionNotification: input.completionNotification,
    notificationCompletedAt: null,
    latestRunCompletedAt: latestTurn.completedAt
      ? DateTime.makeUnsafe(latestTurn.completedAt)
      : undefined,
    archivedAt: input.archivedAt ? DateTime.makeUnsafe(input.archivedAt) : null,
    snoozedUntil: input.snoozedUntil ? DateTime.makeUnsafe(input.snoozedUntil) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

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
  const router = {
    state: { matches: [{ params: {} }] },
    navigate: state.navigate,
  } as unknown as AnyRouter;
  return {
    start: () => {
      stack.defer(startThreadNotifications(testRegistry, router));
    },
    setEnvironmentIds: (ids: ReadonlyArray<string>) => testRegistry.set(environmentIdsAtom, ids),
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
  "notifies when a new %s request replaces the pending request",
  async (flag) => {
    await using app = setup();
    app.start();
    state.shells.set("one", shell({ [flag]: true, pendingRequestId: "request-1" }));
    state.shells.set("one", shell({ [flag]: true, pendingRequestId: "request-2" }));
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
