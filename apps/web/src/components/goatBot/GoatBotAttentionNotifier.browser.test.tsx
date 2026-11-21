import { expect, it, vi } from "vite-plus/test";
import { BotId, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, render } from "../../../test/render";
import { type ChannelAttentionEvent } from "@goat/contracts/channel-bot-attention";

import { createGoatBotAttentionPresenter } from "./GoatBotAttentionNotifier";

import { GoatBotAlertTask } from "./GoatBotAlertTask";

const permission = Atom.make(true);
const taskAnswer = Atom.make<AsyncResult.AsyncResult<unknown, never>>(AsyncResult.initial());
vi.mock(import("../../state/channels"), () => ({
  channelEnvironment: {
    getTask: (() => taskAnswer) as never,
    listBotAttention: { permissionAtom: () => permission },
  } as never,
}));

const event: ChannelAttentionEvent = {
  eventId: "attention-1",
  sequence: 1,
  environmentId: EnvironmentId.make("env"),
  botId: BotId.make("main"),
  taskId: ChannelTaskId.make("task"),
  requestId: "question",
  kind: "question",
  generation: 1,
  occurredAt: "2026-11-21T00:10:00Z",
  botName: "Scout",
};

it("shows at most one generic desktop notification and skips focused and disabled work", () => {
  const notifications: Array<{ title: string; options: NotificationOptions }> = [];
  let focused = false;
  const present = createGoatBotAttentionPresenter({
    focused: () => focused,
    show: (title, options) => {
      notifications.push({ title, options });
    },
  });
  present({ ...event, title: "Private title" } as ChannelAttentionEvent, "needs_you");
  present(event, "needs_you");
  focused = true;
  present({ ...event, eventId: "focused", sequence: 2 }, "needs_you");
  focused = false;
  present({ ...event, eventId: "disabled", sequence: 3 }, "off");
  expect(notifications.map(({ title, options }) => [title, options.body])).toEqual([
    ["Scout has a question", undefined],
  ]);
});

it("shows a Slack question and its recorded answer, then clears the content on revocation", async () => {
  const registry = AtomRegistry.make();
  const title = "Slack-origin task";
  const task = {
    title,
    openQuestions: [{ questionId: "question", text: "Which region?" }],
  };
  try {
    registry.set(taskAnswer, AsyncResult.success(task));
    await using screen = await render(
      <RegistryContext value={registry}>
        <GoatBotAlertTask
          environmentId={event.environmentId}
          botId={event.botId}
          taskId={event.taskId}
          requestId={event.requestId}
        />
      </RegistryContext>,
      { router: "/bot" },
    );
    await expect.element(screen.getByRole("heading", { name: title })).toBeVisible();
    await expect.element(screen.getByText("Which region?")).toBeVisible();

    await act(() =>
      registry.set(
        taskAnswer,
        AsyncResult.success({
          ...task,
          openQuestions: [],
          answeredQuestions: [{ questionId: "question", answerText: "West" }],
        }),
      ),
    );
    await expect.element(screen.getByText("West", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Which region?")).not.toBeInTheDocument();

    await act(() => registry.set(permission, false));
    await expect.element(screen.getByText("This task isn't available.")).toBeVisible();
    await expect.element(screen.getByText("West", { exact: true })).not.toBeInTheDocument();
  } finally {
    registry.dispose();
  }
});
