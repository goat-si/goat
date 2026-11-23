import {
  RunId,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  type OrchestrationV2RunStatus,
  type TurnMemoryResult,
} from "@goat/contracts";
import { act } from "react";
import { expect, it } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  nativeEnv,
  nativeId,
  nativeSpace,
  renderNative,
} from "../../testing/memoryNativeHarness";
import { TurnMemoryDetails } from "./TurnMemoryDetails";

it("reads only the expanded turn and hides forgotten entries even if a reread returns the old receipt", async () => {
  const h = createNativeMemoryHarness({ protocolVersion: 1, turnMemory: true });
  const threadId = ThreadId.make("turn-test-thread");
  const runId = RunId.make("turn-test-run");
  const view = renderNative(
    h,
    <TurnMemoryDetails environmentId={nativeEnv} threadId={threadId} runId={runId} />,
  );
  h.responses.set(WS_METHODS.memoryTurnInspect, () => ({
    events: [
      {
        id: "1",
        kind: "automatic",
        query: null,
        items: [
          {
            memoryId: nativeId,
            revisionId: "00000000-0000-4000-8000-000000000004",
            excerpt: "release checklist",
          },
        ],
      },
      { id: "2", kind: "recall", query: "release date", items: [] },
    ],
    truncated: false,
  }));
  try {
    await h.waitForAtom(h.memory.canInspectTurnMemory(nativeEnv), Boolean);
    await view.render();
    expect(h.calls.map((call) => call.method)).not.toContain(WS_METHODS.memoryTurnInspect);
    await view.click("Turn memory");
    await expect.poll(() => view.container.textContent).toContain("release checklist");
    expect(view.container.textContent).toContain("Provided to the model");
    expect(view.container.textContent).toContain("Memory recall");
    expect(view.container.textContent).toContain("release date");
    expect(h.calls.filter((c) => c.method === WS_METHODS.memoryTurnInspect)).toMatchObject([
      { environmentId: nativeEnv, input: { memorySpaceId: nativeSpace, threadId, runId } },
    ]);
    await act(async () => {
      await h.signal({
        kind: "forget",
        memorySpaceId: nativeSpace,
        memoryId: nativeId,
        projectionWatermark: 2,
      });
    });
    expect(view.container.textContent).not.toContain("release checklist");
    await act(async () => {
      h.grant([]);
    });
    expect(view.container.textContent).toBe("");
  } finally {
    await view.unmount();
    h.dispose();
  }
});

it.each(["unloaded", "running", "completed"] as const)(
  "refreshes the open panel across projection and reply races when initially %s",
  async (initial) => {
    const h = createNativeMemoryHarness({ protocolVersion: 1, turnMemory: true });
    const runId = RunId.make("observed");
    const threadId = ThreadId.make("thread");
    const other = RunId.make("other");
    const provide = (status: OrchestrationV2RunStatus | "unloaded", toolRun?: RunId) =>
      h.registry.set(h.turnDetail, {
        projection: {
          runs: status === "unloaded" ? [] : [{ id: runId, status }],
          turnItems: toolRun
            ? [
                {
                  id: TurnItemId.make("tool"),
                  type: "dynamic_tool",
                  status: "completed",
                  runId: toolRun,
                },
              ]
            : [],
        },
      });
    const older = h.deferred<TurnMemoryResult>();
    const empty = { events: [], truncated: false };
    const recalled = {
      events: [{ id: "2", kind: "recall" as const, query: "late result", items: [] }],
      truncated: false,
    };
    const calls = () => h.calls.filter((c) => c.method === WS_METHODS.memoryTurnInspect).length;
    let response = 0;
    const awaitsCompletion = initial !== "completed";
    h.responses.set(WS_METHODS.memoryTurnInspect, () => {
      response++;
      if (awaitsCompletion && response === 1) return older.response;
      return response === (awaitsCompletion ? 2 : 1) ? empty : recalled;
    });
    const unsubscribe = h.registry.mount(h.turnDetail);
    provide(initial);
    const view = renderNative(
      h,
      <TurnMemoryDetails environmentId={nativeEnv} threadId={threadId} runId={runId} />,
    );
    try {
      await h.waitForAtom(h.memory.canInspectTurnMemory(nativeEnv), Boolean);
      await view.render();
      expect(calls()).toBe(0);
      await view.click("Turn memory");
      await h.waitForCall(WS_METHODS.memoryTurnInspect);
      if (awaitsCompletion) await act(async () => provide("completed"));
      await expect.poll(() => view.container.textContent).toContain("No memory activity");
      const atCompletion = calls();
      expect(atCompletion).toBe(awaitsCompletion ? 2 : 1);
      await act(async () => provide("completed", other));
      expect(calls()).toBe(atCompletion);
      await act(async () => provide("completed", runId));
      await expect.poll(() => view.container.textContent).toContain("late result");
      await act(async () => {
        await older.succeed(empty);
      });
      expect(view.container.textContent).toContain("late result");
      expect(calls()).toBe(atCompletion + 1);
    } finally {
      await view.unmount();
      unsubscribe();
      h.dispose();
    }
  },
);

it("updates an open turn memory panel when recall completes before the run ends (#3801)", async () => {
  const h = createNativeMemoryHarness({ protocolVersion: 1, turnMemory: true });
  const runId = RunId.make("running-recall");
  const threadId = ThreadId.make("running-thread");
  const update = (done: boolean) =>
    h.registry.set(h.turnDetail, {
      projection: {
        runs: [{ id: runId, status: "running" }],
        turnItems: done
          ? [{ id: TurnItemId.make("recall"), type: "dynamic_tool", status: "completed", runId }]
          : [],
      },
    });
  h.responses.set(WS_METHODS.memoryTurnInspect, () => ({
    events:
      h.calls.filter((c) => c.method === WS_METHODS.memoryTurnInspect).length > 1
        ? [{ id: "1", kind: "recall", query: "fresh recall", items: [] }]
        : [],
    truncated: false,
  }));
  const unsubscribe = h.registry.mount(h.turnDetail);
  update(false);
  const view = renderNative(
    h,
    <TurnMemoryDetails environmentId={nativeEnv} threadId={threadId} runId={runId} />,
  );
  try {
    await h.waitForAtom(h.memory.canInspectTurnMemory(nativeEnv), Boolean);
    await view.render();
    await view.click("Turn memory");
    await h.waitForCall(WS_METHODS.memoryTurnInspect);
    await act(async () => update(true));
    expect(h.calls.filter((c) => c.method === WS_METHODS.memoryTurnInspect)).toHaveLength(2);
    await act(async () => h.waitForCall(WS_METHODS.memoryTurnInspect, 2));
    expect(view.container.textContent).toContain("fresh recall");
  } finally {
    await view.unmount();
    unsubscribe();
    h.dispose();
  }
});
