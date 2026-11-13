import "./goatBotScreenTestHarness";
import { act } from "react";
import {
  goatBotActivity,
  type GoatBotActivity,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

import {
  a11y,
  appearance,
  bot,
  layouts,
  list,
  models,
  picker,
  props,
  render,
  screenSession,
  typeInto,
  type LayoutHandler,
} from "./goatBotScreenTestHarness";
import { GoatBotScreen, GoatBotTimelineRow } from "./GoatBotScreen";
import { isComposerAttachmentFileRetained } from "../../lib/composerAttachmentFiles";
vi.mock("../../lib/appState", () => ({
  useAppActive: () => true,
  useReduceMotionEnabled: () => false,
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => screenSession.faceShell }));
vi.mock("../../state/use-thread-detail", () => ({ useThreadVisibleTurnItems: () => [] }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: null }),
}));

it("shows the bot's waiting state in the Home hero", async () => {
  screenSession.activity = {
    state: "working",
    text: "Waiting for you",
    attention: "waiting",
    wait: "you",
  };
  screenSession.faceShell = {
    source: { pendingRuntimeRequest: { kind: "approval", blocking: true } },
  };
  const view = await render(<GoatBotScreen visible />);
  expect(
    view.container.querySelector('[aria-label="Task header"] [data-avatar="waiting"]'),
  ).not.toBeNull();
  await view.unmount();
  screenSession.activity = null;
  screenSession.faceShell = null;
});

it("shows a member's initial and accent in the Home hero", async () => {
  const scout = {
    botId: "scout",
    name: "Scout",
    role: "member",
    color: "#2F6FED",
    avatar: null,
    environmentId: "env",
    sessionThreadId: "scout-thread",
    state: "active",
  } as unknown as import("@goat/contracts").BotProfile;
  const view = await render(<GoatBotScreen visible member={scout} />);
  const hero = view.container.querySelector('[aria-label="Task header"] [data-avatar]');
  expect(hero?.getAttribute("data-avatar-emoji")).toBe("S");
  expect(hero?.getAttribute("data-avatar-accent")).toBe("#2F6FED");
  await view.unmount();
});

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
  await typeInto(screenView.container, "Hello");
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

it("shows Send only once there is something to send", async () => {
  const view = await render(<GoatBotScreen visible />);
  const send = () => view.container.querySelector('[aria-label="Send message"]');
  expect(send()).toBeNull();
  await typeInto(view.container, "Hello");
  expect(send()).not.toBeNull();
  await typeInto(view.container, "   ");
  expect(send()).toBeNull();
  await view.unmount();
});

it("puts the bot's model in the composer, opening a member's menu even when it cannot change", async () => {
  const select = vi.fn();
  models.main = {
    label: "gpt-6-luna",
    accessibilityLabel: "GOAT Bot model: gpt-6-luna",
    items: [],
    disabled: true,
    select,
  };
  const main = await render(<GoatBotScreen visible />);
  const pill = () => main.container.querySelector('[aria-label="GOAT Bot model: gpt-6-luna"]');
  expect(pill()?.textContent).toBe("gpt-6-luna");
  // A main model that cannot change does not open a menu.
  expect(pill()?.hasAttribute("disabled")).toBe(true);
  expect(pill()?.closest('[data-box="model-menu"]')).toBeNull();
  await main.unmount();

  models.member = {
    label: "claude-opus",
    accessibilityLabel: "Scout model: claude-opus",
    title: "You can't change Scout's model",
    canChange: false,
    items: [],
    select,
  };
  const scout = {
    botId: "scout",
    name: "Scout",
    environmentId: "env",
    sessionThreadId: "scout-thread",
    state: "active",
    avatar: null,
  } as unknown as import("@goat/contracts").BotProfile;
  const member = await render(<GoatBotScreen visible member={scout} />);
  const memberPill = member.container.querySelector('[aria-label="Scout model: claude-opus"]');
  expect(memberPill?.textContent).toBe("claude-opus");
  expect(memberPill?.hasAttribute("disabled")).toBe(false);
  expect(memberPill?.closest('[data-box="model-menu"]')).not.toBeNull();
  await member.unmount();
  models.main = null;
  models.member = null;
});

