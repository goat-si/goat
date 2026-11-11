import { type OrchestrationV2ThreadShell, RuntimeRequestId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createApprovalNotificationGate,
  feedOwnedApprovalThreads,
  createThreadNotificationGate,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";

const working: ThreadNotificationObservation = {
  attention: null,
  settled: false,
  completedAt: null,
};
const completed = (at: number): ThreadNotificationObservation => ({
  attention: null,
  settled: true,
  completedAt: at,
});
const visible = { archived: false, quiet: false };

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
    const attention = { attention: "run-1:approval", settled: false, completedAt: null };
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
    observe({ attention: "run-1:limited", settled: false, completedAt: null });
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
});

describe("approval notifications", () => {
  it("notifies every new approval once, including two at once and a second in the same run", () => {
    const notify = vi.fn();
    const gate = createApprovalNotificationGate<string>(notify);
    gate.observe(["open-before"]);
    expect(notify).not.toHaveBeenCalled();
    gate.observe(["open-before", "first", "second"]);
    expect(notify.mock.calls).toEqual([["first"], ["second"]]);
    gate.observe(["open-before", "first", "second", "third"]);
    expect(notify.mock.calls.at(-1)).toEqual(["third"]);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("never notifies again for an approval that left and came back, or across a feed outage", () => {
    const notify = vi.fn();
    const gate = createApprovalNotificationGate<string>(notify);
    gate.observe([]);
    gate.observe(["one"]);
    gate.observe([]);
    gate.observe(["one"]);
    expect(notify.mock.calls).toEqual([["one"]]);
    // Created while the feed was away: the first list after it returns still announces it.
    gate.observe(["one", "two"]);
    expect(notify.mock.calls).toEqual([["one"], ["two"]]);
  });
});

describe("which approvals the decision feed announces", () => {
  const shell = (
    id: string,
    request: OrchestrationV2ThreadShell["pendingRuntimeRequest"],
    parent: string | null = null,
  ) =>
    ({
      id: ThreadId.make(id),
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
});
