import { expect, it, vi } from "vite-plus/test";
import { createNativeMemoryHarness, renderNative } from "../../testing/memoryNativeHarness";
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
import { ThreadComputerUseHistoryView } from "./ThreadComputerUseHistoryView";

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
