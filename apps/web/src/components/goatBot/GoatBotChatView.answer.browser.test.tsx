import {
  type ChannelTaskChip,
  EnvironmentId,
  ThreadId,
  type BotProfile,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useThreadStatus: (ref: unknown) => (ref === null ? "empty" : "live"),
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotMemberModelPicker", () => ({ GoatBotMemberModelPicker: () => null }));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { navigationBlocked, resetNavigationHoldsForTests } from "~/lib/navigationHolds";
import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotMemberContext } from "./goatBotMemberContext";

type BotRow = Extract<GoatBotRow, { kind: "bot" }>;
const env = EnvironmentId.make("env");
const TYPED = "Use the staging cache";

const question: BotRow = {
  kind: "bot",
  id: "q",
  text: "Which cache should the build use?",
  createdAt: "2026-11-16T09:00:00Z",
  tone: "question",
  proactive: true,
  replyTo: null,
  options: ["Keep", "Clear"],
  choices: ["Keep", "Clear"],
  answerTaskId: "task-1",
  answerQuestionId: "q-1",
  firstInGroup: true,
  groupPosition: "single",
};

/** The row as a card that closed its question leaves it: no choices and nowhere to send. */
function withoutTarget(row: BotRow): BotRow {
  const { answerTaskId: _task, answerQuestionId: _question, ...rest } = row;
  return rest;
}

/** A task's chip as its notification carries it, recording answers to the given questions. */
function chipItem(
  taskId: string,
  taskVersion: number,
  answered: ReadonlyArray<string>,
): OrchestrationV2ProjectedTurnItem {
  const chip = {
    taskId,
    conversationId: "conversation",
    taskVersion,
    title: "Build the release",
    status: "running",
    originKind: "goat",
    requesterLabel: "You",
    createdAt: "2026-11-16T08:00:00Z",
    updatedAt: "2026-11-16T09:0" + taskVersion + ":00Z",
    openQuestionCount: 0,
    openQuestionIds: [],
    answeredQuestions: answered.map((questionId) => ({ questionId })),
  } as unknown as ChannelTaskChip;
  return {
    item: { id: "chip-" + taskId + "-" + taskVersion, type: "notification", ledgerTask: chip },
  } as unknown as OrchestrationV2ProjectedTurnItem;
}

const member = (id: string) =>
  ({
    botId: id,
    role: "member",
    name: id,
    environmentId: env,
    sessionThreadId: ThreadId.make(id + "-session"),
    state: "active",
  }) as BotProfile;

function chat(options: {
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly items?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly onSendToTask?: () => boolean;
  readonly member?: BotProfile | null;
}) {
  const { rows, items = [], onSendToTask = () => true, member = null } = options;
  const threadId = member?.sessionThreadId ?? ThreadId.make("main-bot");
  return (
    <div style={{ display: "flex", height: 600, width: 640 }}>
      <GoatBotMemberContext value={member}>
        <GoatBotChatView
          environmentId={env}
          visibleTurnItems={items}
          availability={{ kind: "ready", bot: { environmentId: env, threadId } }}
          canOperate
          rows={rows}
          onSend={() => true}
          onSendToTask={onSendToTask}
          onRetryInput={() => {}}
          legacyAgentRoute={null}
        />
      </GoatBotMemberContext>
    </div>
  );
}

/** Clears the navigation holds a previous test may have left. */
function setup() {
  resetNavigationHoldsForTests();
}

it("a typed answer survives a pick in flight and its question leaving the loaded history, and Enter still answers that question (#3442)", async () => {
  setup();
  const onSendToTask = vi.fn(() => true);
  await using screen = await render(chat({ rows: [question], onSendToTask }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), TYPED);
  // A pick from this card on its way: the card shows the picked row.
  const sending: BotRow = {
    ...question,
    options: [],
    answer: "Keep",
    answerIndex: 0,
    answerSending: true,
  };
  await screen.rerender(chat({ rows: [sending], onSendToTask }));
  await expect.element(screen.getByText("Sending…")).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Something else" })).toHaveValue(TYPED);
  // No rows at all: the timeline unmounts, and the words still hold.
  await screen.rerender(chat({ rows: [], onSendToTask }));
  expect(navigationBlocked()).toBe(true);
  // Back, closed by its card, with no target of its own.
  const closed: BotRow = { ...withoutTarget(question), options: [] };
  await screen.rerender(chat({ rows: [closed], onSendToTask }));
  const field = screen.getByRole("textbox", { name: "Something else" });
  await expect.element(field).toHaveValue(TYPED);
  await userEvent.type(field, "{Enter}");
  expect(onSendToTask).toHaveBeenCalledWith("task-1", TYPED, [], "q-1");
  await expect.element(field).not.toBeInTheDocument();
  expect(navigationBlocked()).toBe(false);
});

