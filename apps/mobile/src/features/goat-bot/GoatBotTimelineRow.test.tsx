import { act } from "react";
import {
  buildGoatBotTimeline,
  type GoatBotMessagePresentation,
  type GoatBotPendingInput,
  type GoatBotRow,
  type GoatBotTaskCard,
} from "@goat/client-runtime/goatBot";
import { MessageId, type OrchestrationV2TurnItem, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";

const appearance = vi.hoisted(() => ({ mode: "light" as "light" | "dark", baseFontSize: 16 }));

// Event lines resolve their routine or task against the home's reads, which this test does not load.
// Chat file cards read the Library through the environment runtime; GoatBotTimelineRow.files.test covers them.
// Editing a member from its chat reads secure storage and bot permissions; these tests do not.
vi.mock("./MobileNewBotNameRow", () => ({
  useMobileBotEditing: () => ({ nameRow: null, editSheet: null, openEdit: undefined }),
}));
vi.mock("./GoatBotReplyFiles", () => ({
  GoatBotFilesProvider: (props: { children?: unknown }) => props.children,
  GoatBotReplyFiles: () => null,
}));
vi.mock("./useGoatBotEventTargets", () => ({
  useGoatBotEventTargets: () => ({ land: () => null, key: "" }),
}));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
vi.mock("./MobileBotWork", () => ({ MobileBotWork: () => null }));
vi.mock("./GoatBotFace", async () => {
  const { Text } = await import("react-native");
  return {
    GoatBotHeaderFace: () => null,
    GoatBotProgressFace: (props: { state: string; inView: boolean }) => (
      <Text>{`face:${props.state}:${props.inView}|`}</Text>
    ),
  };
});
vi.mock("./GoatBotShimmerText", async () => {
  const { Text } = await import("react-native");
  return {
    GoatBotShimmerText: (props: { label: string; animate: boolean }) => (
      <Text>{`shimmer:${props.label}:${props.animate}`}</Text>
    ),
  };
});
// The native Markdown renderer cannot load under Vitest; its source text stands in for it.
vi.mock("./GoatBotMarkdown", async () => {
  const { Text } = await import("react-native");
  return { GoatBotMarkdown: (props: { text: string }) => <Text>{`md[${props.text}]`}</Text> };
});
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
// The chat's step reader and file opener load the environment runtime.
vi.mock("../../state/threads", () => ({ environmentThreadDetails: {} }));
vi.mock("./openBotLibraryFile", () => ({ openBotLibraryFile: async () => null }));
vi.mock("./useMobileGoatBotSession", () => ({ useMobileGoatBotSession: () => ({}) }));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./useMobileGoatBotModel", () => ({ useMobileGoatBotModelMenu: () => null }));
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./GoatBotModelPill", () => ({ GoatBotModelPill: () => null }));
const clipboard = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => true) }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: clipboard.copy }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: appearance.mode,
    appearance: { baseFontSize: appearance.baseFontSize },
  }),
}));
import { GoatBotTimelineRow } from "./GoatBotScreen";
import { GoatBotActivityLine, goatBotTime } from "./GoatBotMessageParts";

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

it("labels the first of the bot's unprompted updates and leaves its replies unheaded", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(h, <GoatBotTimelineRow {...props} row={bot({ proactive: true })} />);
  await view.render();
  expect(view.container.textContent).toContain("GOAT Bot · Update");
  await view.rerender(<GoatBotTimelineRow {...props} row={bot({ proactive: false })} />);
  expect(view.container.textContent).not.toContain("GOAT Bot");
  await view.rerender(
    <GoatBotTimelineRow
      {...props}
      row={bot({ proactive: true, firstInGroup: false, groupPosition: "last" })}
    />,
  );
  expect(view.container.textContent).not.toContain("GOAT Bot");
});

