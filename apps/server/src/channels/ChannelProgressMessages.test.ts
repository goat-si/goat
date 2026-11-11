import { assert, describe, it } from "@effect/vitest";
import type { ChannelReceptionInput } from "@goat/contracts";
import { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../serverSettings.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { receptionDecisionChannels } from "./testkit/channelReceptionHarness.ts";
import {
  botMessages,
  defaultScript,
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const botModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" } as const;

/** "look:" asks GOAT Bot to take a turn itself. */
const turnScript = (input: ChannelReceptionInput) =>
  input.mode === "input" && (input.inputText ?? "").startsWith("look:")
    ? Effect.succeed({
        replyText: "On it.",
        action: {
          type: "run_turn" as const,
          title: "Look into it",
          instruction: (input.inputText ?? "").slice(5).trim(),
        },
      })
    : defaultScript(input);

const harnessWith = (goatBotModelSelection: typeof botModel) => {
  const harness = makeHarness({
    botWorkspace: true,
    channelsLayer: receptionDecisionChannels,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: modelSelection,
      goatBotModelSelection,
    }).pipe(Layer.orDie),
  });
  harness.script.current = turnScript;
  return harness;
};

describe("progress on channels that cannot take a message back", () => {
  it.effect(
    "a Slack turn sends one message before its answer: later milestones reach only the bot's chat",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(slackInput("look: why is the disk full?", "Ev21"), slackContext);
        yield* runtime.drain;
        yield* reports.reconcile(runtime.ownerToken);
        const task = yield* onlyTask;
        for (const [eventId, summary] of [
          ["slack-progress-1", "Listing the largest folders now."],
          ["slack-progress-2", "Docker looks like the culprit; checking images."],
        ] as const)
          yield* reports.report(
            {
              taskId: task.taskId,
              generation: task.generation,
              eventId: eventId as never,
              status: "running",
              summary,
            },
            task.worker!.threadId,
          );
        yield* runtime.drain;
        harness.world.setStatus(task.worker!.threadId, 1, "completed", "Docker images take 41 GB.");
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        const kinds = harness.slackSent
          .filter((send) => send.message.taskId === task.taskId)
          .map((send) => send.message.kind);
        assert.deepStrictEqual(kinds, ["receipt", "result"]);
        // The bot's own chat keeps every step, which its progress line reads.
        const texts = (yield* botMessages).messages.map((message) => message.text);
        assert.include(texts, "Listing the largest folders now.");
        assert.include(texts, "Docker looks like the culprit; checking images.");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a Slack turn whose acknowledgement never arrived sends its first milestone, and only that one",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(slackInput("look: why is the disk full?", "Ev22"), slackContext);
        yield* runtime.drain;
        yield* reports.reconcile(runtime.ownerToken);
        const task = yield* onlyTask;
        // The acknowledgement expired undelivered, so the person has heard nothing yet.
        yield* (yield* SqlClient.SqlClient)`UPDATE channel_outbox SET state = 'failed'
          WHERE cause_key = ${"reply:" + task.originInputId}`;
        const sentBefore = harness.slackSent.length;
        for (const [eventId, summary] of [
          ["slack-late-1", "Listing the largest folders now."],
          ["slack-late-2", "Docker looks like the culprit; checking images."],
        ] as const)
          yield* reports.report(
            {
              taskId: task.taskId,
              generation: task.generation,
              eventId: eventId as never,
              status: "running",
              summary,
            },
            task.worker!.threadId,
          );
        yield* runtime.drain;
        assert.deepStrictEqual(
          harness.slackSent.slice(sentBefore).map((send) => send.message.text),
          ["Listing the largest folders now."],
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

const startSlackTurn = (harness: ReturnType<typeof harnessWith>, eventId: string) =>
  Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    yield* gateway.ingest(slackInput("look: why is the disk full?", eventId), slackContext);
    yield* runtime.drain;
    yield* reports.reconcile(runtime.ownerToken);
    const task = yield* onlyTask;
    const sql = yield* SqlClient.SqlClient;
    const progress = (id: string, summary: string) =>
      reports.report(
        {
          taskId: task.taskId,
          generation: task.generation,
          eventId: id as never,
          status: "running",
          summary,
        },
        task.worker!.threadId,
      );
    const sentSince = (count: number) =>
      harness.slackSent.slice(count).map((send) => send.message.text);
    return { runtime, task, sql, progress, sentSince, ackKey: "reply:" + task.originInputId };
  });

describe("one message before the answer, whatever the order", () => {
  it.effect(
    "a milestone reported before the acknowledgement was recorded stays out once the acknowledgement is sent",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        const { runtime, sql, progress, sentSince, ackKey } = yield* startSlackTurn(
          harness,
          "Ev31",
        );
        const [ack] = yield* sql<Record<string, unknown>>`
          SELECT * FROM channel_outbox WHERE cause_key = ${ackKey}`;
        yield* sql`DELETE FROM channel_outbox WHERE cause_key = ${ackKey}`;
        const before = harness.slackSent.length;
        yield* progress("order-early-1", "Listing the largest folders now.");
        yield* runtime.drain;
        // The acknowledgement (the 20 s line or the 55 s fallback) is recorded after the milestone.
        yield* sql`INSERT INTO channel_outbox ${sql.insert({ ...ack!, state: "pending", attempts: 0 })}`;
        yield* runtime.drain;
        assert.deepStrictEqual(sentSince(before), [JSON.parse(String(ack!.message_json)).text]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a milestone that waits on an acknowledgement still sending goes out when that acknowledgement fails",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        const { runtime, sql, progress, sentSince, ackKey } = yield* startSlackTurn(
          harness,
          "Ev32",
        );
        yield* sql`UPDATE channel_outbox SET state = 'pending',
          next_attempt_at = '2999-01-01T00:00:00.000Z' WHERE cause_key = ${ackKey}`;
        const before = harness.slackSent.length;
        yield* progress("order-pending-1", "Listing the largest folders now.");
        yield* runtime.drain;
        assert.deepStrictEqual(sentSince(before), []);
        yield* sql`UPDATE channel_outbox SET state = 'failed' WHERE cause_key = ${ackKey}`;
        yield* runtime.drain;
        assert.deepStrictEqual(sentSince(before), ["Listing the largest folders now."]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "every interim message of a task follows the rule, while its questions always go",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        const { runtime, task, sql, sentSince, ackKey } = yield* startSlackTurn(harness, "Ev33");
        const [ack] = yield* sql<{
          readonly message_json: string;
          readonly destination_kind: string;
        }>`
          SELECT message_json, destination_kind FROM channel_outbox WHERE cause_key = ${ackKey}`;
        const row = (id: string, kind: string, text: string) => ({
          delivery_id: id,
          cause_key: "test:" + id,
          input_id: null,
          task_id: task.taskId,
          kind,
          destination_kind: ack!.destination_kind,
          message_json: JSON.stringify({
            ...JSON.parse(ack!.message_json),
            deliveryId: id,
            kind,
            text,
            taskId: task.taskId,
          }),
          state: "pending",
          attempts: 0,
          next_attempt_at: "1970-01-01T00:00:00.000Z",
          created_at: "1970-01-01T00:00:00.000Z",
          updated_at: "1970-01-01T00:00:00.000Z",
        });
        const before = harness.slackSent.length;
        // Where the work runs, or that it moved to another machine, is an interim message too.
        yield* sql`INSERT INTO channel_outbox ${sql.insert(row("moved", "receipt", "Moved to mac-studio."))}`;
        yield* sql`INSERT INTO channel_outbox ${sql.insert(row("asked", "question", "Delete the old images?"))}`;
        yield* runtime.drain;
        assert.deepStrictEqual(sentSince(before), ["Delete the old images?"]);
        const [moved] = yield* sql<{ readonly state: string }>`
          SELECT state FROM channel_outbox WHERE delivery_id = 'moved'`;
        assert.strictEqual(moved?.state, "superseded");
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
