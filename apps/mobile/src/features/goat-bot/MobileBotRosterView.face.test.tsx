import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotProfile } from "@goat/contracts";
import * as Schema from "effect/Schema";

// The roster's member rows through the real member-status hook: only the status read underneath
// it, the thread shells and the native views stand in.
// Home's work signals are not under test here.
vi.mock("./useMobileBotRowSignals", () => ({ useMobileBotRowSignals: () => null }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: (props: {
    children?: ReactNode;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
  }) => (
    <div
      aria-hidden={props.accessibilityElementsHidden}
      data-important={props.importantForAccessibility}
    >
      {props.children}
    </div>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Modal: () => null,
  Alert: { alert: vi.fn() },
  Text: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
  }) => (
    <span
      aria-label={props.accessibilityLabel}
      aria-hidden={props.accessibilityElementsHidden}
      data-important={props.importantForAccessibility}
    >
      {props.children}
    </span>
  ),
  Pressable: (props: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button onClick={props.onPress} aria-label={props.accessibilityLabel}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../lib/appState", () => ({
  useAppActive: () => true,
  useReduceMotionEnabled: () => false,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => <span /> }));
// The avatar stand-in shows which face it was asked to draw.
vi.mock("./GoatBotFace", () => ({
  GoatBotFaceAvatar: (props: { state: string }) => <i data-face={props.state} />,
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: { environmentId: "env", threadId: "bot" } }),
}));
const fixture = vi.hoisted(() => ({
  // Each member's status, by bot id, as channel.getBotStatus answers it; absent while pending.
  status: {} as Record<string, object | undefined>,
  // Thread shells by thread id.
  shells: {} as Record<string, object | undefined>,
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : (fixture.shells[ref.threadId] ?? null),
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    botStatus: (args: { input: { botId: string } }) => ({ botId: args.input.botId }),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { botId: string } | null) => ({
    data: atom === null ? null : (fixture.status[atom.botId] ?? null),
    refresh: () => {},
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          connection: { phase: "connected" },
          serverConfig: { environment: { capabilities: { goatBotMembers: true } } },
        },
      ],
    ]),
  }),
}));
vi.mock("./MobileNeedsYouStrip", () => ({ MobileNeedsYouStrip: () => null }));
vi.mock("../../state/use-thread-detail", () => ({ useThreadVisibleTurnItems: () => [] }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../workspace/WorkspaceTabsContext", () => ({ useWorkspaceTabs: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => <span /> }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string }) => <button>{props.label}</button>,
}));
import { MobileBotRosterView } from "./MobileBotRosterView";

const decodeProfile = Schema.decodeUnknownSync(BotProfile);
const member = (botId: string, name: string) =>
  decodeProfile({
    botId,
    role: "member",
    name,
    avatar: null,
    purpose: "Finds sources",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env",
    sessionThreadId: "thread-" + botId,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  });
const scout = member("scout", "Scout");
const ada = member("ada", "Ada");
const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
// A shell with no run going, last active a minute ago, so the face is idle rather than asleep.
const quiet = (threadId: string) => ({
  source: {
    activityRunStatus: null,
    latestRunStartHeld: false,
    pendingRuntimeRequest: null,
    latestRunCompletedAt: null,
    status: "idle",
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    createdAt: { epochMilliseconds: NOW - 60_000 },
  },
  updatedAt: ago(60),
  threadId,
});

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(statuses: Record<string, object | undefined>) {
  vi.useFakeTimers({ now: NOW });
  fixture.status = statuses;
  fixture.shells = {};
}
async function show(bots = [scout]) {
  document.body.appendChild(container);
  root ??= createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotRosterView
        bots={[
          { kind: "main", profile: null },
          ...bots.map((profile) => ({ kind: "member" as const, profile })),
        ]}
        slackEnabled={false}
        onOpenBot={() => {}}
      />,
    ),
  );
}
const row = (name: string) =>
  [...container.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.split(", ").includes(name),
  );
const faceOf = (name: string) => row(name)?.querySelector("[data-face]")?.getAttribute("data-face");
const labelOf = (name: string) => row(name)?.getAttribute("aria-label");
const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

