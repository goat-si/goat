import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageSummaryInput } from "@goat/contracts";
import { makeWindow } from "@goat/shared/usageFormat";
import { mergeUsage } from "@goat/shared/usageMerge";

import { act, render } from "../../../test/render";
import { UsagePage } from "./UsagePage";
import { readUsagePagePreferences, saveUsagePagePreferences } from "./usagePagePreferences";

const state = vi.hoisted(() => ({ useUsage: vi.fn() }));
vi.mock(import("../../state/usage"), async (original) => ({
  ...(await original()),
  useUsage: state.useUsage,
}));

describe("usage period selection", () => {
  it("shows the previous period during the switch and skips intermediate queries", async () => {
    const previousPreferences = readUsagePagePreferences();
    saveUsagePagePreferences({ metric: "cost", windowDays: 7 });
    const initial = makeWindow(7);
    const month = makeWindow(30);
    const quarter = makeWindow(90);
    const merged = mergeUsage([], USAGE_CONTRACT_VERSION);
    const seen = new Set<string>();
    let result: "pending" | "failed" | "ready" = "pending";
    state.useUsage.mockImplementation((window: UsageSummaryInput) => {
      seen.add(window.sinceDay);
      const environment = {
        environmentId: EnvironmentId.make("fixture"),
        label: "This machine",
        canReadDiagnostics: true,
        isConnected: true,
        isPending: result === "pending",
        error: result === "failed" ? "This environment could not report usage." : null,
        summary: null,
        needsCursorKeychainAccess: false,
      };
      return {
        merged,
        environments: [environment],
        selectedEnvironments: [environment],
        shown: {
          window: result !== "ready" && window.sinceDay !== initial.sinceDay ? initial : window,
          merged,
        },
        isPending: result === "pending" && window.sinceDay !== initial.sinceDay,
        isPartial: false,
        refresh: () => Promise.resolve(),
      };
    });

    try {
      await using screen = await render(<UsagePage />, { router: "/usage" });
      const dialog = page.getByRole("dialog", { name: "Usage" });
      const monthButton = dialog.getByRole("button", { name: "30 days" });
      const quarterButton = dialog.getByRole("button", { name: "90 days" });
      await expect.element(monthButton).toBeVisible();

      const click = (element: HTMLElement) => act(() => element.click());
      await click(monthButton.element() as HTMLElement);
      const statusText = () => dialog.getByRole("status").element().textContent;
      expect(statusText()).toContain("Loading usage");
      expect(seen).toEqual(new Set([initial.sinceDay]));
      await click(quarterButton.element() as HTMLElement);

      await expect.poll(() => seen.has(quarter.sinceDay)).toBe(true);
      expect(seen.has(month.sinceDay)).toBe(false);
      expect(statusText()).toContain("Showing");

      result = "failed";
      await screen.rerender(<UsagePage />);
      expect(statusText()).toContain("Could not load usage");

      result = "ready";
      await screen.rerender(<UsagePage />);
      expect(statusText()).toBe("");
    } finally {
      saveUsagePagePreferences(previousPreferences);
    }
  });
});
