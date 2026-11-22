import { assert, it } from "@effect/vitest";
import { BotId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as BotThreads from "./ChannelBotThreads.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as TaskViews from "./channelTaskViews.ts";
import {
  makeHarness,
  linkSlackUser,
  slackContext,
  slackInput,
  owner,
  ownerId,
  setupBot,
} from "./testkit/ChannelHarness.ts";

it.effect("lists and opens Slack work only under the member assigned to it", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const members = yield* ChannelBotMembers.ChannelBotMembers;
    const member = yield* members.create(
      {
        clientRequestId: "scout",
        name: "Scout",
        avatar: null,
        purpose: "",
        defaultModelSelection: null,
      },
      owner,
    );
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    yield* gateway.ingest(slackInput("do: check the build", "slack-home"), slackContext);
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const [task] = (yield* ledger.listTasks({ ownerId, limit: 2 })).tasks;
    assert(task !== undefined);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE channel_tasks SET bot_id = ${member.botId} WHERE task_id = ${task.taskId}`;
    const home = yield* BotThreads.ChannelBotThreads;
    const list = yield* home.list(owner, member.botId);
    assert.isTrue(list.rows.some((row) => row.kind === "task" && row.task.taskId === task.taskId));
    const search = yield* home.searchBotTasks(
      { botId: member.botId, query: "check the build" },
      owner,
    );
    assert.deepStrictEqual(
      search.tasks.map((row) => row.taskId),
      [task.taskId],
    );
    const history = yield* home.list(owner, member.botId, {});
    assert.isTrue(
      history.rows.some((row) => row.kind === "task" && row.task.taskId === task.taskId),
    );
    assert.strictEqual(
      (yield* home.getBotTask({ botId: member.botId, taskId: task.taskId }, owner)).task.state,
      "known",
    );
    assert.strictEqual(
      (yield* Effect.flip(
        home.getBotTask({ botId: BotId.make("main"), taskId: task.taskId }, owner),
      )).reason,
      "not_found",
    );
  }).pipe(
    Effect.provide(
      BotThreads.layer.pipe(Layer.provideMerge(TaskViews.layer), Layer.provideMerge(harness.layer)),
    ),
  );
});
