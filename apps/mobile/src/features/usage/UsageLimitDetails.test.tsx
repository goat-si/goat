import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
import { UsageLimitDetails } from "./UsageLimitDetails";

it("shows the zero spend cap when there are no usage windows", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <UsageLimitDetails
          limits={{ checkedAt: "2026-01-01T00:00:00Z", windows: [], zeroSpendCap: true }}
        >
          {null}
        </UsageLimitDetails>,
      ),
    );
    expect(container.textContent).toContain("Monthly spend: $0 cap");
    expect(container.textContent).not.toContain("No limits reported.");
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
