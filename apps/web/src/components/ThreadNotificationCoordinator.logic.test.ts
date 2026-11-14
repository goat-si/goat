import { type OrchestrationV2ThreadShell, RuntimeRequestId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  approvalHandoffShownBy,
  createApprovalNotificationGate,
  feedOwnedApprovalThreads,
  notificationAttention,
  createThreadNotificationGate,
  RELEASED_COMPLETION_GRACE_MS,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";

const working: ThreadNotificationObservation = {
  attention: null,
  settled: false,
  completedAt: null,
  backgroundWake: false,
};
const completed = (at: number): ThreadNotificationObservation => ({
  attention: null,
  settled: true,
  completedAt: at,
  backgroundWake: false,
});
const waking: ThreadNotificationObservation = { ...working, backgroundWake: true };
const woke = (at: number): ThreadNotificationObservation => ({
  ...completed(at),
  backgroundWake: true,
});
const visible = { archived: false, quiet: false };

function fakeTimers(): Disposable {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}

function harness() {
  const notify = vi.fn();
  const gate = createThreadNotificationGate<string>(notify);
  let prior: ThreadNotificationObservation | undefined;
  const observe = (next: ThreadNotificationObservation, options = visible) => {
    gate.observe("thread", prior, next, options);
    prior = next;
  };
  return { gate, notify, observe };
}

describe("createThreadNotificationGate", () => {
  it("notifies each replacement request once while attention remains pending", () => {
    const { notify, observe } = harness();
    observe(working);
    const request = (id: string) => ({
      attention: notificationAttention("input", "run-1", false, id),
      requestId: id,
      backgroundWake: false,
      settled: false,
      completedAt: null,
    });
    observe(request("a"));
    observe(request("b"));
    observe(request("a"));
    expect(notify).toHaveBeenCalledTimes(2);
    observe(working);
    observe(request("a"));
    expect(notify).toHaveBeenCalledTimes(3);
  });
  it("notifies a completion immediately and only once", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...completed(1) });
    observe(working);
    observe(completed(1));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies each newer completion immediately", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    observe(working);
    observe(completed(2));
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "completion"],
    ]);
    observe(completed(1));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("notifies attention once and still notifies the subsequent completion", () => {
    const { notify, observe } = harness();
    observe(working);
    const attention = { ...working, attention: "run-1:approval:a", requestId: "a" };
    observe(attention);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
    observe({ ...attention });
    expect(notify).toHaveBeenCalledTimes(1);
    observe(working);
    observe(completed(1));
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "completion"],
    ]);
  });

  it("does not replay a completion after attention resolves", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    observe({ ...working, attention: "run-1:limited" });
    observe(completed(1));
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "input"],
    ]);
  });

  it("never notifies existing, archived or stopped completions, including when unarchived", () => {
    const { notify, observe } = harness();
    observe(completed(1));
    observe(working);
    observe(completed(2), { ...visible, quiet: true });
    observe(completed(2));
    observe(working);
    observe(completed(3), { ...visible, archived: true });
    observe(completed(3));
    expect(notify).not.toHaveBeenCalled();
    observe(working);
    observe(completed(4));
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("forgets handled completions when a thread is removed or the gate is cleared", () => {
    for (const reset of [
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.retain(new Set()),
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.clear(),
    ]) {
      const { gate, notify, observe } = harness();
      observe(completed(1));
      reset(gate);
      gate.observe("thread", undefined, working, visible);
      gate.observe("thread", working, completed(1), visible);
      expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    }
  });

  it("waits out the grace before notifying a wake's completion, and a final wake replaces it", () => {
    using _timers = fakeTimers();
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    // Held until the monitor left, or completing after it already had: either way unheld here.
    observe(waking);
    observe(woke(2));
    expect(notify).toHaveBeenCalledTimes(1);
    observe(working);
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    expect(notify).toHaveBeenCalledTimes(1);
    observe(completed(3));
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "completion"],
    ]);
  });

  it("notifies a wake's completion once after the grace when no run follows, even across a pause", () => {
    using _timers = fakeTimers();
    const { gate, notify, observe } = harness();
    observe(waking);
    observe(woke(1));
    gate.pause();
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    expect(notify).not.toHaveBeenCalled();
    observe({ ...woke(1) });
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS - 1);
    observe({ ...woke(1) });
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...woke(1) });
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("drops a pending wake completion when the thread is removed or the gate is cleared", () => {
    using _timers = fakeTimers();
    for (const reset of [
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.retain(new Set()),
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.clear(),
    ]) {
      const { gate, notify, observe } = harness();
      observe(waking);
      observe(woke(1));
      reset(gate);
      vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
      expect(notify).not.toHaveBeenCalled();
    }
  });
});

