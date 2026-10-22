import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";

const appearance = vi.hoisted(() => ({ mode: "light" as "light" | "dark", baseFontSize: 16 }));

vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: () => null,
  useKeyboardState: () => false,
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollViewMarker: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
vi.mock("./useMobileGoatBotSession", () => ({ useMobileGoatBotSession: () => ({}) }));
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: appearance.mode,
    appearance: { baseFontSize: appearance.baseFontSize },
  }),
}));
import { GoatBotTimelineRow } from "./GoatBotScreen";

let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
  appearance.mode = "light";
  appearance.baseFontSize = 16;
});

const props = { canSend: true, onSend: () => true, onRetry: vi.fn(), onSelectThread: () => {} };
const bot = (overrides: Partial<Extract<GoatBotRow, { kind: "bot" }>> = {}): GoatBotRow => ({
  kind: "bot",
  id: "bot",
  text: "Progress update",
  createdAt: "2026-10-12T09:40:00Z",
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
  ...overrides,
});
const user = (
  delivery: Extract<GoatBotRow, { kind: "user" }>["delivery"],
  showReceipt: boolean,
): GoatBotRow => ({
  kind: "user",
  sendKey: null,
  requestKey: null,
  id: "user",
  text: "Hello",
  createdAt: "2026-10-12T09:40:00Z",
  firstInGroup: true,
  groupPosition: "single",
  delivery,
  showReceipt,
});

it("shows time in a same-day pause stamp", async () => {
  const now = Date.UTC(2026, 9, 21, 12);
  using _date = vi.spyOn(Date, "now").mockReturnValue(now);
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      row={{ kind: "day", id: "day", at: new Date(now).toISOString() }}
    />,
  );
  await view.render();
  expect(view.container.textContent).toContain("Today");
  expect(view.container.textContent).toMatch(/\d/);
});

it("keeps the receipt on only the marked user row", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      row={user({ state: "read", readAt: "2026-10-12T09:41:00Z" }, false)}
    />,
  );
  await view.render();
  expect(view.container.textContent).not.toContain("Read");
  await view.rerender(
    <GoatBotTimelineRow
      {...props}
      row={user({ state: "read", readAt: "2026-10-12T09:41:00Z" }, true)}
    />,
  );
  expect(view.container.textContent).toContain("Read");
});

it("offers retry only for a recoverable failure", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      row={user({ state: "failed", clientKey: "r", rejectionReason: "Rejected" }, true)}
    />,
  );
  await view.render();
  expect(view.container.textContent).toContain("Rejected");
  expect(view.container.textContent).not.toContain("Retry");
  await view.rerender(
    <GoatBotTimelineRow {...props} row={user({ state: "failed", clientKey: "k" }, true)} />,
  );
  expect(view.container.textContent).toContain("Not Delivered");
  expect(view.container.textContent).toContain("Retry");
});

it("labels only the first proactive bubble in a group", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(h, <GoatBotTimelineRow {...props} row={bot({ proactive: true })} />);
  await view.render();
  expect(view.container.textContent).toContain("GOAT Bot · Update");
  await view.rerender(<GoatBotTimelineRow {...props} row={bot({ proactive: false })} />);
  expect(view.container.textContent).not.toContain("GOAT Bot · Update");
  await view.rerender(
    <GoatBotTimelineRow
      {...props}
      row={bot({ proactive: true, firstInGroup: false, groupPosition: "last" })}
    />,
  );
  expect(view.container.textContent).not.toContain("GOAT Bot · Update");
});