it("guard: an open question whose ids arrive after the first keystroke answers with them (#3442)", async () => {
  setup();
  const onSendToTask = vi.fn(() => true);
  await using screen = await render(chat({ rows: [withoutTarget(question)], onSendToTask }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), "Warm");
  await screen.rerender(chat({ rows: [question], onSendToTask }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), " it{Enter}");
  expect(onSendToTask).toHaveBeenCalledWith("task-1", "Warm it", [], "q-1");
});

it("the task's record of an answer turns a typed answer into a Not sent line that holds until discarded (#3442)", async () => {
  setup();
  const other: BotRow = {
    ...question,
    id: "r",
    text: "Which branch should it ship from?",
    options: ["Main", "Release"],
    choices: ["Main", "Release"],
    answerTaskId: "task-2",
    answerQuestionId: "q-2",
  };
  await using screen = await render(chat({ rows: [question, other] }));
  const fields = () => screen.getByRole("textbox", { name: "Something else" });
  await userEvent.type(fields().nth(1), "From the release branch");
  await userEvent.type(fields().nth(0), TYPED);
  // A record of an earlier attempt's question changes nothing.
  await screen.rerender(chat({ rows: [question, other], items: [chipItem("task-1", 3, ["q-0"])] }));
  await expect.element(fields().nth(0)).toHaveValue(TYPED);
  // The task records an answer to this question while its field has focus.
  const answered: BotRow = { ...question, options: [], answer: "Keep", answerIndex: 0 };
  await screen.rerender(chat({ rows: [answered, other], items: [chipItem("task-1", 4, ["q-1"])] }));
  await expect.element(screen.getByText("Not sent: “" + TYPED + "”")).toBeVisible();
  await expect.element(fields()).toHaveValue("From the release branch");
  const discard = screen.getByRole("button", { name: "Discard unsent answer" });
  await expect.element(discard).toHaveFocus();
  expect(navigationBlocked()).toBe(true);
  await userEvent.click(discard);
  await expect.element(screen.getByText("Not sent: “" + TYPED + "”")).not.toBeInTheDocument();
  const row = screen.container.querySelector('[data-bot-row="q"]');
  await vi.waitFor(() => expect(document.activeElement).toBe(row));
  // The other card's words still hold.
  expect(navigationBlocked()).toBe(true);
});

it("guard: a typed answer stays with the bot it was typed for (#3442)", async () => {
  setup();
  await using screen = await render(chat({ rows: [question], member: member("first") }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), TYPED);
  await screen.rerender(chat({ rows: [question], member: member("second") }));
  await screen.rerender(chat({ rows: [question], member: member("first") }));
  await expect.element(screen.getByRole("textbox", { name: "Something else" })).toHaveValue("");
  expect(navigationBlocked()).toBe(false);
});

it("in the main chat, Enter in a closed card whose task question has no id keeps the words as Not sent (#3442)", async () => {
  setup();
  const onSendToTask = vi.fn(() => true);
  const { answerQuestionId: _question, ...noQuestionId } = question;
  await using screen = await render(chat({ rows: [noQuestionId], onSendToTask }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), TYPED);
  // A pick sending keeps the row's task id; this server named no question.
  const sending: BotRow = {
    ...noQuestionId,
    options: [],
    answer: "Keep",
    answerIndex: 0,
    answerSending: true,
  };
  await screen.rerender(chat({ rows: [sending], onSendToTask }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), "{Enter}");
  await expect.element(screen.getByText("Not sent: “" + TYPED + "”")).toBeVisible();
  expect(onSendToTask).not.toHaveBeenCalled();
});

it("a closed card's field left with only spaces ends when it loses focus (#3442)", async () => {
  setup();
  const sending: BotRow = {
    ...question,
    options: [],
    answer: "Keep",
    answerIndex: 0,
    answerSending: true,
  };
  await using screen = await render(chat({ rows: [question] }));
  const field = () => screen.getByRole("textbox", { name: "Something else" });
  await userEvent.type(field(), TYPED);
  await screen.rerender(chat({ rows: [sending] }));
  await userEvent.clear(field());
  await userEvent.type(field(), "   ");
  await userEvent.click(screen.getByText("Which cache should the build use?"));
  await expect.element(field()).not.toBeInTheDocument();
  expect(navigationBlocked()).toBe(false);
});

