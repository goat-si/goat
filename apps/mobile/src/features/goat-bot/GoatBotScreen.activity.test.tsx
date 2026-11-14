import "./goatBotScreenTestHarness";
import { RegistryContext } from "@effect/atom-react";
import {
  buildGoatBotTimeline,
  goatBotActivityPlacement,
  goatBotActivityRowTurns,
  goatBotActivitySources,
  goatBotItemReaders,
  goatBotSourceSteps,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import {
  type BotProfile,
  ChannelTaskId,
  EnvironmentId,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { act, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { chatFiles, list, render, screenSession, threadReads } from "./goatBotScreenTestHarness";
import { GoatBotScreen } from "./GoatBotScreen";
// Loads the thread-state stand-in, so its fixture atoms exist before any reader asks.
import "../../state/threads";

// Stored-shape items, as the server keeps them: the bot conversation and a session's steps.
const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const at = (second: number) => `2026-11-12T03:00:${String(second).padStart(2, "0")}.000Z`;
const SESSION = "goat-bot-session:a";
const WORKER = "channel-worker:t1";
const projected = (json: object): OrchestrationV2ProjectedTurnItem => {
  const item = decode(json);
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
};
const base = (threadId: string, id: string, second: number, extra: object = {}) => ({
  id,
  threadId,
  runId: threadId === "bot" ? null : "run-1",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: at(second),
  completedAt: at(second),
  updatedAt: at(second),
  ...extra,
});
const meta = { conversationId: "conv-1", originKind: "goat" };
const said = (id: string, second: number) =>
  projected({
    ...base("bot", id, second),
    type: "user_message",
    messageId: "m-" + id,
    inputIntent: "turn_start",
    text: "Message " + id,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    channel: { ...meta, kind: "inbound", inputId: "in-" + id, readAt: at(second) },
  });
const replied = (id: string, second: number, taskId: string, taskGeneration?: number) =>
  projected({
    ...base("bot", id, second),
    type: "assistant_message",
    messageId: "m-" + id,
    text: "Reply " + id,
    streaming: false,
    channel: {
      ...meta,
      kind: "result",
      taskId,
      ...(taskGeneration === undefined ? {} : { taskGeneration }),
    },
  });
const chip = (
  taskId: string,
  second: number,
  worker: object,
  fields: { status?: string; kind?: string; createdAt?: number; generation?: number } = {},
) =>
  projected({
    ...base("bot", "chip-" + taskId + "-" + second, second),
    type: "notification",
    source: { kind: "background_task" },
    outcome: "updated",
    summary: "Work updated",
    ledgerTask: {
      taskId,
      kind: fields.kind ?? "turn",
      conversationId: "conv-1",
      taskVersion: second,
      title: "Work " + taskId,
      status: fields.status ?? "completed",
      originKind: "goat",
      requesterLabel: "Jun",
      createdAt: at(fields.createdAt ?? second),
      updatedAt: at(second),
      worker,
      openQuestionCount: 0,
      ...(fields.generation === undefined ? {} : { generation: fields.generation }),
    },
  });
const here = (threadId: string) => ({ environmentId: "env", threadId, runId: "run-1" });
const ran = (id: string, second: number, thread = SESSION, extra: object = {}) =>
  projected({
    ...base(thread, id, second, extra),
    type: "command_execution",
    input: "vp test " + id,
    commandActions: [],
    exitCode: 0,
  });
const read = (id: string, second: number) =>
  projected({
    ...base(SESSION, id, second),
    type: "command_execution",
    input: "cat " + id,
    commandActions: [{ type: "read", path: id + ".ts" }],
    exitCode: 0,
  });

let registry = AtomRegistry.make();
function setup() {
  registry = AtomRegistry.make();
  Object.assign(screenSession, {
    rows: [],
    visibleTurnItems: [],
    boundedSnapshots: true,
    environmentId: "env",
    threadId: "bot",
    supportsTaskThreads: false,
    activity: null,
  });
  list.unmounted.clear();
  chatFiles.cardMounts = 0;
  threadReads.held.length = 0;
  threadReads.released.length = 0;
}
function rowsOf(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>, taskId?: string) {
  return buildGoatBotTimeline({
    visibleTurnItems: items,
    pendingInputs: [],
    readers: goatBotItemReaders,
    ...(taskId === undefined ? {} : { taskId }),
    conversationOnly: screenSession.supportsTaskThreads,
    answerReferences: true,
  });
}
/** The conversation as the session derives it, rows and items together. */
function conversation(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>, taskId?: string) {
  screenSession.visibleTurnItems = items;
  screenSession.rows = rowsOf(items, taskId) as GoatBotRow[];
}
const steps = (thread: string, items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) =>
  act(() => registry.set(threadReads.itemsAtom!("env\u0000" + thread), items));
const key = (thread: string) => "env\u0000" + thread;
async function mount(element: ReactNode) {
  const view = await render(
    <RegistryContext.Provider value={registry}>{element}</RegistryContext.Provider>,
  );
  return {
    ...view,
    rerender: (next: ReactNode) =>
      view.rerender(<RegistryContext.Provider value={registry}>{next}</RegistryContext.Provider>),
  };
}
const line = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>("button[data-hint]");
const press = (button: HTMLButtonElement | null) => act(async () => button?.click());
const cell = (container: HTMLElement, rowId: string) =>
  container.querySelector(`[data-row="${rowId}"]`);

const answered = [said("u1", 0), chip("c1", 1, here(SESSION)), replied("r1", 20, "c1")];
const work = [read("a", 3), ran("c1", 5), ran("c2", 6)];

it("shows a counted line directly above the reply its work led to, which opens to the steps", async () => {
  setup();
  conversation(answered);
  await steps(SESSION, work);
  // The reply is new since the last read, so the "New" line sits between it and its work.
  const readSnapshot = { key: "env:bot:1", readUpTo: at(10), newestAtOpen: at(20) };
  const view = await mount(<GoatBotScreen visible readSnapshot={readSnapshot} />);
  try {
    const button = line(view.container);
    expect(button?.textContent).toBe("Read 1 file and ran 2 commands");
    expect(cell(view.container, "r1")?.contains(button)).toBe(true);
    expect(view.container.querySelectorAll("button[data-hint]")).toHaveLength(1);
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    await press(button);
    expect(line(view.container)?.getAttribute("aria-expanded")).toBe("true");
    expect(line(view.container)?.getAttribute("data-hint")).toBe("Hides the steps");
    expect(cell(view.container, "r1")?.textContent).toContain("vp test c2");
    await press(line(view.container));
    expect(line(view.container)?.getAttribute("aria-expanded")).toBe("false");
    expect(cell(view.container, "r1")?.textContent).not.toContain("vp test c2");
  } finally {
    await view.unmount();
  }
});

it("trails a running turn's steps above the progress line, then moves them above the reply", async () => {
  setup();
  conversation([said("u1", 0), chip("c1", 1, here(SESSION), { status: "running" })]);
  screenSession.activity = { state: "working", text: "Working" };
  await steps(SESSION, [ran("c1", 5)]);
  const view = await mount(<GoatBotScreen visible />);
  try {
    const trailing = line(view.container);
    expect(trailing?.textContent).toBe("Ran 1 command so far");
    expect(trailing?.closest("[data-row]")).toBeNull();
    // Only the progress line is measured for its motion; the trailing line sits above it.
    const progress = view.container.querySelector('[data-testid="goat-bot-progress-line"]');
    expect(progress?.contains(trailing)).toBe(false);
    expect(
      trailing!.compareDocumentPosition(progress!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    conversation([
      said("u1", 0),
      chip("c1", 21, here(SESSION), { createdAt: 1 }),
      replied("r1", 20, "c1"),
    ]);
    screenSession.activity = null;
    await view.rerender(<GoatBotScreen visible />);
    expect(line(view.container)?.textContent).toBe("Ran 1 command");
    expect(cell(view.container, "r1")?.contains(line(view.container))).toBe(true);
  } finally {
    await view.unmount();
  }
});

it("reads the steps only while the chat shows, and lets go while an image covers it, keeping open lines open", async () => {
  setup();
  conversation(answered);
  await steps(SESSION, work);
  const view = await mount(<GoatBotScreen visible={false} />);
  try {
    expect(threadReads.held).not.toContain(key(SESSION));
    expect(line(view.container)).toBeNull();
    await view.rerender(<GoatBotScreen visible />);
    expect(threadReads.held).toEqual([key(SESSION)]);
    await press(line(view.container));
    expect(line(view.container)?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => chatFiles.opener?.open({ relativePath: "chart.png" }));
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(threadReads.released).toEqual([key(SESSION)]);
    expect(line(view.container)).toBeNull();
    const close = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Close",
    );
    await press(close ?? null);
    expect(threadReads.held).toEqual([key(SESSION), key(SESSION)]);
    expect(line(view.container)?.getAttribute("aria-expanded")).toBe("true");

    // A task screen pushed over the chat, then popped.
    await view.rerender(<GoatBotScreen visible={false} />);
    expect(threadReads.released).toHaveLength(2);
    await view.rerender(<GoatBotScreen visible />);
    expect(line(view.container)?.getAttribute("aria-expanded")).toBe("true");
  } finally {
    await view.unmount();
  }
});

it("keeps a line open when its cell scrolls away and back, keeps each conversation's open lines, and updates it when only the steps change", async () => {
  setup();
  conversation(answered);
  await steps(SESSION, work);
  const view = await mount(<GoatBotScreen visible />);
  try {
    await press(line(view.container));
    list.unmounted.add("r1");
    await view.rerender(<GoatBotScreen visible />);
    expect(line(view.container)).toBeNull();
    list.unmounted.delete("r1");
    await view.rerender(<GoatBotScreen visible />);
    expect(line(view.container)?.getAttribute("aria-expanded")).toBe("true");

    // A new step arrives while the rows stay the same objects: the list still redraws the line.
    await steps(SESSION, [...work, ran("c3", 7)]);
    expect(line(view.container)?.textContent).toBe("Read 1 file and ran 3 commands");

    // Another conversation starts closed, and opening a line there keeps this one's open.
    screenSession.threadId = "bot-2";
    await view.rerender(<GoatBotScreen visible />);
    expect(line(view.container)?.getAttribute("aria-expanded")).toBe("false");
    await press(line(view.container));
    screenSession.threadId = "bot";
    await view.rerender(<GoatBotScreen visible />);
    expect(line(view.container)?.getAttribute("aria-expanded")).toBe("true");
  } finally {
    await view.unmount();
  }
});

it("never mounts a reply's row again when its line arrives, or when the app goes to the background and back", async () => {
  setup();
  conversation(answered);
  const view = await mount(<GoatBotScreen visible foreground />);
  try {
    expect(chatFiles.cardMounts).toBe(1);
    expect(line(view.container)).toBeNull();
    await steps(SESSION, work);
    expect(line(view.container)?.textContent).toBe("Read 1 file and ran 2 commands");
    // In the background the session is let go of, and taken again on return.
    const held = threadReads.held.length;
    const released = threadReads.released.length;
    await view.rerender(<GoatBotScreen visible foreground={false} />);
    expect(threadReads.released).toHaveLength(released + 1);
    expect(line(view.container)).toBeNull();
    await view.rerender(<GoatBotScreen visible foreground />);
    expect(threadReads.held).toHaveLength(held + 1);
    expect(line(view.container)).not.toBeNull();
    expect(chatFiles.cardMounts).toBe(1);
  } finally {
    await view.unmount();
  }
});

it("in a task's view, puts the worker's steps above the next row it draws: not the hidden card, not an earlier attempt's late outcome", async () => {
  setup();
  screenSession.supportsTaskThreads = true;
  const worker = { environmentId: "env", threadId: WORKER };
  const items = [
    said("u1", 0),
    replied("r-start", 2, "t1", 2),
    chip("t1", 6, worker, { kind: "work", status: "running", createdAt: 1, generation: 2 }),
    replied("r-old", 7, "t1", 1),
    replied("r2", 20, "t1", 2),
  ];
  conversation(items, "t1");
  const workerSteps = [ran("w1", 5, WORKER)];
  await steps(WORKER, workerSteps);
  // Placed among every row, the card itself would take the line.
  const unfiltered = goatBotActivityPlacement({
    rows: screenSession.rows,
    sources: goatBotActivitySources({
      visibleTurnItems: items,
      botEnvironmentId: EnvironmentId.make("env"),
      taskId: "t1",
      boundedSnapshots: true,
    }),
    steps: [goatBotSourceSteps(workerSteps, false)],
    rowTurns: goatBotActivityRowTurns(items),
  });
  const card = screenSession.rows.find((row) => row.kind === "task");
  expect(card && unfiltered.beforeRow.has(card.id)).toBe(true);
  const view = await mount(<GoatBotScreen visible taskId={ChannelTaskId.make("t1")} />);
  try {
    expect(threadReads.held).toEqual([key(WORKER)]);
    expect(cell(view.container, "r2")?.contains(line(view.container))).toBe(true);
    expect(cell(view.container, "r-old")?.querySelector("button[data-hint]")).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("reads no session on a server that sends whole threads, though work elsewhere is still named", async () => {
  setup();
  screenSession.boundedSnapshots = false;
  conversation([
    ...answered,
    said("u2", 30),
    chip("c2", 31, { environmentId: "other", threadId: "goat-bot-session:x", host: "laptop" }),
    replied("r2", 40, "c2"),
  ]);
  await steps(SESSION, work);
  const view = await mount(<GoatBotScreen visible />);
  try {
    expect(threadReads.held).toEqual([]);
    expect(line(view.container)).toBeNull();
    expect(view.container.textContent).toContain("Steps ran on laptop");
  } finally {
    await view.unmount();
  }
});

it("names collapsed earlier work in plain text that does not open", async () => {
  setup();
  conversation(answered);
  await steps(SESSION, [
    projected({
      ...base(SESSION, "anchor", 2),
      type: "reasoning",
      text: "Hmm",
      streaming: false,
      deferredWork: { cursor: "c", itemCount: 151, lastOrdinal: 150 },
    }),
  ]);
  const view = await mount(<GoatBotScreen visible />);
  try {
    expect(cell(view.container, "r1")?.textContent).toContain("Earlier work");
    expect(line(view.container)).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("shows a member bot's lines from its own session", async () => {
  setup();
  conversation(answered);
  await steps(SESSION, work);
  const member = {
    botId: "scout",
    name: "Scout",
    role: "member",
    environmentId: "env",
    sessionThreadId: "scout-thread",
    state: "active",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
  } as unknown as BotProfile;
  const view = await mount(<GoatBotScreen visible member={member} />);
  try {
    expect(line(view.container)?.textContent).toBe("Read 1 file and ran 2 commands");
  } finally {
    await view.unmount();
  }
});

vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));
