import {
  type ChannelTaskChip,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { Profiler, StrictMode, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

// Renders counted through a hook each component calls on every render: the timeline's follow
// hook, the chat view's reply announcement, and each question card's typed answer.
const probe = vi.hoisted(() => ({
  timeline: 0,
  chat: 0,
  cards: new Map<string, number>(),
  kept: new Map<string, boolean>(),
}));
vi.mock("./useGoatBotFollow", async (original) => {
  const real = await original<typeof import("./useGoatBotFollow")>();
  return {
    ...real,
    useGoatBotFollow: (...args: Parameters<typeof real.useGoatBotFollow>) => {
      probe.timeline += 1;
      return real.useGoatBotFollow(...args);
    },
  };
});
vi.mock("./useGoatBotReplyAnnouncement", async (original) => {
  const real = await original<typeof import("./useGoatBotReplyAnnouncement")>();
  return {
    ...real,
    useGoatBotReplyAnnouncement: (...args: Parameters<typeof real.useGoatBotReplyAnnouncement>) => {
      probe.chat += 1;
      return real.useGoatBotReplyAnnouncement(...args);
    },
  };
});
vi.mock("./GoatBotTypedAnswers", async (original) => {
  const real = await original<typeof import("./GoatBotTypedAnswers")>();
  return {
    ...real,
    useGoatBotTypedAnswer: (row: Parameters<typeof real.useGoatBotTypedAnswer>[0]) => {
      probe.cards.set(row.id, (probe.cards.get(row.id) ?? 0) + 1);
      const typed = real.useGoatBotTypedAnswer(row);
      probe.kept.set(row.id, typed?.kept ?? false);
      return typed;
    },
  };
});
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

import { resetNavigationHoldsForTests } from "~/lib/navigationHolds";
import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotQuestionCard } from "./GoatBotQuestionCard";
import { GoatBotTypedAnswersScope } from "./GoatBotTypedAnswers";

type BotRow = Extract<GoatBotRow, { kind: "bot" }>;
const env = EnvironmentId.make("env");

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
const other: BotRow = {
  ...question,
  id: "r",
  text: "Which branch should it ship from?",
  options: ["Main", "Release"],
  choices: ["Main", "Release"],
  answerTaskId: "task-2",
  answerQuestionId: "q-2",
};

/** Task 1's chip recording an answer to its question. */
const recorded = {
  item: {
    id: "chip-task-1-4",
    type: "notification",
    ledgerTask: {
      taskId: "task-1",
      conversationId: "conversation",
      taskVersion: 4,
      title: "Build the release",
      status: "running",
      originKind: "goat",
      requesterLabel: "You",
      createdAt: "2026-11-16T08:00:00Z",
      updatedAt: "2026-11-16T09:04:00Z",
      openQuestionCount: 0,
      openQuestionIds: [],
      answeredQuestions: [{ questionId: "q-1" }],
    } as unknown as ChannelTaskChip,
  },
} as unknown as OrchestrationV2ProjectedTurnItem;

/** Clears the counts and holds a previous test may have left. */
function setup() {
  resetNavigationHoldsForTests();
  probe.timeline = 0;
  probe.chat = 0;
  probe.cards.clear();
  probe.kept.clear();
}

const counts = () => ({
  timeline: probe.timeline,
  chat: probe.chat,
  typed: probe.cards.get("q") ?? 0,
  other: probe.cards.get("r") ?? 0,
});

it("a keystroke in one question card redraws neither the timeline nor the chat view (#3442)", async () => {
  setup();
  const threadId = ThreadId.make("main-bot");
  await using screen = await render(
    <div style={{ display: "flex", height: 600, width: 640 }}>
      <GoatBotChatView
        environmentId={env}
        availability={{ kind: "ready", bot: { environmentId: env, threadId } }}
        canOperate
        rows={[question, other]}
        onSend={() => true}
        onSendToTask={() => true}
        onRetryInput={() => {}}
        legacyAgentRoute={null}
      />
    </div>,
  );
  const field = screen.getByRole("textbox", { name: "Something else" }).nth(0);
  // The first keystroke creates the entry and takes the navigation hold; the next one is measured.
  await userEvent.type(field, "a");
  const before = counts();
  await userEvent.keyboard("b");
  await expect.element(field).toHaveValue("ab");
  const after = counts();
  expect({
    timeline: after.timeline - before.timeline,
    chat: after.chat - before.chat,
    typed: after.typed - before.typed,
    other: after.other - before.other,
  }).toEqual({ timeline: 0, chat: 0, typed: 1, other: 1 });
});

it("under StrictMode, an answer its task records while the field is empty settles without render warnings (#3442)", async () => {
  setup();
  using errors = vi.spyOn(console, "error");
  const commits = { count: 0 };
  const view = (row: BotRow, items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) => (
    <StrictMode>
      <Profiler id="answers" onRender={() => void (commits.count += 1)}>
        <GoatBotTypedAnswersScope destination="env:bot" visibleTurnItems={items} mainChat>
          <GoatBotQuestionCard row={row} body={row.text} onPick={() => true} />
        </GoatBotTypedAnswersScope>
      </Profiler>
    </StrictMode>
  );
  await using screen = await render(view(question, []), { router: false }); // No links in the card.
  const field = screen.getByRole("textbox", { name: "Something else" });
  await userEvent.type(field, "x");
  await userEvent.clear(field);
  expect(probe.kept.get("q")).toBe(true);
  const before = { commits: commits.count, card: probe.cards.get("q") ?? 0 };
  const answered: BotRow = { ...question, options: [], answer: "Keep", answerIndex: 0 };
  await screen.rerender(view(answered, [recorded]));
  await expect.element(field).not.toBeInTheDocument();
  await vi.waitFor(() => expect(probe.kept.get("q")).toBe(false));
  expect({
    commits: commits.count - before.commits,
    card: (probe.cards.get("q") ?? 0) - before.card,
  }).toEqual({ commits: 1, card: 2 });
  expect(errors).not.toHaveBeenCalled();
});
