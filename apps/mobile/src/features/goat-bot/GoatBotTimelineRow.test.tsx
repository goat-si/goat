import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { act } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";

const appearance = vi.hoisted(() => ({ mode: "light" as "light" | "dark", baseFontSize: 16 }));

vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
vi.mock("./MobileBotWork", () => ({ MobileBotWork: () => null }));
vi.mock("./GoatBotFace", () => ({ GoatBotHeaderFace: () => null }));
// The native Markdown renderer cannot load under Vitest.
vi.mock("./GoatBotMarkdown", () => ({ GoatBotMarkdown: () => null }));
vi.mock("./GoatBotComposerAttachments", () => ({
  GoatBotAttachButton: () => null,
  GoatBotAttachmentStrip: () => null,
  releaseGoatBotAttachments: () => {},
}));
vi.mock("@react-navigation/elements", async () => ({
  HeaderHeightContext: (await import("react")).createContext<number | undefined>(undefined),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: unknown }) => props.children },
  useAnimatedStyle: (style: () => object) => style(),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: () => null,
  useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
vi.mock("./useMobileGoatBotSession", () => ({ useMobileGoatBotSession: () => ({}) }));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: appearance.mode,
    appearance: { baseFontSize: appearance.baseFontSize },
  }),
}));
import { GoatBotTimelineRow } from "./GoatBotScreen";
import { GoatBotActivityLine, GoatBotQuestionCard } from "./GoatBotMessageParts";

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

it("ends a person's group with its time and keeps read receipts out of the transcript", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      row={user({ state: "read", readAt: "2026-10-12T09:41:00Z" }, true)}
    />,
  );
  await view.render();
  expect(view.container.textContent).not.toContain("Read");
  expect(view.container.textContent).toMatch(/^Hello.*\d/);
  await view.rerender(<GoatBotTimelineRow {...props} row={user({ state: "delivered" }, true)} />);
  expect(view.container.textContent).not.toContain("Delivered");
  await view.rerender(<GoatBotTimelineRow {...props} row={user({ state: "sending" }, true)} />);
  expect(view.container.textContent).toContain("Sending…");
  await view.rerender(<GoatBotTimelineRow {...props} row={user({ state: "queued" }, true)} />);
  expect(view.container.textContent).toContain("Waiting to send");
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

it("heads only the first bot message of a group with the bot's name and marks updates", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(h, <GoatBotTimelineRow {...props} row={bot({ proactive: true })} />);
  await view.render();
  expect(view.container.textContent).toContain("GOAT Bot · Update");
  await view.rerender(<GoatBotTimelineRow {...props} row={bot({ proactive: false })} />);
  expect(view.container.textContent).toMatch(/^GOAT Bot · \d/);
  expect(view.container.textContent).not.toContain("GOAT Bot · Update");
  await view.rerender(
    <GoatBotTimelineRow
      {...props}
      row={bot({ proactive: true, firstInGroup: false, groupPosition: "last" })}
    />,
  );
  expect(view.container.textContent).not.toContain("GOAT Bot");
});

it("names a member bot on its update and leaves a reply unlabeled", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotTimelineRow {...props} botName="Scout" row={bot({ proactive: true })} />,
  );
  await view.render();
  expect(view.container.textContent).toContain("Scout · Update");
  expect(view.container.textContent).not.toContain("GOAT Bot · Update");
  await view.rerender(
    <GoatBotTimelineRow {...props} botName="Scout" row={bot({ proactive: false })} />,
  );
  expect(view.container.textContent).not.toContain("· Update");
});

it("opens the task represented by a task row", async () => {
  h = createNativeMemoryHarness();
  const onSelectTask = vi.fn();
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      onSelectTask={onSelectTask}
      row={{
        kind: "task",
        id: "card",
        createdAt: "2026-10-12T09:40:00Z",
        firstInGroup: true,
        groupPosition: "single",
        card: {
          key: "task-1",
          revision: 1,
          updatedAt: "2026-10-12T09:40:00Z",
          title: "Check disks",
          statusLabel: "Running",
          tone: "active",
          sourceLabel: null,
          summary: null,
          attentionLabel: null,
          pullRequests: [],
          target: { kind: "none", label: "Unavailable" },
        },
      }}
    />,
  );
  await view.render();
  await view.click("Check disks. Running. Open task");
  expect(onSelectTask).toHaveBeenCalledWith("task-1");
});
it("shows a bot event as a centered note line", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      row={{
        kind: "event",
        id: "event",
        text: "Routine Check in paused",
        createdAt: "2026-11-07T09:40:00Z",
        firstInGroup: true,
        groupPosition: "single",
      }}
    />,
  );
  await view.render();
  expect(view.container.textContent).toBe("Routine Check in paused");
});

it("counts how long followed work has run a second at a time and opens to the work's title", async () => {
  const since = "2026-10-12T09:40:00Z";
  vi.useFakeTimers({ now: Date.parse(since) + 12_000, toFake: ["setInterval", "Date"] });
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotActivityLine
      botName="GOAT Bot"
      activity={{ state: "working", text: "Copying files", title: "Check the disks" }}
      since={since}
    />,
  );
  await view.render();
  expect(view.container.textContent).toContain("Copying files · 12s");
  expect(view.container.textContent).not.toContain("Check the disks");
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(view.container.textContent).toContain("Copying files · 1m");
  await view.click("Show work details");
  expect(view.container.textContent).toContain("Check the disks");
  await view.click("Hide work details");
  expect(view.container.textContent).not.toContain("Check the disks");
});

it("asks a question with answers as one card and sends the picked answer to its task", async () => {
  h = createNativeMemoryHarness();
  const onSend = vi.fn(() => true);
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      onSend={onSend}
      row={bot({
        tone: "question",
        text: "Deploy now?",
        options: ["Yes", "Later"],
        answerTaskId: "task-1",
      })}
    />,
  );
  await view.render();
  expect(view.container.textContent).toContain("Deploy now?");
  await view.click("Later");
  expect(onSend).toHaveBeenCalledWith("Later", "task-1");
});

it("folds an answered question to the answer that was picked", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotQuestionCard options={["Yes", "Later"]} answered="Later" canAnswer onPick={vi.fn()}>
      {null}
    </GoatBotQuestionCard>,
  );
  await view.render();
  expect(view.container.textContent).toContain("You answered: Later");
  expect(view.container.querySelectorAll("button")).toHaveLength(0);
});