it("guard: the task recording an answer while the field is focused and empty ends it with focus on the row (#3442)", async () => {
  setup();
  await using screen = await render(chat({ rows: [question] }));
  const field = screen.getByRole("textbox", { name: "Something else" });
  await userEvent.type(field, "x");
  await userEvent.clear(field);
  const answered: BotRow = { ...question, options: [], answer: "Keep", answerIndex: 0 };
  await screen.rerender(chat({ rows: [answered], items: [chipItem("task-1", 4, ["q-1"])] }));
  await expect.element(field).not.toBeInTheDocument();
  expect(screen.container.textContent).not.toContain("Not sent");
  const row = screen.container.querySelector('[data-bot-row="q"]');
  await vi.waitFor(() => expect(document.activeElement).toBe(row));
  expect(navigationBlocked()).toBe(false);
});

it("words the gate held become editable again when the card's choices come back (#3442)", async () => {
  setup();
  const onSendToTask = vi.fn(() => true);
  const { answerQuestionId: _question, ...noQuestionId } = question;
  const sending: BotRow = {
    ...noQuestionId,
    options: [],
    answer: "Keep",
    answerIndex: 0,
    answerSending: true,
  };
  await using screen = await render(chat({ rows: [noQuestionId], onSendToTask }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), TYPED);
  await screen.rerender(chat({ rows: [sending], onSendToTask }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), "{Enter}");
  await expect.element(screen.getByText("Not sent: “" + TYPED + "”")).toBeVisible();
  // The pick failed: the choices are back.
  await screen.rerender(chat({ rows: [noQuestionId], onSendToTask }));
  await expect.element(screen.getByRole("textbox", { name: "Something else" })).toHaveValue(TYPED);
  expect(screen.container.textContent).not.toContain("Not sent");
  expect(onSendToTask).not.toHaveBeenCalled();
});

it("gate-held words become editable when the question id arrives during the pick, and Enter routes with it (#3442)", async () => {
  setup();
  const onSendToTask = vi.fn(() => true);
  const { answerQuestionId: _question, ...noQuestionId } = question;
  const sending: BotRow = {
    ...noQuestionId,
    options: [],
    answer: "Keep",
    answerIndex: 0,
    answerSending: true,
  };
  await using screen = await render(chat({ rows: [noQuestionId], onSendToTask }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), TYPED);
  await screen.rerender(chat({ rows: [sending], onSendToTask }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), "{Enter}");
  await expect.element(screen.getByText("Not sent: “" + TYPED + "”")).toBeVisible();
  // The question id arrives while the pick is still on its way.
  await screen.rerender(chat({ rows: [{ ...sending, answerQuestionId: "q-1" }], onSendToTask }));
  const field = screen.getByRole("textbox", { name: "Something else" });
  await expect.element(field).toHaveValue(TYPED);
  expect(screen.container.textContent).not.toContain("Not sent");
  await userEvent.type(field, "{Enter}");
  expect(onSendToTask).toHaveBeenCalledWith("task-1", TYPED, [], "q-1");
});

it("gate-held words whose question id arrives during the pick show as Not sent once the task records that question (#3442)", async () => {
  setup();
  const onSendToTask = vi.fn(() => true);
  const { answerQuestionId: _question, ...noQuestionId } = question;
  const sending: BotRow = {
    ...noQuestionId,
    options: [],
    answer: "Keep",
    answerIndex: 0,
    answerSending: true,
  };
  await using screen = await render(chat({ rows: [noQuestionId], onSendToTask }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), TYPED);
  await screen.rerender(chat({ rows: [sending], onSendToTask }));
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), "{Enter}");
  await screen.rerender(chat({ rows: [{ ...sending, answerQuestionId: "q-1" }], onSendToTask }));
  await expect.element(screen.getByRole("textbox", { name: "Something else" })).toHaveValue(TYPED);
  // The task records an answer to that question before the person types again.
  const answered: BotRow = { ...question, options: [], answer: "Keep", answerIndex: 0 };
  await screen.rerender(
    chat({ rows: [answered], items: [chipItem("task-1", 4, ["q-1"])], onSendToTask }),
  );
  await expect.element(screen.getByText("Not sent: “" + TYPED + "”")).toBeVisible();
  expect(onSendToTask).not.toHaveBeenCalled();
});