it("shows the time under the last reply of a bot group, answered questions included", async () => {
  const time = goatBotTime("2026-10-12T09:40:00Z");
  h = createNativeMemoryHarness();
  view = renderNative(h, <GoatBotTimelineRow {...props} row={bot()} />);
  await view.render();
  expect(view.container.textContent).toContain(time);
  await view.rerender(
    <GoatBotTimelineRow {...props} row={bot({ answer: "Short", options: [] } as never)} />,
  );
  expect(view.container.textContent).toContain(time);
  await view.rerender(
    <GoatBotTimelineRow {...props} row={bot({ firstInGroup: true, groupPosition: "first" })} />,
  );
  expect(view.container.textContent).not.toContain(time);
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

it("ends a bot group with its time when the group's last row is a task card", async () => {
  const time = goatBotTime("2026-10-12T09:41:00Z");
  h = createNativeMemoryHarness();
  const task = (groupPosition: "last" | "middle"): GoatBotRow => ({
    kind: "task",
    id: "card",
    createdAt: "2026-10-12T09:41:00Z",
    firstInGroup: false,
    groupPosition,
    card: {
      key: "task-1",
      revision: 1,
      updatedAt: "2026-10-12T09:41:00Z",
      title: "Check disks",
      statusLabel: "Running",
      tone: "active",
      sourceLabel: null,
      summary: null,
      attentionLabel: null,
      pullRequests: [],
      target: { kind: "none", label: "Unavailable" },
    },
  });
  view = renderNative(h, <GoatBotTimelineRow {...props} row={task("last")} />);
  await view.render();
  expect(view.container.textContent).toContain(time);
  await view.rerender(<GoatBotTimelineRow {...props} row={task("middle")} />);
  expect(view.container.textContent).not.toContain(time);
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

describe("the progress line under the last message", () => {
  it("shows the working step beside a moving face, with no timer or disclosure", async () => {
    h = createNativeMemoryHarness();
    view = renderNative(
      h,
      <GoatBotActivityLine
        botName="GOAT Bot"
        activity={{ state: "working", text: "Copying files" }}
        inView
      />,
    );
    await view.render();
    expect(view.container.textContent).toBe("face:working:true|shimmer:Copying files:true");
  });

  it("reads with the reading face and the sweep", async () => {
    h = createNativeMemoryHarness();
    view = renderNative(
      h,
      <GoatBotActivityLine
        botName="GOAT Bot"
        activity={{ state: "reading", text: "Reading your message" }}
        inView
      />,
    );
    await view.render();
    expect(view.container.textContent).toBe("face:reading:true|shimmer:Reading your message:true");
  });

  it("holds a wait on the person still: the waiting face and plain text", async () => {
    h = createNativeMemoryHarness();
    view = renderNative(
      h,
      <GoatBotActivityLine
        botName="GOAT Bot"
        activity={{
          state: "working",
          text: "Waiting for your answer",
          attention: "waiting",
          wait: "you",
        }}
        inView
      />,
    );
    await view.render();
    expect(view.container.textContent).toBe("face:waiting:true|Waiting for your answer");
  });

  it("stops the face and the sweep when the line is out of view", async () => {
    h = createNativeMemoryHarness();
    view = renderNative(
      h,
      <GoatBotActivityLine
        botName="GOAT Bot"
        activity={{ state: "working", text: "Copying files" }}
        inView={false}
      />,
    );
    await view.render();
    expect(view.container.textContent).toBe("face:working:false|shimmer:Copying files:false");
  });
});

it("asks a question in one card with lettered choices and sends the pick to its task", async () => {
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
  expect(
    [...view.container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    ),
  ).toEqual(["A. Yes", "B. Later", "Something else"]);
  await view.click("B. Later");
  // An older server names no question, so the pick goes to the task alone.
  expect(onSend).toHaveBeenCalledWith("Later", "task-1", undefined);
});

it("ends an open question with a Something else row that hands over to the composer", async () => {
  h = createNativeMemoryHarness();
  const onSomethingElse = vi.fn();
  const onSend = vi.fn(() => true);
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      onSend={onSend}
      onSomethingElse={onSomethingElse}
      row={bot({ tone: "question", text: "Deploy now?", options: ["Yes", "Later"] })}
    />,
  );
  await view.render();
  expect(view.container.textContent).toContain("CSomething else");
  await view.click("Something else");
  expect(onSomethingElse).toHaveBeenCalledTimes(1);
  expect(onSend).not.toHaveBeenCalled();
});

it("keeps an answered question's card with the question and only the picked choice", async () => {
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      row={bot({
        tone: "question",
        text: "Deploy now?",
        options: [],
        choices: ["Yes", "Later"],
        answer: "Later",
        answerIndex: 1,
      })}
    />,
  );
  await view.render();
  const text = view.container.textContent ?? "";
  expect(text).toContain("Deploy now?");
  expect(text).toContain("BLater");
  expect(text).not.toContain("Yes");
  expect(text).not.toContain("Answered");
  expect(view.container.querySelectorAll("button")).toHaveLength(0);
});

it("offers no pick while the bot cannot take a message", async () => {
  h = createNativeMemoryHarness();
  const onSend = vi.fn(() => true);
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      canSend={false}
      onSend={onSend}
      row={bot({ tone: "question", text: "Deploy now?", options: ["Yes", "Later"] })}
    />,
  );
  await view.render();
  const buttons = [...view.container.querySelectorAll("button")];
  expect(buttons.map((button) => button.disabled)).toEqual([true, true, true]);
  await view.click("A. Yes");
  expect(onSend).not.toHaveBeenCalled();
});

// Turn items for the shared timeline, so these tests read the answered state the way the screen does.
const at = (second: number) => `2026-10-12T12:00:0${second}Z`;
function turnBase(id: string, second: number) {
  const time = DateTime.makeUnsafe(at(second));
  return {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread-bot"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: time,
    completedAt: time,
    updatedAt: time,
  };
}
const askedItem = {
  ...turnBase("b1", 1),
  type: "assistant_message",
  messageId: MessageId.make("m-b1"),
  text: "Which one?",
  streaming: false,
} satisfies OrchestrationV2TurnItem;
const sentItem = (text: string) =>
  ({
    ...turnBase("u1", 2),
    type: "user_message",
    messageId: MessageId.make("m-u1"),
    inputIntent: "turn_start",
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "mobile",
  }) satisfies OrchestrationV2TurnItem;
const cardItem = {
  ...turnBase("n1", 0),
  type: "notification",
  source: { kind: "background_task" },
  outcome: "updated",
  summary: "Work updated",
} satisfies OrchestrationV2TurnItem;
const question: GoatBotMessagePresentation = {
  tone: "question",
  readAt: null,
  requestKey: null,
  options: ["CI fix", "Release"],
};
const taskQuestion: GoatBotMessagePresentation = {
  ...question,
  taskId: "proposal",
  questionId: "q-pick",
};
const taskCard = (openQuestionIds: ReadonlyArray<string>): GoatBotTaskCard => ({
  key: "proposal",
  revision: 2,
  updatedAt: at(0),
  title: "Pick a fix",
  statusLabel: "Working",
  tone: "active",
  sourceLabel: null,
  summary: null,
  attentionLabel: null,
  pullRequests: [],
  target: { kind: "none", label: "Pick a fix" },
  askInChat: true,
  openQuestionIds,
});
const sending = (text: string, state: GoatBotPendingInput["state"]): GoatBotPendingInput => ({
  clientKey: "c1",
  text,
  createdAt: at(2),
  state,
  requestKey: null,
});

function questionFrom(input: {
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly pending?: ReadonlyArray<GoatBotPendingInput>;
  readonly messages?: Record<string, GoatBotMessagePresentation>;
  readonly cards?: Record<string, GoatBotTaskCard>;
}): GoatBotRow {
  const messages = input.messages ?? { b1: question };
  const rows = buildGoatBotTimeline({
    visibleTurnItems: input.items.map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    })),
    pendingInputs: [...(input.pending ?? [])],
    readers: {
      message: (item) => messages[item.id] ?? null,
      taskCard: (item) => input.cards?.[item.id] ?? null,
    },
    taskId: null,
  });
  const row = rows.find((entry) => entry.id === "b1");
  if (row === undefined) throw new Error("The question row is missing.");
  return row;
}

