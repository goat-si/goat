import { expect, it } from "vite-plus/test";
import { BotId, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { type ChannelAttentionEvent } from "@goat/contracts/channel-bot-attention";

import { createGoatBotAttentionPresenter } from "./GoatBotAttentionNotifier";

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
