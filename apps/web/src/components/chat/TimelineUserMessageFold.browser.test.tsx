import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { click, message, renderTimeline } from "./MessagesTimeline.browserHarness";

const environmentQuery = vi.hoisted(() => ({
  error: null as string | null,
  data: null as unknown,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    dataUpdatedAt: 0,
    error: environmentQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `Line ${index}`).join("\n");

describe("folding a long user message", () => {
  it("folds a user message only when the fold hides at least as much as it shows", async () => {
    await using screen = await renderTimeline([
      message(lines(12), {}, "medium"),
      message(lines(60), {}, "long"),
    ]);
    await vi.waitFor(() => expect(screen.buttons("Show full message")).toHaveLength(1));
    const [medium, long] = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-user-message-body]"),
    ];
    expect(medium!.dataset.userMessageCollapsible).toBe("false");
    expect(medium!.textContent).toContain("Line 11");
    const foldedHeight = long!.offsetHeight;
    await click(screen.button("Show full message"));
    expect(long!.offsetHeight).toBeGreaterThanOrEqual(foldedHeight * 2);
  });
});