it("reads while the person's message is the newest, from a status with no tasks, then turns back after 90 s", async () => {
  setup({ scout: { waitingCount: 0, latest: { text: "Find it", at: ago(30), author: "person" } } });
  const interval = vi.spyOn(globalThis, "setInterval");
  const timeout = vi.spyOn(globalThis, "setTimeout");
  await show();
  expect(faceOf("Scout")).toBe("reading");
  expect(labelOf("Scout")).toBe("Reading, Scout, You: Find it");
  // One timeout, at the message plus the 90 s reading limit; never an interval.
  expect(timeout.mock.calls.some(([, delay]) => delay === 60_000)).toBe(true);
  await wait(60_000);
  expect(faceOf("Scout")).not.toBe("reading");
  expect(labelOf("Scout")).toBe("Scout, You: Find it");
  expect(interval).not.toHaveBeenCalled();
});

it("keeps today's face while the status is pending, and for a loaded status with nothing in it", async () => {
  setup({});
  await show();
  expect(faceOf("Scout")).toBe("idle");
  expect(labelOf("Scout")).toBe("Scout, Finds sources");
  fixture.status = { scout: { waitingCount: 0 } };
  await show();
  expect(faceOf("Scout")).toBe("idle");
  expect(labelOf("Scout")).toBe("Scout, Finds sources");
});

it("works while the status says a task is going, and leaves an inactive shell idle when none is", async () => {
  setup({ scout: { waitingCount: 0, tasks: { active: true } } });
  fixture.shells = { "thread-scout": quiet("thread-scout") };
  await show();
  expect(faceOf("Scout")).toBe("working");
  expect(labelOf("Scout")).toBe("Working, Scout, Finds sources");
  fixture.status = { scout: { waitingCount: 0, tasks: { active: false } } };
  await show();
  await wait(1_300);
  expect(faceOf("Scout")).toBe("idle");
});

it("waits first and says it once with its count, the badge's own number hidden from screen readers", async () => {
  setup({ scout: { waitingCount: 2, tasks: { active: true } } });
  await show();
  expect(faceOf("Scout")).toBe("waiting");
  expect(labelOf("Scout")).toBe("2 waiting for you, Scout, Finds sources");
  const badge = [...(row("Scout")?.querySelectorAll("span") ?? [])].find(
    (span) => span.textContent === "2",
  );
  expect(badge?.getAttribute("aria-hidden")).toBe("true");
  expect(badge?.getAttribute("data-important")).toBe("no-hide-descendants");
  expect(badge?.getAttribute("aria-label")).toBeNull();
});

it("keeps Reading through the face hold when the reply arrives, then moves on", async () => {
  // The first face a row shows takes no hold, so the row starts idle and then starts reading.
  setup({ scout: { waitingCount: 0, latest: { text: "Hi", at: ago(600), author: "bot" } } });
  fixture.shells = { "thread-scout": quiet("thread-scout") };
  await show();
  expect(faceOf("Scout")).toBe("idle");
  fixture.status = {
    scout: { waitingCount: 0, latest: { text: "Find it", at: ago(0), author: "person" } },
  };
  await show();
  expect(faceOf("Scout")).toBe("reading");
  await wait(500);
  fixture.status = {
    scout: { waitingCount: 0, latest: { text: "Found it", at: ago(-0.5), author: "bot" } },
  };
  await show();
  expect(faceOf("Scout")).toBe("reading");
  await wait(700);
  expect(faceOf("Scout")).toBe("idle");
});

it("gives each member its own status", async () => {
  setup({
    scout: { waitingCount: 0, tasks: { active: true } },
    ada: { waitingCount: 1 },
  });
  await show([scout, ada]);
  expect(faceOf("Scout")).toBe("working");
  expect(faceOf("Ada")).toBe("waiting");
});

it("leads the main bot's label with its state", async () => {
  setup({});
  fixture.shells = {
    bot: { source: { ...quiet("bot").source, activityRunStatus: "running" }, threadId: "bot" },
  };
  await show([]);
  expect(container.querySelector('[aria-label="Working, GOAT Bot"]')).not.toBeNull();
});
