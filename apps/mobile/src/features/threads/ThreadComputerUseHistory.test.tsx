import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, OrchestrationV2TurnItemJson, ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: () => true,
}));
vi.mock("@goat/client-runtime/state/computer-use-history", () => ({
  createComputerUseHistoryCommand: () => ({ permissionAtom: () => null }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
import { createNativeMemoryHarness, renderNative } from "../../testing/memoryNativeHarness";
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
import { ThreadComputerUseHistoryView } from "./ThreadComputerUseHistoryView";
import { ThreadComputerUseHistoryForItem } from "./ThreadComputerUseHistory";

const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

it("mounts input history for a browser-only work entry", async () => {
  const item = decodeItem({
    id: "browser-action",
    type: "dynamic_tool",
    threadId: "thread:a",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    toolName: "goat.preview_click",
    input: {},
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-29T00:00:00.000Z",
  });
  const harness = createNativeMemoryHarness();
  const view = renderNative(
    harness,
    <ThreadComputerUseHistoryForItem
      item={item}
      environmentId={EnvironmentId.make("environment:a")}
      threadId={ThreadId.make("thread:a")}
    />,
  );
  try {
    await view.render();
    expect(view.container.textContent).toContain("Show input history");
  } finally {
    await view.unmount();
    harness.dispose();
  }
});

it("loads and pages newest-first input history with refusal details", async () => {
  const base = {
    threadId: "thread:a",
    recordedAt: 0,
    targetKind: "app",
    appId: "fixture.app",
    appName: "Fixture",
    tabHost: null,
    targetLabel: null,
    typedText: null,
    typedLength: null,
  } as const;
  const load = vi
    .fn()
    .mockResolvedValueOnce({
      entries: [
        { ...base, id: 2, method: "click", verdict: "refused", refusalCode: "target_busy" },
      ],
      nextCursor: { recordedAt: 0, id: 2 },
    })
    .mockResolvedValueOnce({
      entries: [
        { ...base, id: 1, method: "type_text", verdict: "sent", refusalCode: null, typedLength: 6 },
      ],
      nextCursor: null,
    });
  const harness = createNativeMemoryHarness();
  const view = renderNative(harness, <ThreadComputerUseHistoryView canRead load={load} />);
  try {
    await view.render();
    expect(load).not.toHaveBeenCalled();
    await view.click("Show input history");
    expect(view.container.textContent).toContain("target_busy");
    await view.click("Load more");
    expect(load).toHaveBeenLastCalledWith({ recordedAt: 0, id: 2 });
    expect(view.container.textContent).toContain("6 characters");
    expect(view.container.textContent?.indexOf("click")).toBeLessThan(
      view.container.textContent?.indexOf("type_text") ?? -1,
    );
  } finally {
    await view.unmount();
    harness.dispose();
  }
});