it("opens the bot's home from the header chip, which a task's own screen does not have", async () => {
  const chat = await render(<GoatBotScreen visible />);
  const chip = chat.container.querySelector<HTMLButtonElement>('[aria-label="Chip GOAT Bot"]');
  expect(screenSession.homeOpen).toBe(false);
  await act(async () => chip?.click());
  expect(screenSession.homeOpen).toBe(true);
  await chat.unmount();

  screenSession.supportsTaskThreads = true;
  const task = (await import("@goat/contracts")).ChannelTaskId.make("task-1");
  const taskView = await render(<GoatBotScreen visible taskId={task} />);
  expect(taskView.container.querySelector('[aria-label="Chip GOAT Bot"]')).toBeNull();
  await taskView.unmount();
  screenSession.supportsTaskThreads = false;
});

it("tells VoiceOver once per wait on the person or a usage limit, however the wait is reworded, and never for other work", async () => {
  a11y.announce.mockClear();
  screenSession.activity = { state: "working", text: "Copying files" };
  const view = await render(<GoatBotScreen visible />);
  const liveLabel = () => view.container.querySelector("[data-live]")?.getAttribute("aria-label");
  const show = async (activity: GoatBotActivity) => {
    screenSession.activity = activity;
    await view.rerender(<GoatBotScreen visible />);
  };
  try {
    // The same wait, reworded as more is known while it streams: heard once, and TalkBack's live
    // label does not change.
    await show({ state: "working", text: "Waiting for you", attention: "waiting", wait: "you" });
    const firstLabel = liveLabel();
    await show({
      state: "working",
      text: "Waiting for your answer",
      attention: "waiting",
      wait: "you",
    });
    await show({
      state: "working",
      text: "Waiting for your answer on the cache",
      attention: "waiting",
      wait: "you",
    });
    expect(liveLabel()).toBe(firstLabel);
    expect(firstLabel).toBe("GOAT Bot is waiting for you");
    await show({
      state: "working",
      text: "Paused on a usage limit",
      attention: "paused",
      wait: "usage_limit",
    });
    expect(a11y.announce.mock.calls.map((call) => call[0])).toEqual([
      "GOAT Bot is waiting for you",
      "GOAT Bot is paused on a usage limit",
    ]);
    // Waiting on other work reads as working; so does a task update that only sounds like a wait.
    a11y.announce.mockClear();
    await show({ state: "working", text: "Waiting on other work", wait: "other_work" });
    expect(liveLabel()).toBe("GOAT Bot is working");
    expect(view.container.querySelector("[data-face]")?.getAttribute("data-face")).toMatch(
      /^working:/,
    );
    for (const text of ["Waiting for your answer", "Waiting… the build is green"])
      await show({ state: "working", text });
    expect(a11y.announce).not.toHaveBeenCalled();
    expect(liveLabel()).toBe("GOAT Bot is working");
  } finally {
    screenSession.activity = null;
    await view.unmount();
  }
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

it("announces only whether the bot works, reads or waits, not every step it takes", async () => {
  const live = async (activity: GoatBotActivity) => {
    screenSession.activity = activity;
    const view = await render(<GoatBotScreen visible />);
    const region = view.container.querySelector("[data-live]");
    const result = {
      label: region?.getAttribute("aria-label"),
      holdsStep: region?.textContent?.includes(activity.text) ?? false,
      showsStep: view.container.textContent?.includes(activity.text) ?? false,
    };
    await view.unmount();
    return result;
  };
  try {
    const first = await live({ state: "working", text: "Copying files" });
    const second = await live({ state: "working", text: "Run df -h" });
    expect(first).toEqual({ label: "GOAT Bot is working", holdsStep: false, showsStep: true });
    expect(second.label).toBe(first.label);
    expect((await live({ state: "reading", text: "Reading" })).label).toBe("GOAT Bot is reading");
    // A wait is said by what it waits on, so moving from one kind of wait to another is heard.
    expect(
      (await live({ state: "working", text: "Waiting for your answer", wait: "you" })).label,
    ).toBe("GOAT Bot is waiting for you");
    expect(
      (await live({ state: "working", text: "Paused on a usage limit", wait: "usage_limit" }))
        .label,
    ).toBe("GOAT Bot is paused on a usage limit");
    expect(
      (await live({ state: "working", text: "Waiting on other work", wait: "other_work" })).label,
    ).toBe("GOAT Bot is working");
  } finally {
    screenSession.activity = null;
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

it("shows a task chip in the task header only when one exists, without the status it states", async () => {
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
  // The task's status comes from the current list; the chat card's own may be stale.
  expect(view.container.querySelector('[aria-label="Task header"]')?.textContent).not.toContain(
    "Running",
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

it("keeps Send in the composer row beside the real model pill with a long name, at its full size", async () => {
  models.main = {
    label: "a-very-long-provider/model-name-that-does-not-fit-a-narrow-phone",
    accessibilityLabel: "GOAT Bot model",
    items: [],
    disabled: false,
    select: vi.fn(),
  };
  const view = await render(<GoatBotScreen visible />);
  try {
    await typeInto(view.container, "Check the disks");
    const send = view.container.querySelector('[aria-label="Send message"]');
    const row = send?.parentElement;
    const menu = row?.querySelector('[data-box="model-menu"]');
    const pill = menu?.querySelector('[aria-label="GOAT Bot model"]');
    expect(pill?.textContent).toContain("a-very-long-provider");
    // Everything from the row down to the one-line label gives way, so the label truncates.
    expect(JSON.parse(menu?.getAttribute("data-style") ?? "null")).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
    });
    for (const node of [pill, ...(pill?.querySelectorAll("[data-class]") ?? [])])
      expect(node?.getAttribute("data-class")).toContain("shrink");
    // The pill comes before Send in the same row, and Send keeps its 44-point target.
    expect(row?.lastElementChild).toBe(send);
    expect(JSON.parse(send?.getAttribute("data-style") ?? "null")).toMatchObject({
      width: 44,
      height: 44,
    });
    expect(JSON.parse(send?.getAttribute("data-style") ?? "null").flexShrink ?? 0).toBe(0);
  } finally {
    await view.unmount();
    models.main = null;
  }
});

it("draws the person's messages and Send in a member bot's color, with text that reads on it", async () => {
  const you: GoatBotRow = {
    kind: "user",
    id: "you",
    text: "Check the disks",
    createdAt: "2026-11-11T10:00:00Z",
    firstInGroup: true,
    groupPosition: "single",
    sendKey: null,
    requestKey: null,
    delivery: { state: "sent" },
    showReceipt: false,
  } as GoatBotRow;
  const member = (color: string | undefined) =>
    ({
      botId: "scout",
      name: "Scout",
      role: "member",
      environmentId: "env",
      sessionThreadId: "scout-thread",
      state: "active",
      avatar: null,
      ...(color === undefined ? {} : { color }),
    }) as unknown as import("@goat/contracts").BotProfile;
  const colors = async (bot: import("@goat/contracts").BotProfile | undefined) => {
    screenSession.rows = [you];
    const view = await render(<GoatBotScreen visible member={bot} />);
    await typeInto(view.container, "More");
    const text = [...view.container.querySelectorAll("span")].find(
      (node) => node.textContent === "Check the disks",
    );
    const pill = [...view.container.querySelectorAll("div[data-style]")].find(
      (node) =>
        JSON.parse(node.getAttribute("data-style") ?? "null")?.borderRadius === 20 &&
        node.contains(text ?? null),
    );
    const send = view.container.querySelector('[aria-label="Send message"]');
    const result = {
      pill: JSON.parse(pill?.getAttribute("data-style") ?? "null")?.backgroundColor,
      text: JSON.parse(text?.getAttribute("data-style") ?? "null")?.color,
      send: JSON.parse(send?.querySelector("div")?.getAttribute("data-style") ?? "null")
        ?.backgroundColor,
    };
    await view.unmount();
    screenSession.rows = [];
    return result;
  };
  expect(await colors(member("#1d3a8a"))).toEqual({
    pill: "#1D3A8A",
    text: "#FFFFFF",
    send: "#1D3A8A",
  });
  expect((await colors(member("#D9A21B"))).text).toBe("#000000");
  // The main bot and a member without a color keep the theme's neutral.
  expect(await colors(undefined)).toEqual({ pill: undefined, text: undefined, send: undefined });
  expect(await colors(member(undefined))).toEqual({
    pill: undefined,
    text: undefined,
    send: undefined,
  });
});

it("redraws messages already shown when the member's color changes, and keeps attachment labels fully opaque on it", async () => {
  const you = {
    kind: "user",
    id: "you",
    text: "Here",
    attachments: [{ id: "a1", type: "file", name: "notes.txt" }],
    createdAt: "2026-11-11T10:00:00Z",
    firstInGroup: true,
    groupPosition: "single",
    sendKey: null,
    requestKey: null,
    delivery: { state: "sent" },
    showReceipt: false,
  } as unknown as GoatBotRow;
  const member = (color: string) =>
    ({
      botId: "scout",
      name: "Scout",
      role: "member",
      environmentId: "env",
      sessionThreadId: "scout-thread",
      state: "active",
      avatar: null,
      color,
    }) as unknown as import("@goat/contracts").BotProfile;
  screenSession.rows = [you];
  const view = await render(<GoatBotScreen visible member={member("#1D3A8A")} />);
  try {
    const first = list.props?.extraData;
    expect(first).toBeDefined();
    // A fresh profile object with the same color keeps the rows as they are.
    await view.rerender(<GoatBotScreen visible member={member("#1d3a8a")} />);
    expect(list.props?.extraData).toBe(first);
    await view.rerender(<GoatBotScreen visible member={member("#D9A21B")} />);
    expect(list.props?.extraData).not.toBe(first);
    const label = [...view.container.querySelectorAll("span")].find((node) =>
      node.textContent?.includes("notes.txt"),
    );
    expect(JSON.parse(label?.getAttribute("data-style") ?? "{}").opacity ?? 1).toBe(1);
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});

it("fills a picked answer's badge with a member bot's color, with a letter that reads on it", async () => {
  const answered: GoatBotRow = {
    ...bot,
    id: "asked",
    text: "Which project?",
    tone: "question",
    options: [],
    choices: ["server", "web"],
    answer: "web",
    answerIndex: 1,
  };
  const scout = {
    botId: "scout",
    name: "Scout",
    role: "member",
    environmentId: "env",
    sessionThreadId: "scout-thread",
    state: "active",
    avatar: null,
    color: "#1d3a8a",
  } as unknown as import("@goat/contracts").BotProfile;
  screenSession.rows = [answered];
  const view = await render(<GoatBotScreen visible member={scout} />);
  try {
    const letter = [...view.container.querySelectorAll("span")].find(
      (node) => node.textContent === "B",
    );
    const badge = letter?.parentElement;
    expect(JSON.parse(badge?.getAttribute("data-style") ?? "null")).toMatchObject({
      backgroundColor: "#1D3A8A",
    });
    expect(JSON.parse(letter?.getAttribute("data-style") ?? "null")).toMatchObject({
      color: "#FFFFFF",
    });
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});
