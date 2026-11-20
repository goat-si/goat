import { RunId, ThreadId, WS_METHODS } from "@goat/contracts";
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

it("reads only the expanded turn and removes its entries when permission changes", async () => {
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
      h.grant([]);
    });
    expect(view.container.textContent).toBe("");
  } finally {
    await view.unmount();
    h.dispose();
  }
});
