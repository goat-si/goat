import { describe, expect, it } from "vite-plus/test";

import { foldLaunchedThreads, launchAncestorKeys, summarizeLaunchGroup } from "./launchFold";
import { HOME, NOW, OTHER, ids, key, thread } from "./launchFold.fixtures";
import type { LaunchFoldThread } from "./launchFold";

function fold(visible: readonly LaunchFoldThread[], hidden: readonly LaunchFoldThread[] = []) {
  return foldLaunchedThreads({ visible, all: [...visible, ...hidden], now: NOW });
}

describe("foldLaunchedThreads", () => {
  it("folds threads another thread launched under that thread and keeps people's threads on top", () => {
    const result = fold([
      thread("coordinator"),
      thread("lane-1", { launchedBy: "coordinator" }),
      thread("lane-2", { launchedBy: "coordinator", via: "create_threads" }),
      thread("mine"),
    ]);
    expect(ids(result.roots)).toEqual(["coordinator", "mine"]);
    expect(ids(result.childrenByParentKey.get(key("coordinator")) ?? [])).toEqual([
      "lane-1",
      "lane-2",
    ]);
    expect(ids(result.folded)).toEqual(["lane-1", "lane-2"]);
  });

  it("leaves task.create children, promoted threads and subagents to their own models", () => {
    const result = fold([
      thread("coordinator"),
      thread("task", { launchedBy: "coordinator", via: "delegate_task" }),
      thread("promoted", { launchedBy: "coordinator", kind: "promotion" }),
      thread("subagent", { launchedBy: "coordinator", subagentOf: "coordinator" }),
    ]);
    expect(ids(result.roots)).toEqual(["coordinator", "task", "promoted", "subagent"]);
  });

  it("keeps a launched thread on top when its launcher has no row", () => {
    const result = fold(
      [thread("orphan", { launchedBy: "archived" }), thread("unknown", { launchedBy: "gone" })],
      [thread("archived")],
    );
    expect(ids(result.roots)).toEqual(["orphan", "unknown"]);
    expect(result.parentKeyByKey.size).toBe(0);
  });

  it("keeps a grandchild on top when its launcher is hidden, instead of reparenting it", () => {
    const result = fold(
      [thread("root"), thread("grandchild", { launchedBy: "middle" })],
      [thread("middle", { launchedBy: "root" })],
    );
    expect(ids(result.roots)).toEqual(["root", "grandchild"]);
  });

  it("folds a thread a subagent launched under the row that owns the subagent", () => {
    const result = fold(
      [thread("owner"), thread("lane", { launchedBy: "helper" })],
      [thread("helper", { subagentOf: "owner" })],
    );
    expect(ids(result.childrenByParentKey.get(key("owner")) ?? [])).toEqual(["lane"]);
  });

  it("nests a grandchild under its own visible launcher", () => {
    const result = fold([
      thread("root"),
      thread("child", { launchedBy: "root" }),
      thread("grandchild", { launchedBy: "child" }),
    ]);
    expect(ids(result.roots)).toEqual(["root"]);
    expect(ids(result.childrenByParentKey.get(key("child")) ?? [])).toEqual(["grandchild"]);
    expect(launchAncestorKeys(result, key("grandchild"))).toEqual([key("child"), key("root")]);
  });

  it("folds across machines only when the launcher's environment is loaded here", () => {
    const remote = thread("remote-lane", {
      environmentId: OTHER,
      launchedBy: "coordinator",
      launcherEnvironment: HOME,
      via: "ssh_thread_launch",
    });
    expect(ids(fold([thread("coordinator"), remote]).roots)).toEqual(["coordinator"]);
    expect(ids(fold([remote]).roots)).toEqual(["remote-lane"]);
  });

  it("keeps a pinned launched thread where the person put it", () => {
    const result = fold([thread("root"), thread("pinned", { launchedBy: "root", pinned: true })]);
    expect(ids(result.roots)).toEqual(["root", "pinned"]);
  });

  it("does not hide live work under a snoozed launcher", () => {
    const snoozedUntil = "2026-10-28T00:00:00.000Z";
    const result = fold([
      thread("root", { snoozedUntil }),
      thread("running", { launchedBy: "root", status: "running" }),
      thread("done", { launchedBy: "root" }),
    ]);
    expect(ids(result.roots)).toEqual(["root", "running"]);
    expect(ids(result.childrenByParentKey.get(key("root")) ?? [])).toEqual(["done"]);
  });

  it("keeps unsettled finished work out of a settled launcher's closed shelf, but folds live work", () => {
    const result = fold([
      thread("root", { settled: true }),
      thread("running", { launchedBy: "root", status: "running" }),
      thread("done-unsettled", { launchedBy: "root" }),
      thread("done-settled", { launchedBy: "root", settled: true }),
    ]);
    expect(ids(result.roots)).toEqual(["root", "done-unsettled"]);
    expect(ids(result.childrenByParentKey.get(key("root")) ?? [])).toEqual([
      "running",
      "done-settled",
    ]);
    expect(result.liftByKey.get(key("root"))).toBe("working");
  });

  it("keeps every thread on a launch loop at the top level", () => {
    const result = fold([
      thread("a", { launchedBy: "b" }),
      thread("b", { launchedBy: "a" }),
      thread("c", { launchedBy: "a" }),
    ]);
    expect(ids(result.roots)).toEqual(["a", "b"]);
    expect(ids(result.childrenByParentKey.get(key("a")) ?? [])).toEqual(["c"]);
  });

  it("orders children by who needs a person, then running work, then finished, in launch order", () => {
    const at = (minute: number) => `2026-10-27T10:0${minute}:00.000Z`;
    const result = fold([
      thread("root"),
      thread("done-early", { launchedBy: "root", createdAt: at(1) }),
      thread("running-late", { launchedBy: "root", status: "running", createdAt: at(5) }),
      thread("asking", { launchedBy: "root", input: true, createdAt: at(4) }),
      thread("running-early", { launchedBy: "root", status: "queued", createdAt: at(2) }),
    ]);
    expect(ids(result.childrenByParentKey.get(key("root")) ?? [])).toEqual([
      "asking",
      "running-early",
      "running-late",
      "done-early",
    ]);
  });

  it("lifts the most urgent descendant state onto every ancestor", () => {
    const result = fold([
      thread("root"),
      thread("child", { launchedBy: "root", status: "running" }),
      thread("grandchild", { launchedBy: "child", approval: true }),
      thread("quiet", { launchedBy: "root" }),
    ]);
    expect(result.liftByKey.get(key("root"))).toBe("approval");
    expect(result.liftByKey.get(key("child"))).toBe("approval");
    expect(result.liftByKey.has(key("quiet"))).toBe(false);
  });

  it("summarizes a group as counts and per-child states", () => {
    expect(summarizeLaunchGroup(["working", "attention", "finished"])).toEqual({
      count: 3,
      running: 1,
      attention: 1,
      states: ["working", "attention", "finished"],
    });
  });

  it("keeps live work deeper in a group out of a snoozed launcher", () => {
    const result = fold([
      thread("root", { snoozedUntil: "2026-10-28T00:00:00.000Z" }),
      thread("middle", { launchedBy: "root" }),
      thread("grandchild", { launchedBy: "middle", status: "running" }),
    ]);
    expect(ids(result.roots)).toEqual(["root", "middle"]);
    expect(ids(result.childrenByParentKey.get(key("middle")) ?? [])).toEqual(["grandchild"]);
    expect(result.stateByKey.get(key("middle"))).toBe("working");
  });

  it("carries a launched thread's subagent request to its launcher", () => {
    const result = foldLaunchedThreads({
      visible: [thread("root"), thread("lane", { launchedBy: "root" })],
      all: [],
      now: NOW,
      delegatedAttentionByKey: new Map([[key("lane"), "approval"]]),
    });
    expect(result.liftByKey.get(key("root"))).toBe("approval");
    expect(result.stateByKey.get(key("lane"))).toBe("attention");
  });
});
