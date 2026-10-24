// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
  }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  AndroidSettingsEnvironmentFilter: () => null,
  SettingsEnvironmentFilterHeader: () => null,
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [{ environmentId: "origin", label: "Origin" }],
  }),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state.query() }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { decisionItems: (target: unknown) => target },
}));

import { SettingsDecisionInboxRouteScreen } from "./SettingsDecisionInboxRouteScreen";

it.each([
  {
    title: "baseline-failing: reports unavailable destinations and truncated results",
    partial: true,
  },
  {
    title: "preservation: refreshes remote decisions while keeping mobile Settings read-only",
    partial: false,
  },
])("$title", async ({ partial }) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const item = {
    id: "same-id",
    source: "decision",
    title: "Remote rollout",
    context: "Choose one host",
    from: { host: "worker", environmentId: "destination" },
    status: "open",
    requiredProfile: "maintainer",
    humanRequired: false,
    options: [{ id: "stage", label: "Stage rollout", consequence: "Canary first" }],
    recommended: null,
    answer: null,
    expiresAt: null,
  };
  const refresh = vi.fn(() => {
    state.query.mockReturnValue({
      data: {
        items: [{ ...item, title: "Refreshed remote rollout" }],
        unavailableHosts: [],
        truncated: false,
      },
      refresh,
      isPending: false,
      error: null,
    });
  });
  state.query.mockReset().mockReturnValue({
    data: {
      items: [item],
      unavailableHosts: partial
        ? [{ host: "offline", code: "unavailable", message: "Update GOAT on offline." }]
        : [],
      truncated: partial,
    },
    refresh,
    isPending: false,
    error: null,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  using cleanup = {
    [Symbol.dispose]() {
      act(() => root.unmount());
      container.remove();
    },
  };
  await act(async () => root.render(<SettingsDecisionInboxRouteScreen />));
  expect(container.textContent).toContain("worker");
  if (partial) {
    expect(container.textContent).toContain("Update GOAT on offline.");
    expect(container.textContent).toContain("Some decisions are not shown.");
  }
  expect(container.querySelector("input, textarea")).toBeNull();
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Show answered and expired",
    "Refresh",
  ]);
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Refresh")
      ?.click(),
  );
  await act(async () => root.render(<SettingsDecisionInboxRouteScreen />));
  expect(container.textContent).toContain("Refreshed remote rollout");
  expect(container.textContent).not.toContain("Update GOAT on offline.");
});