describe("a question in the chat folds to the answer the person sent", () => {
  const shown = async (row: GoatBotRow) => {
    h = createNativeMemoryHarness();
    view = renderNative(h, <GoatBotTimelineRow {...props} row={row} />);
    await view.render();
    return {
      text: view.container.textContent ?? "",
      buttons: [...view.container.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    };
  };

  it("shows a pick on its way as the chosen row, sending, under the kept question", async () => {
    const { text, buttons } = await shown(
      questionFrom({ items: [askedItem], pending: [sending("Release", "sending")] }),
    );
    expect(text).toContain("Which one?");
    expect(text).toContain("BReleaseSending…");
    expect(text).not.toContain("CI fix");
    expect(buttons).toEqual([]);
  });

  it("keeps only the question when the reply was typed, leaving the reply its own message", async () => {
    const { text, buttons } = await shown(
      questionFrom({ items: [askedItem, sentItem("Neither, wait for Monday")] }),
    );
    expect(text).toContain("Which one?");
    expect(text).not.toContain("Neither, wait for Monday");
    expect(text).not.toContain("Answered");
    expect(buttons).toEqual([]);
  });

  it("keeps the choices when the answer failed to send", async () => {
    const { text, buttons } = await shown(
      questionFrom({ items: [askedItem], pending: [sending("Release", "failed")] }),
    );
    expect(text).toContain("Which one?");
    expect(text).not.toContain("Sending…");
    expect(buttons).toEqual(["A. CI fix", "B. Release", "Something else"]);
  });

  it("leaves a later message its own once the task closed the question", async () => {
    const { text, buttons } = await shown(
      questionFrom({
        items: [cardItem, askedItem, sentItem("Release")],
        messages: {
          b1: taskQuestion,
          u1: { tone: "reply", readAt: at(2), requestKey: "in-1", taskId: "proposal" },
        },
        cards: { n1: taskCard([]) },
      }),
    );
    expect(text).toContain("Which one?");
    expect(text).not.toContain("Release");
    expect(buttons).toEqual([]);
  });

  it("folds a pick sent while the task's card still lists the question into that question", async () => {
    const { text, buttons } = await shown(
      questionFrom({
        items: [cardItem, askedItem, sentItem("Release")],
        messages: {
          b1: taskQuestion,
          u1: { tone: "reply", readAt: null, requestKey: "in-1", taskId: "proposal" },
        },
        cards: { n1: taskCard(["q-pick"]) },
      }),
    );
    expect(text).toContain("Which one?");
    expect(text).toContain("BRelease");
    expect(text).not.toContain("CI fix");
    expect(buttons).toEqual([]);
  });

  it("keeps a task's choices open after a typed reply until its card drops the question", async () => {
    const typed = (openQuestionIds: ReadonlyArray<string>) =>
      shown(
        questionFrom({
          items: [cardItem, askedItem, sentItem("Neither, wait for Monday")],
          messages: {
            b1: taskQuestion,
            u1: { tone: "reply", readAt: null, requestKey: "in-1" },
          },
          cards: { n1: taskCard(openQuestionIds) },
        }),
      );
    expect((await typed(["q-pick"])).buttons).toEqual([
      "A. CI fix",
      "B. Release",
      "Something else",
    ]);
    await view.unmount();
    h.dispose();
    const closed = await typed([]);
    expect(closed.text).toContain("Which one?");
    expect(closed.buttons).toEqual([]);
  });
});

describe("a reply with a table", () => {
  const table = ["| Step | Result |", "| --- | --- |", "| Read | [notes](goat-thread://v1/t-1) |"];
  const render = async (row: GoatBotRow) => {
    h = createNativeMemoryHarness();
    view = renderNative(h, <GoatBotTimelineRow {...props} row={row} />);
    await view.render();
    return view.container.textContent ?? "";
  };

  it("puts the intro, the table and the closing in cards of their own, captioned once", async () => {
    const text = await render(
      bot({ text: ["Done.", "", ...table, "", "Ask again any time."].join("\n") }),
    );
    const intro = text.indexOf("Done.");
    const grid = text.indexOf("md[| Step | Result |");
    const closing = text.indexOf("Ask again any time.");
    expect(intro).toBeGreaterThanOrEqual(0);
    expect(grid).toBeGreaterThan(intro);
    expect(closing).toBeGreaterThan(grid);
    expect(text.split(goatBotTime("2026-10-12T09:40:00Z")).length - 1).toBe(1);
    expect(view.container.querySelectorAll('[aria-label="Copy table"]')).toHaveLength(1);
  });

  it("copies the table as the bot wrote it, says so, and says when it could not", async () => {
    clipboard.copy.mockClear();
    await render(bot({ text: ["Done.", "", ...table].join("\n") }));
    await view.click("Copy table");
    expect(clipboard.copy).toHaveBeenCalledWith(table.join("\n"), { target: "table" });
    expect(view.container.querySelector('[aria-label="Copied"]')).not.toBeNull();
    expect(h.announcements).toEqual(["Table copied"]);
    await view.unmount();
    h.dispose();

    clipboard.copy.mockImplementationOnce(async () => false);
    await render(bot({ text: table.join("\n") }));
    await view.click("Copy table");
    expect(view.container.querySelector('[aria-label="Copy table"]')).not.toBeNull();
    expect(h.announcements).toEqual(["Couldn't copy the table"]);
  });

  it("says how the newest copy went, ignoring older or unmounted ones", async () => {
    clipboard.copy.mockClear();
    await render(bot({ text: table.join("\n") }));
    await view.click("Copy table");
    clipboard.copy.mockImplementationOnce(async () => false);
    await view.click("Copied");
    expect(view.container.querySelector('[aria-label="Copy table"]')).not.toBeNull();
    expect(h.announcements).toEqual(["Table copied", "Couldn't copy the table"]);

    const slow = Promise.withResolvers<boolean>();
    clipboard.copy.mockImplementationOnce(() => slow.promise);
    clipboard.copy.mockImplementationOnce(async () => false);
    await view.click("Copy table");
    await view.click("Copy table");
    await act(async () => slow.resolve(true));
    expect(view.container.querySelector('[aria-label="Copied"]')).toBeNull();
    expect(h.announcements.slice(2)).toEqual(["Couldn't copy the table"]);

    const pending = Promise.withResolvers<boolean>();
    clipboard.copy.mockImplementationOnce(() => pending.promise);
    await view.click("Copy table");
    await view.unmount();
    await act(async () => pending.resolve(true));
    expect(h.announcements.slice(3)).toEqual([]);
  });

  it("keeps a reply whole when a list item or quote defines one of its links", async () => {
    for (const definition of ["- [x]: https://example.com", "> [x]: https://example.com"]) {
      await render(bot({ text: ["See [notes][x].", "", ...table, "", definition].join("\n") }));
      expect(view.container.querySelectorAll('[aria-label="Copy table"]')).toHaveLength(0);
      await view.unmount();
      h.dispose();
    }
    await render(bot({ text: "x" }));
  });

  it("cards a table indented under a quote that a blank line ended, and leaves one a list item holds", async () => {
    const indented = table.map((line) => `  ${line}`);
    await render(bot({ text: ["> A note first.", "", ...indented].join("\n") }));
    expect(view.container.querySelectorAll('[aria-label="Copy table"]')).toHaveLength(1);
    await view.unmount();
    h.dispose();
    // Two spaces under "- " still belong to the list item, so the table stays in it.
    await render(bot({ text: ["- A step first", "", ...indented].join("\n") }));
    expect(view.container.querySelectorAll('[aria-label="Copy table"]')).toHaveLength(0);
  });

  it("leaves a table in the bubble when nested lists or quotes above could still hold it", async () => {
    const indented = table.map((line) => `  ${line}`);
    for (const above of [
      ["- An outer step", "  - An inner step"],
      ["- A step", "  > A quote inside it"],
      ["- An outer step", "\t- An inner step"],
    ]) {
      await render(bot({ text: [...above, "", ...indented].join("\n") }));
      expect(view.container.querySelectorAll('[aria-label="Copy table"]')).toHaveLength(0);
      await view.unmount();
      h.dispose();
    }
    await render(bot({ text: "x" }));
  });

  it("keeps a table card in place while the reply streams on", async () => {
    clipboard.copy.mockClear();
    const opening = ["Done.", "", ...table].join("\n");
    await render(bot({ text: opening }));
    await view.click("Copy table");
    expect(view.container.querySelector('[aria-label="Copied"]')).not.toBeNull();
    await view.rerender(
      <GoatBotTimelineRow
        {...props}
        row={bot({ text: `${opening} more\n\nAnd a closing line.` })}
      />,
    );
    // The same card is still there, so its feedback is too.
    expect(view.container.querySelector('[aria-label="Copied"]')).not.toBeNull();
  });

  it("gives every table its own card, and keeps a question in one card", async () => {
    await render(bot({ text: [...table, "", "Then:", "", ...table].join("\n") }));
    expect(view.container.querySelectorAll('[aria-label="Copy table"]')).toHaveLength(2);
    await view.unmount();
    h.dispose();

    await render(
      bot({ tone: "question", text: ["Which?", "", ...table].join("\n"), options: ["Read"] }),
    );
    expect(view.container.querySelectorAll('[aria-label="Copy table"]')).toHaveLength(0);
  });
});

describe("event lines", () => {
  const event = (
    subject?: { kind: "routine" | "task"; id: string; name: string },
    text = "Routine Daily check ran",
  ): GoatBotRow =>
    ({
      kind: "event",
      id: "event",
      text,
      createdAt: "2026-10-12T09:40:00Z",
      ...(subject ? { subject } : {}),
    }) as GoatBotRow;

  it("stays plain text when it names nothing, or nothing here can open it", async () => {
    h = createNativeMemoryHarness();
    view = renderNative(h, <GoatBotTimelineRow {...props} row={event()} />);
    await view.render();
    expect(view.container.querySelector("button")).toBeNull();
    await view.rerender(
      <GoatBotTimelineRow
        {...props}
        row={event({ kind: "routine", id: "routine-1", name: "Daily check" })}
      />,
    );
    expect(view.container.querySelector("button")).toBeNull();
    expect(view.container.textContent).toContain("Routine Daily check ran");
  });
});

vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));
