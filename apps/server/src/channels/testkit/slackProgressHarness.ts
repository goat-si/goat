/**
 * A Slack turn over the real ledger and worker, with a fake Slack transport that returns a ts for
 * every post and records each edit and removal of a message GOAT already sent.
 */
import type {
  ChannelGatewayError,
  ChannelOutboundMessage,
  ChannelReceptionInput,
} from "@goat/contracts";
import { ProviderInstanceId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../../serverSettings.ts";
import * as ChannelGateway from "../ChannelGateway.ts";
import * as ChannelRuntime from "../ChannelRuntime.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import * as ChannelWorkerReports from "../ChannelWorkerReports.ts";
import { receptionDecisionChannels } from "./channelReceptionHarness.ts";
import {
  defaultScript,
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  setupBot,
  slackContext,
  slackInput,
} from "./ChannelHarness.ts";

export interface ProgressCall {
  readonly operation: "edit" | "remove";
  readonly ts: string;
  readonly text?: string;
}

interface Hold {
  readonly reached: Deferred.Deferred<void>;
  readonly open: Deferred.Deferred<void>;
}

/** "look:" asks GOAT Bot to take a turn itself; anything else follows the default script. */
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

export const makeProgressHarness = () => {
  const harness = makeHarness({
    botWorkspace: true,
    channelsLayer: receptionDecisionChannels,
    fakeSlackTransport: false,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: modelSelection,
      goatBotModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
    }).pipe(Layer.orDie),
  });
  harness.script.current = turnScript;
  const posts: Array<ChannelOutboundMessage> = [];
  const calls: Array<ProgressCall> = [];
  /** What the next edits and removals return, in order; done once empty. */
  const results: Array<ChannelTransport.ChannelProgressResult> = [];
  const postFailures: Array<ChannelGatewayError> = [];
  const holds: Array<Hold> = [];
  let count = 0;
  const progress = (call: ProgressCall) =>
    Effect.gen(function* () {
      calls.push(call);
      const hold = holds.shift();
      if (hold !== undefined) {
        yield* Deferred.succeed(hold.reached, undefined);
        yield* Deferred.await(hold.open);
      }
      return results.shift() ?? { _tag: "done" as const };
    });
  const transport = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* ChannelTransport.ChannelTransportRegistry;
      yield* registry.register({
        kind: "slack",
        send: (message) =>
          Effect.suspend(() => {
            const failure = postFailures.shift();
            if (failure !== undefined) return Effect.fail(failure);
            posts.push(message);
            count += 1;
            return Effect.succeed({
              deliveryId: message.deliveryId,
              acceptedAt: "2026-10-12T00:00:01.000Z",
              externalMessageId: "1760000001." + String(count).padStart(6, "0"),
            });
          }),
        edit: ({ message, externalMessageId }) =>
          progress({ operation: "edit", ts: externalMessageId, text: message.text }),
        remove: ({ externalMessageId }) => progress({ operation: "remove", ts: externalMessageId }),
      });
    }),
  );
  /** Makes the next edit or removal wait, after it reached Slack, until the test opens it. */
  const hold = Effect.gen(function* () {
    const entry: Hold = {
      reached: yield* Deferred.make<void>(),
      open: yield* Deferred.make<void>(),
    };
    holds.push(entry);
    return entry;
  });
  return {
    harness,
    posts,
    calls,
    results,
    postFailures,
    hold,
    layer: transport.pipe(Layer.provideMerge(harness.layer)),
  };
};

export type ProgressHarness = ReturnType<typeof makeProgressHarness>;

export interface OutboxRow {
  readonly delivery_id: string;
  readonly cause_key: string;
  readonly operation: string;
  readonly target_delivery_id: string | null;
  readonly state: string;
  readonly kind: string;
  readonly input_id: string | null;
  readonly task_id: string | null;
  readonly destination_kind: string;
  readonly message_json: string;
  readonly last_error_code: string | null;
  readonly next_attempt_at: string;
}

/** A Slack request whose acknowledgement reached the person, ready for milestones. */
export const startSlackTask = (
  h: ProgressHarness,
  key: string,
  text = "look: why is the disk full?",
) =>
  Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    const sql = yield* SqlClient.SqlClient;
    yield* gateway.ingest(slackInput(text, key), slackContext);
    yield* runtime.drain;
    yield* reports.reconcile(runtime.ownerToken);
    const task = yield* onlyTask;
    const workerThreadId = task.worker?.threadId;
    if (workerThreadId === undefined) return yield* Effect.die(new Error("the task has no worker"));
    const ackKey = "reply:" + task.originInputId;
    const [ack] = yield* sql<{
      readonly delivery_id: string;
      readonly message_json: string;
      readonly external_message_id: string | null;
      readonly state: string;
    }>`SELECT delivery_id, message_json, external_message_id, state FROM channel_outbox
      WHERE cause_key = ${ackKey}`;
    if (ack === undefined) return yield* Effect.die(new Error("no acknowledgement row"));
    let milestones = 0;
    /** Reports a milestone without running the channel loop. */
    const report = (summary: string) =>
      reports.report(
        {
          taskId: task.taskId,
          generation: task.generation,
          eventId: (key + "-m" + ++milestones) as never,
          status: "running",
          summary,
        },
        workerThreadId,
      );
    /** Reports a milestone and lets the channel loop run. */
    const milestone = (summary: string) => report(summary).pipe(Effect.andThen(runtime.drain));
    /** Ends the worker's run with this summary and lets the channel loop run. */
    const finish = (summary: string, status: "completed" | "failed" = "completed") =>
      Effect.gen(function* () {
        h.harness.world.setStatus(workerThreadId, 1, status, summary);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
      });
    const rows = sql<OutboxRow>`SELECT delivery_id, cause_key, operation, target_delivery_id, state,
      kind, input_id, task_id, destination_kind, message_json, last_error_code, next_attempt_at
      FROM channel_outbox WHERE task_id = ${task.taskId} AND destination_kind = 'slack'
      ORDER BY rowid`;
    const ofOperation = (operation: string) =>
      Effect.map(rows, (all) => all.filter((row) => row.operation === operation));
    /** Records how the person's request was acknowledged, as session-first reception does. */
    const acknowledgedBy = (source: "session" | "fallback" | "fixed") =>
      sql`INSERT INTO channel_session_receipts (input_id, task_id, source, text, committed_at)
        VALUES (${task.originInputId}, ${task.taskId}, ${source},
          ${JSON.parse(ack.message_json).text}, '1970-01-01T00:00:00.000Z')`;
    /** Another task of the same request, such as a sibling or a skill proposal. */
    const copyTask = (taskId: string) =>
      Effect.gen(function* () {
        yield* sql`CREATE TEMP TABLE task_copy AS SELECT * FROM channel_tasks WHERE task_id = ${task.taskId}`;
        yield* sql`UPDATE task_copy SET task_id = ${taskId}, worker_thread_id = NULL, status = 'running',
          task_json = json_set(task_json, '$.taskId', ${taskId})`;
        yield* sql`INSERT INTO channel_tasks SELECT * FROM task_copy`;
        yield* sql`DROP TABLE task_copy`;
      });
    return {
      workerThreadId,
      copyTask,
      runtime,
      reports,
      sql,
      task,
      ack: {
        ...ack,
        ts: ack.external_message_id,
        text: JSON.parse(ack.message_json).text as string,
      },
      report,
      milestone,
      finish,
      rows,
      ofOperation,
      acknowledgedBy,
    };
  });
