import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  goatBotActivity,
  type GoatBotActivity,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

const appearance = vi.hoisted(() => ({ mode: "dark" as "light" | "dark", baseFontSize: 16 }));
const screenSession = vi.hoisted(() => ({
  activity: null as GoatBotActivity | null,
  rows: [] as GoatBotRow[],
  supportsTaskThreads: false,
  requestedTaskId: undefined as string | null | undefined,
  workTaskId: undefined as string | undefined,
  chatTasks: [] as ReadonlyArray<{ readonly key: string }>,
}));
vi.mock("./MobileBotWork", () => ({
  MobileBotWork: (props: {
    taskId?: string;
    taskCard?: ReactNode;
    chatTasks?: ReadonlyArray<{ readonly key: string }>;
  }) => {
    screenSession.workTaskId = props.taskId;
    screenSession.chatTasks = props.chatTasks ?? [];
    return <section aria-label="Task header">{props.taskCard}</section>;
  },
}));
const list = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  scrollToIndex: vi.fn(),
}));
vi.mock("./GoatBotFace", () => ({
  GoatBotHeaderFace: () => null,
  GoatBotProgressFace: (props: { state: string; inView: boolean }) => (
    <i data-face={`${props.state}:${props.inView}`} />
  ),
}));
vi.mock("./GoatBotShimmerText", () => ({
  GoatBotShimmerText: (props: { label: string; animate: boolean; style?: unknown }) => (
    <span data-sweep={String(props.animate)} data-style={JSON.stringify(props.style)}>
      {props.label}
    </span>
  ),
}));
const picker = vi.hoisted(() => ({
  onPicked: null as
    | ((files: ReadonlyArray<import("../../lib/composerImages").DraftComposerAttachment>) => void)
    | null,
  release: vi.fn(),
}));
type LayoutHandler = (event: { nativeEvent: { layout: { height: number } } }) => void;
const layouts = vi.hoisted(() => new Map<string, LayoutHandler>());

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
    testID,
    onLayout,
  }: {
    children?: ReactNode;
    style?: unknown;
    className?: string;
    testID?: string;
    onLayout?: LayoutHandler;
  }) => {
    if (testID && onLayout) layouts.set(testID, onLayout);
    return (
      <div data-style={JSON.stringify(style)} data-class={className}>
        {children}
      </div>
    );
  },
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
    onPress,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => (
    <button data-style={JSON.stringify(style)} aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  TextInput: ({
    style,
    value,
    onChangeText,
  }: {
    style?: unknown;
    value?: string;
    onChangeText?: (text: string) => void;
  }) => (
    <input
      aria-label="Message GOAT Bot"
      data-style={JSON.stringify(style)}
      value={value ?? ""}
      onChange={(event) => onChangeText?.(event.currentTarget.value)}
    />
  ),
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 393, height: 852 }),
}));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
// The native Markdown renderer cannot load under Vitest.
vi.mock("./GoatBotMarkdown", () => ({ GoatBotMarkdown: () => null }));
vi.mock("./GoatBotComposerAttachments", () => ({
  GoatBotAttachButton: (props: { onPicked: typeof picker.onPicked }) => {
    picker.onPicked = props.onPicked;
    return null;
  },
  GoatBotAttachmentStrip: () => null,
  releaseGoatBotAttachments: picker.release,
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: {
    data?: GoatBotRow[];
    renderItem?: (item: { item: GoatBotRow }) => ReactNode;
    ListFooterComponent?: ReactNode;
    ref?: { current: unknown };
  }) => {
    list.props = props;
    if (props.ref) props.ref.current = { scrollToIndex: list.scrollToIndex };
    return (
      <>
        {props.data?.map((item) => (
          <div key={item.id}>{props.renderItem?.({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </>
    );
  },
}));
vi.mock("@react-navigation/elements", async () => ({
  HeaderHeightContext: (await import("react")).createContext<number | undefined>(undefined),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: () => {} }),
  StackActions: { push: (name: string, params: object) => ({ name, params }) },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: unknown }) => props.children },
  useAnimatedStyle: (style: () => object) => style(),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
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
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
vi.mock("./useMobileGoatBotSession", () => ({
  useMobileGoatBotSession: (_visible: boolean, taskId?: string | null) => {
    screenSession.requestedTaskId = taskId;
    return {
      availability: "ready",
      rows: screenSession.rows,
      canSend: true,
      attachmentSupport: { maxUploadBytes: null },
      onSend: () => true,
      onRetryInput: () => {},
      replyingSince: null,
      activity: screenSession.activity,
      supportsTaskThreads: screenSession.supportsTaskThreads,
    };
  },
}));

import { GoatBotScreen, GoatBotTimelineRow } from "./GoatBotScreen";
import { isComposerAttachmentFileRetained } from "../../lib/composerAttachmentFiles";

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

async function typeInto(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Message GOAT Bot"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    rerender: async (next: ReactNode) => {
      await act(async () => root.render(next));
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("releases a picker result that arrives after the GOAT Bot screen unmounts", async () => {
  picker.release.mockClear();
  picker.onPicked = null;
  const file = {
    id: "late-pick",
    type: "file" as const,
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4,
    fileUri: "file:///documents/late-pick.pdf",
  };
  const picked = Promise.withResolvers<ReadonlyArray<typeof file>>();
  const view = await render(<GoatBotScreen visible />);
  const onPicked = picker.onPicked;
  if (!onPicked) throw new Error("expected attachment picker");
  const completion = picked.promise.then(onPicked);
  await view.unmount();
  await act(async () => {
    picked.resolve([file]);
    await completion;
  });
  expect(isComposerAttachmentFileRetained(file.fileUri)).toBe(false);
  expect(picker.release).toHaveBeenCalledWith([file]);
});

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

it("keeps answer chips and the send button off the retired blue message palette", async () => {
  appearance.mode = "dark";
  const rowView = await render(<GoatBotTimelineRow {...props} row={{ ...bot, tone: "reply" }} />);
  const chip = rowView.container.querySelector("button");
  expect(chip?.getAttribute("aria-label")).toBe("A. Try again");
  expect(rowView.container.innerHTML).not.toMatch(/#2B66C6|#1466D0/i);
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
  expect(screenView.container.innerHTML).not.toMatch(/#2B66C6|#1466D0/i);
  await screenView.unmount();
});

it("marks what the bot said since the last read, and points up to it until the person catches up", async () => {
  const reply = (id: string, createdAt: string): GoatBotRow => ({
    ...bot,
    id,
    createdAt,
    tone: "reply",
    options: [],
  });
  const opened = [
    reply("read", "2026-11-11T10:00:00Z"),
    reply("new-1", "2026-11-11T10:05:00Z"),
    reply("new-2", "2026-11-11T10:06:00Z"),
  ];
  screenSession.rows = opened;
  const snapshot = { key: "env:bot:1", readUpTo: "2026-11-11T10:01:00Z" };
  const ids = () => ((list.props?.data ?? []) as GoatBotRow[]).map((row) => row.id);
  const pill = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>(
      '[aria-label="2 new messages, scrolls to the first"]',
    );
  const view = await render(<GoatBotScreen visible readSnapshot={snapshot} />);
  try {
    // A reply that arrives while the person is in the chat is read as it comes.
    screenSession.rows = [...opened, reply("live", "2026-11-11T10:20:00Z")];
    await view.rerender(<GoatBotScreen visible readSnapshot={snapshot} />);
    expect(ids()).toEqual(["read", "unread-divider", "new-1", "new-2", "live"]);
    expect(pill(view.container)).toBeNull();
    const viewable = list.props?.onViewableItemsChanged as (info: {
      viewableItems: { index: number }[];
    }) => void;
    await act(async () => viewable({ viewableItems: [{ index: 3 }, { index: 4 }] }));
    expect(pill(view.container)).not.toBeNull();
    await act(async () => pill(view.container)?.click());
    expect(list.scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, viewPosition: 0 }),
    );
    expect(pill(view.container)).toBeNull();
    await typeInto(view.container, "Thanks");
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click(),
    );
    expect(ids()).not.toContain("unread-divider");
  } finally {
    await view.unmount();
  }

  // A task's own view keeps no read position.
  screenSession.supportsTaskThreads = true;
  const task = (await import("@goat/contracts")).ChannelTaskId.make("task-1");
  const taskView = await render(<GoatBotScreen visible taskId={task} readSnapshot={snapshot} />);
  expect(ids()).not.toContain("unread-divider");
  await taskView.unmount();
  screenSession.supportsTaskThreads = false;
  screenSession.rows = [];
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

it("shows the shared reader's reading and working text below the conversation", async () => {
  screenSession.activity = goatBotActivity({ reading: true, task: null, worker: null });
  const reading = await render(<GoatBotScreen visible />);
  expect(reading.container.textContent).toContain("Reading your message");
  await reading.unmount();

  screenSession.activity = { state: "working", text: "Run df -h" };
  const working = await render(<GoatBotScreen visible />);
  expect(working.container.textContent).toContain("Run df -h");
  expect(working.container.textContent).not.toContain("Reading your message");
  await working.unmount();

  screenSession.activity = null;
  const idle = await render(<GoatBotScreen visible />);
  expect(idle.container.textContent).not.toContain("Run df -h");
  await idle.unmount();
});

it("moves the progress line only while at least half of it shows, whatever moved the list", async () => {
  screenSession.activity = { state: "working", text: "Run df -h" };
  const view = await render(<GoatBotScreen visible />);
  try {
    const sweep = () => view.container.querySelector("[data-sweep]")?.getAttribute("data-sweep");
    const face = () => view.container.querySelector("[data-face]")?.getAttribute("data-face");
    const on = list.props as unknown as {
      onLayout: LayoutHandler;
      onContentSizeChange: (width: number, height: number) => void;
      onScroll: (event: {
        nativeEvent: {
          contentOffset: { y: number };
          contentSize: { height: number };
          layoutMeasurement: { height: number };
        };
      }) => void;
    };
    const scrollTo = (y: number, height = 2000) =>
      act(async () =>
        on.onScroll({
          nativeEvent: {
            contentOffset: { y },
            contentSize: { height },
            layoutMeasurement: { height: 600 },
          },
        }),
      );
    // Nothing moves before the line and the list are measured.
    expect(sweep()).toBe("false");
    expect(face()).toBe("working:false");
    await act(async () => on.onLayout({ nativeEvent: { layout: { height: 600 } } }));
    await act(async () => on.onContentSizeChange(393, 2000));
    await act(async () =>
      layouts.get("goat-bot-progress-line")?.({ nativeEvent: { layout: { height: 40 } } }),
    );
    await scrollTo(1400);
    expect(sweep()).toBe("true");
    expect(face()).toBe("working:true");
    // Scrolled up a screen.
    await scrollTo(800);
    expect(sweep()).toBe("false");
    expect(face()).toBe("working:false");
    await scrollTo(1400);
    expect(sweep()).toBe("true");
    // A new message grows the content below a resting position.
    await act(async () => on.onContentSizeChange(393, 2300));
    expect(sweep()).toBe("false");
    await scrollTo(1700, 2300);
    expect(sweep()).toBe("true");
    // The keyboard shrinks the viewport so the line falls below it.
    await act(async () => on.onLayout({ nativeEvent: { layout: { height: 300 } } }));
    expect(sweep()).toBe("false");
  } finally {
    screenSession.activity = null;
    await view.unmount();
  }
});

it("keeps the progress line in the label text role at larger text sizes", async () => {
  screenSession.activity = { state: "working", text: "Run df -h" };
  const styleAt = async (baseFontSize: number) => {
    appearance.baseFontSize = baseFontSize;
    const view = await render(<GoatBotScreen visible />);
    const style = JSON.parse(
      view.container.querySelector("[data-sweep]")?.getAttribute("data-style") ?? "null",
    ) as { fontSize?: number } | null;
    await view.unmount();
    return style?.fontSize;
  };
  try {
    const regular = await styleAt(16);
    const large = await styleAt(20);
    expect(regular).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(regular ?? 0);
  } finally {
    appearance.baseFontSize = 16;
    screenSession.activity = null;
  }
});

it("opens the conversation at its newest message and keeps following it", async () => {
  const view = await render(<GoatBotScreen visible />);
  // Without initialScrollAtEnd a long conversation opened at its oldest message.
  expect(list.props).toMatchObject({
    initialScrollAtEnd: true,
    maintainScrollAtEnd: true,
    alignItemsAtEnd: true,
  });
  await view.unmount();
});

it("ignores an unsupported task screen and uses main-chat filtering", async () => {
  screenSession.supportsTaskThreads = false;
  const task = (await import("@goat/contracts")).ChannelTaskId.make("task-1");
  const view = await render(<GoatBotScreen visible taskId={task} />);
  expect(screenSession.workTaskId).toBeUndefined();
  await view.unmount();
  const main = await render(<GoatBotScreen visible />);
  expect(screenSession.requestedTaskId).toBeNull();
  await main.unmount();
});

it("renders legacy task cards without task navigation when the capability is absent", async () => {
  screenSession.supportsTaskThreads = false;
  screenSession.rows = [
    {
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
    },
  ];
  const view = await render(<GoatBotScreen visible />);
  expect(view.container.textContent).toContain("Check disks");
  expect(view.container.textContent).toContain("Running");
  expect(view.container.textContent).not.toContain("Task thread ·");
  await view.unmount();
  screenSession.rows = [];
});

it("shows in the main chat the work cards the shared rows keep there", async () => {
  screenSession.supportsTaskThreads = true;
  const reply = (id: string, groupPosition: "first" | "last"): GoatBotRow => ({
    ...bot,
    id,
    tone: "reply",
    options: [],
    firstInGroup: groupPosition === "first",
    groupPosition,
  });
  screenSession.rows = [
    reply("ack", "first"),
    {
      kind: "task",
      id: "card",
      createdAt: "2026-10-12T09:40:00Z",
      firstInGroup: false,
      groupPosition: "last",
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
    },
  ];
  const view = await render(<GoatBotScreen visible />);
  try {
    // A card the rows keep is work the home cannot open, or whose ending the chat never told.
    expect(view.container.textContent).toContain("Check disks");
    expect(((list.props?.data ?? []) as GoatBotRow[]).map((row) => row.id)).toEqual([
      "ack",
      "card",
    ]);
    expect(screenSession.chatTasks.map((card) => card.key)).toEqual(["task-1"]);
  } finally {
    await view.unmount();
    screenSession.rows = [];
    screenSession.supportsTaskThreads = false;
  }
});

it("shows a task chip in the task header only when one exists", async () => {
  const task = (await import("@goat/contracts")).ChannelTaskId.make("task-1");
  screenSession.supportsTaskThreads = true;
  screenSession.rows = [
    {
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
        summary: "Disk summary",
        attentionLabel: null,
        pullRequests: [],
        target: { kind: "none", label: "Unavailable" },
      },
    },
  ];
  const view = await render(<GoatBotScreen visible taskId={task} />);
  expect(view.container.querySelector('[aria-label="Task header"]')?.textContent).toContain(
    "Disk summary",
  );
  expect(list.props?.data).toEqual([]);
  await view.unmount();
  screenSession.rows = [];
  const empty = await render(<GoatBotScreen visible taskId={task} />);
  expect(empty.container.querySelector('[aria-label="Task header"]')?.textContent).not.toContain(
    "Disk summary",
  );
  await empty.unmount();
  screenSession.supportsTaskThreads = false;
});