describe("approval notifications", () => {
  const open = (...ids: ReadonlyArray<readonly [string, number]>) =>
    ids.map(([id, createdAt]) => ({ id, createdAt }));

  it("announces approvals that opened after the first shell snapshot, unless the shell already did", () => {
    const notify = vi.fn();
    const gate = createApprovalNotificationGate<string>(notify);
    gate.setBaseline(10);
    gate.remember("announced-by-shell");
    gate.observe(
      open(["open-before-watching", 5], ["announced-by-shell", 11], ["opened-while-loading", 12]),
    );
    expect(notify.mock.calls).toEqual([["opened-while-loading"]]);
  });

  it("holds a feed that arrives before the first shell snapshot until that snapshot sets the baseline", () => {
    const notify = vi.fn();
    const gate = createApprovalNotificationGate<string>(notify);
    gate.observe(open(["open-before-watching", 5], ["opened-while-loading", 12]));
    expect(notify).not.toHaveBeenCalled();
    gate.setBaseline(10);
    expect(notify.mock.calls).toEqual([["opened-while-loading"]]);
  });

  it("notifies every new approval once, including two at once and a second in the same run", () => {
    const notify = vi.fn();
    const gate = createApprovalNotificationGate<string>(notify);
    gate.setBaseline(10);
    gate.observe(open(["open-before", 1]));
    expect(notify).not.toHaveBeenCalled();
    gate.observe(open(["open-before", 1], ["first", 20], ["second", 20]));
    expect(notify.mock.calls).toEqual([["first"], ["second"]]);
    gate.observe(open(["open-before", 1], ["first", 20], ["second", 20], ["third", 30]));
    expect(notify.mock.calls.at(-1)).toEqual(["third"]);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("never notifies again for an approval that left and came back, or across a feed outage", () => {
    const notify = vi.fn();
    const gate = createApprovalNotificationGate<string>(notify);
    gate.setBaseline(10);
    gate.observe([]);
    gate.observe(open(["one", 20]));
    gate.observe([]);
    gate.observe(open(["one", 20]));
    expect(notify.mock.calls).toEqual([["one"]]);
    // Created while the feed was away: the first list after it returns still announces it.
    gate.observe(open(["one", 20], ["two", 30]));
    expect(notify.mock.calls).toEqual([["one"], ["two"]]);
  });

  it("never announces a still open approval again, however many are open", () => {
    const notify = vi.fn();
    const gate = createApprovalNotificationGate<string>(notify);
    gate.setBaseline(0);
    gate.observe([]);
    const many = Array.from({ length: 1500 }, (_, index) => ({ id: `a${index}`, createdAt: 1 }));
    gate.observe(many);
    gate.observe([...many, { id: "new", createdAt: 2 }]);
    expect(notify).toHaveBeenCalledTimes(1501);
    expect(notify.mock.calls.at(-1)).toEqual(["new"]);
  });
});

describe("notification attention", () => {
  it("leaves an approval the feed announces to the feed, but still raises a failure or limit", () => {
    expect(notificationAttention("approval", "run", true)).toBeNull();
    expect(notificationAttention("approval", "run", false)).toBe("run:approval");
    expect(notificationAttention("failed", "run", true)).toBe("run:failed");
    expect(notificationAttention("limited", "run", true)).toBe("run:limited");
    expect(notificationAttention("ready", "run", false)).toBeNull();
  });
});

describe("which approvals the decision feed announces", () => {
  const shell = (
    id: string,
    request: OrchestrationV2ThreadShell["pendingRuntimeRequest"],
    parent: string | null = null,
    live = true,
  ) =>
    ({
      id: ThreadId.make(id),
      activityRunStatus: live ? "running" : null,
      lineage: {
        rootThreadId: ThreadId.make(parent ?? id),
        parentThreadId: parent === null ? null : ThreadId.make(parent),
        relationshipToParent: parent === null ? null : "subagent",
      },
      pendingRuntimeRequest: request,
    }) as OrchestrationV2ThreadShell;
  const createdAt = DateTime.makeUnsafe(0);
  const handoff = (id: string) => ({
    id: RuntimeRequestId.make(id),
    kind: "user_input" as const,
    createdAt,
    handoff: { kind: "approval" as const, title: "Join pen-lidge to the hub" },
  });
  const provider = (id: string) => ({
    id: RuntimeRequestId.make(id),
    kind: "command" as const,
    createdAt,
  });

  it("leaves every approval to the shell until the feed has listed approvals once", () => {
    expect(feedOwnedApprovalThreads([shell("t", handoff("a"))], false).size).toBe(0);
    expect([...feedOwnedApprovalThreads([shell("t", handoff("a"))], true)]).toEqual(["t"]);
  });

  it("owns a nested subagent's approval handoff for every ancestor that shows it", () => {
    const owned = feedOwnedApprovalThreads(
      [shell("root", null), shell("mid", null, "root"), shell("leaf", handoff("a"), "mid")],
      true,
    );
    expect([...owned].sort()).toEqual(["leaf", "mid", "root"]);
  });

  it("keeps the shell notification of a parent whose other child waits on a provider approval", () => {
    const owned = feedOwnedApprovalThreads(
      [
        shell("parent", null),
        shell("one", handoff("a"), "parent"),
        shell("two", provider("b"), "parent"),
      ],
      true,
    );
    expect([...owned]).toEqual(["one"]);
  });
  it("keeps the shell notification of a thread with its own handoff while a child waits on a provider approval", () => {
    const owned = feedOwnedApprovalThreads(
      [shell("parent", handoff("a")), shell("child", provider("b"), "parent")],
      true,
    );
    expect([...owned]).toEqual([]);
  });
  it("lets the feed announce a second subagent approval the parent's single notification did not", () => {
    const at = (id: string, ms: number) => ({ ...handoff(id), createdAt: DateTime.makeUnsafe(ms) });
    const threads = [
      shell("root", null),
      shell("one", at("one-a", 1), "root"),
      shell("two", at("two-a", 2), "root"),
    ];
    const notify = vi.fn();
    const gate = createApprovalNotificationGate<string>(notify);
    // The shell's one notification for root stands for one approval, the newest, and names it.
    const shown = approvalHandoffShownBy(threads, ThreadId.make("root"), "approval");
    expect(shown).toEqual({ id: "two-a", title: "Join pen-lidge to the hub" });
    if (shown) gate.remember(shown.id);
    gate.setBaseline(0);
    gate.observe([
      { id: "one-a", createdAt: 1 },
      { id: "two-a", createdAt: 2 },
    ]);
    expect(notify.mock.calls).toEqual([["one-a"]]);
  });

  it("stands for no handoff when the thread waits on its own provider approval", () => {
    const threads = [shell("root", provider("p")), shell("child", handoff("child-a"), "root")];
    expect(approvalHandoffShownBy(threads, ThreadId.make("root"), "approval")).toBeNull();
    expect(approvalHandoffShownBy(threads, ThreadId.make("child"), "approval")).toEqual({
      id: "child-a",
      title: "Join pen-lidge to the hub",
    });
  });
  it("claims no handoff for a notification about anything other than an approval", () => {
    const threads = [shell("root", null), shell("child", handoff("child-a"), "root")];
    expect(approvalHandoffShownBy(threads, ThreadId.make("root"), "failed")).toBeNull();
  });

  it("ignores a subagent whose run ended, as the parent's status does", () => {
    const threads = [shell("root", null), shell("child", handoff("child-a"), "root", false)];
    expect(approvalHandoffShownBy(threads, ThreadId.make("root"), "approval")).toBeNull();
    expect([...feedOwnedApprovalThreads(threads, true)]).toEqual(["child"]);
  });
  it("owns a parent that waits on a question while its child waits on an approval handoff", () => {
    const question = { id: RuntimeRequestId.make("q"), kind: "user_input" as const, createdAt };
    const owned = feedOwnedApprovalThreads(
      [shell("parent", question), shell("child", handoff("child-a"), "parent")],
      true,
    );
    expect([...owned].sort()).toEqual(["child", "parent"]);
  });
  it("names no handoff when a child's provider approval is what raised the parent", () => {
    const threads = [shell("parent", handoff("parent-a")), shell("child", provider("b"), "parent")];
    expect(approvalHandoffShownBy(threads, ThreadId.make("parent"), "approval")).toBeNull();
  });
});
