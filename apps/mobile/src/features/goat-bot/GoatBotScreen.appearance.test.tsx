import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

const appearance = vi.hoisted(() => ({ mode: "dark" as "light" | "dark", baseFontSize: 16 }));

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: appearance.mode,
    appearance: { baseFontSize: appearance.baseFontSize },
  }),
}));
vi.mock("react-native", () => ({
  View: ({
    children,
    style,
    className,
  }: {
    children?: ReactNode;
    style?: unknown;
    className?: string;
  }) => (
    <div data-style={JSON.stringify(style)} data-class={className}>
      {children}
    </div>
  ),
  Text: ({
    children,
    style,
    className,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    style?: unknown;
    className?: string;
    accessibilityLabel?: string;
  }) => (
    <span data-style={JSON.stringify(style)} data-class={className} aria-label={accessibilityLabel}>
      {children}
    </span>
  ),
  Pressable: ({
    children,
    style,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityLabel?: string;
  }) => (
    <button data-style={JSON.stringify(style)} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
  TextInput: ({ style }: { style?: unknown }) => (
    <input aria-label="Message GOAT Bot" data-style={JSON.stringify(style)} />
  ),
  Platform: { OS: "ios" },
}));
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useKeyboardState: () => false,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0 }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("../settings/SettingsMemoryRouteScreen", () => ({ MemoryReportLink: () => null }));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => () => {},
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("./useReplying", () => ({ useReplying: () => false }));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
vi.mock("./useMobileGoatBotSession", () => ({
  useMobileGoatBotSession: () => ({
    availability: "ready",
    rows: [],
    canSend: true,
    onSend: () => true,
    onRetryInput: () => {},
    replyingSince: null,
  }),
}));

import { GoatBotScreen, GoatBotTimelineRow } from "./GoatBotScreen";

const props = { canSend: true, onSend: () => true, onRetry: () => {}, onSelectThread: () => {} };
const bot: Extract<GoatBotRow, { kind: "bot" }> = {
  kind: "bot",
  id: "bot",
  text: "Could not continue",
  createdAt: "2026-10-12T09:40:00Z",
  tone: "failure",
  proactive: false,
  replyTo: null,
  options: ["Try again"],
  firstInGroup: true,
  groupPosition: "single",
};

async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("marks a failed answer as danger and prefixes its accessibility label", async () => {
  const view = await render(<GoatBotTimelineRow {...props} row={bot} />);
  const { container } = view;
  const failure = container.querySelector('[aria-label="Failed: Could not continue"]');
  expect(failure?.getAttribute("data-class")).toContain("text-danger-foreground");
  expect(JSON.parse(failure?.getAttribute("data-style") ?? "null")).toEqual({
    fontSize: 16,
    lineHeight: 23,
  });
  await view.unmount();
});

it("uses the selected app appearance for answer chips and the send button", async () => {
  appearance.mode = "dark";
  const rowView = await render(<GoatBotTimelineRow {...props} row={{ ...bot, tone: "reply" }} />);
  const chip = rowView.container.querySelector("button");
  expect(JSON.parse(chip?.getAttribute("data-style") ?? "null").borderColor).toBe("#2B66C6");
  expect(JSON.parse(chip?.querySelector("span")?.getAttribute("data-style") ?? "null").color).toBe(
    "#2B66C6",
  );
  await rowView.unmount();

  const screenView = await render(<GoatBotScreen visible />);
  const send = screenView.container.querySelector('[aria-label="Send message"]');
  const composer = screenView.container.querySelector('[aria-label="Message GOAT Bot"]');
  expect(JSON.parse(composer?.getAttribute("data-style") ?? "null")).toMatchObject({
    minHeight: 44,
    borderRadius: 22,
    borderWidth: 0.5,
    backgroundColor: "#1C1C1E",
  });
  expect(JSON.parse(send?.getAttribute("data-style") ?? "null")).toMatchObject({
    width: 44,
    height: 44,
  });
  expect(
    JSON.parse(send?.querySelector("div")?.getAttribute("data-style") ?? "null"),
  ).toMatchObject({
    width: 28,
    height: 28,
    borderRadius: 14,
  });
  expect(
    JSON.parse(send?.querySelector("div")?.getAttribute("data-style") ?? "null").backgroundColor,
  ).toBe("#2B66C6");
  await screenView.unmount();
});

it("uses the light filled composer", async () => {
  appearance.mode = "light";
  const view = await render(<GoatBotScreen visible />);
  const composer = view.container.querySelector('[aria-label="Message GOAT Bot"]');
  expect(JSON.parse(composer?.getAttribute("data-style") ?? "null").backgroundColor).toBe(
    "#F2F2F7",
  );
  await view.unmount();
  appearance.mode = "dark";
});

it("scales timeline message text when the base font size changes", async () => {
  appearance.baseFontSize = 20;
  const view = await render(<GoatBotTimelineRow {...props} row={{ ...bot, tone: "reply" }} />);
  const message = Array.from(view.container.querySelectorAll("span")).find(
    (element) => element.textContent === bot.text,
  );
  expect(JSON.parse(message?.getAttribute("data-style") ?? "null")).toMatchObject({
    fontSize: 20,
    lineHeight: 29,
  });
  await view.unmount();
  appearance.baseFontSize = 16;
});
