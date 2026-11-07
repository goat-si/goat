import { assert, it } from "@effect/vitest";
import { BotId, CommandId, ScheduledTaskId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { BotEvent } from "../channels/ChannelBotEvents.ts";
import { watchRoutines } from "../channels/ChannelBotRoutineEvents.ts";
import { webhookTaskInput, withWebhookService } from "./ScheduledRunFixture.testkit.ts";

const botThread = "goat-bot-thread";
const owner = { principalId: "person", grantedScopes: ["orchestration:read" as const] };
const routineInput = (overrides: Record<string, unknown> = {}) =>
  webhookTaskInput({
    id: "goat-bot-check-in:goat-bot-thread",
    title: "Check in",
    prompt: "Look over my GOAT Bot tasks.",
    schedule: { type: "interval", everyMs: 3_600_000 },
    threadId: botThread,
    notificationPolicy: "important_updates",
    runtimeMode: "approval-required",
    ...overrides,
  });
interface LinkRow {
  readonly firing_id: string;
  readonly payload_json: string;
  readonly state: string;
}

/** The GOAT Bot as the channel ledger records it, read by the real SQL directory. */
const registerBot = (sql: SqlClient.SqlClient) =>
  sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
    VALUES ('bot:environment:test', ${JSON.stringify({ bot: { threadId: botThread } })}, '2026-11-07T00:00:00.000Z')`;

it.effect("only a person's owner context can bind a routine to a GOAT Bot thread", () =>
  withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const input = yield* routineInput();
        const agent = yield* Effect.flip(service.upsert(input, { memoryGrantCeiling: "none" }));
        assert.include(agent.message, "Only a person");
        const webhook = yield* Effect.flip(
          service.upsert(yield* routineInput({ schedule: { type: "webhook" } }), {
            memoryGrantCeiling: "none",
            owner,
          }),
        );
        assert.include(webhook.message, "schedule");
        yield* service.upsert(input, { memoryGrantCeiling: "none", owner });
        const rows = yield* sql<{
          owner_json: string | null;
        }>`SELECT owner_json FROM scheduled_tasks`;
        assert.deepStrictEqual(
          rows.map((row) => JSON.parse(row.owner_json ?? "null")),
          [owner],
        );
      }),
    {},
  ),
);

it.effect("a GOAT Bot routine firing freezes its input with the admission and sends nothing", () =>
  withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const input = yield* routineInput();
        const task = (yield* service.upsert(input, { memoryGrantCeiling: "none", owner })).task;
        yield* service.runNow({ id: task.id });
        // The routine changes after admission; the stored input does not.
        yield* service.upsert(
          { ...input, prompt: "Something else." },
          {
            memoryGrantCeiling: "none",
            owner,
          },
        );
        const links = yield* sql<LinkRow>`SELECT * FROM scheduled_task_channel_inputs`;
        assert.lengthOf(links, 1);
        assert.strictEqual(links[0]?.state, "pending");
        assert.deepInclude(JSON.parse(links[0]?.payload_json ?? "{}"), {
          threadId: botThread,
          text: "Look over my GOAT Bot tasks.",
          principalId: "person",
          grantedScopes: ["orchestration:read"],
        });
        const firings = yield* sql<{ firing_id: string; status: string }>`
          SELECT firing_id, status FROM scheduled_task_runs`;
        assert.deepStrictEqual(firings, [
          { firing_id: links[0]?.firing_id ?? "", status: "dispatching" },
        ]);
      }),
    {},
  ),
);

it.effect("a channel firing advances the next run once and reports the bot's outcome", () =>
  withWebhookService(
    ({ service, sql, runs }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const input = yield* routineInput();
        const task = (yield* service.upsert(input, { memoryGrantCeiling: "none", owner })).task;
        yield* service.runNow({ id: task.id });
        const [link] = yield* sql<LinkRow>`SELECT * FROM scheduled_task_channel_inputs`;
        const firingId = CommandId.make(link?.firing_id ?? "");
        const before = (yield* service.list()).tasks[0]?.nextRunAt;
        yield* runs.finishChannelFiring({
          firingId,
          outcome: { type: "accepted", threadId: task.threadId! },
          at: "2026-11-09T08:00:00.000Z",
        });
        const accepted = (yield* service.list()).tasks[0];
        assert.strictEqual(accepted?.lastRunStatus, "running");
        assert.notStrictEqual(accepted?.nextRunAt, before);
        assert.strictEqual(accepted?.nextRunAt, "2026-11-09T09:00:00.000Z");
        // Recovery repeating the step changes nothing.
        yield* runs.finishChannelFiring({
          firingId,
          outcome: { type: "accepted", threadId: task.threadId! },
          at: "2026-11-09T08:30:00.000Z",
        });
        assert.strictEqual((yield* service.list()).tasks[0]?.nextRunAt, "2026-11-09T09:00:00.000Z");
        yield* runs.finishChannelFiring({
          firingId,
          outcome: { type: "completed" },
          at: "2026-11-09T08:01:00.000Z",
        });
        assert.strictEqual((yield* service.list()).tasks[0]?.lastRunStatus, "succeeded");
      }),
    {},
  ),
);

it.effect("a routine the bot refused before storing its input fails with the reason", () =>
  withWebhookService(
    ({ service, sql, runs }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const input = yield* routineInput();
        const task = (yield* service.upsert(input, { memoryGrantCeiling: "none", owner })).task;
        yield* service.runNow({ id: task.id });
        const [link] = yield* sql<LinkRow>`SELECT * FROM scheduled_task_channel_inputs`;
        yield* runs.finishChannelFiring({
          firingId: CommandId.make(link?.firing_id ?? ""),
          outcome: { type: "failed", error: "That bot was deleted." },
          at: "2026-11-09T08:00:00.000Z",
        });
        const failed = (yield* service.list()).tasks[0];
        assert.strictEqual(failed?.lastRunStatus, "failed");
        assert.strictEqual(failed?.lastRunError, "That bot was deleted.");
        assert.strictEqual(failed?.nextRunAt, "2026-11-09T09:00:00.000Z");
      }),
    {},
  ),
);

it.effect("startup reconcile leaves channel firings to the channel side", () =>
  withWebhookService(
    ({ service, sql, runs }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const task = (yield* service.upsert(yield* routineInput(), {
          memoryGrantCeiling: "none",
          owner,
        })).task;
        yield* service.runNow({ id: task.id });
        yield* runs.reconcile;
        const firings = yield* sql<{ status: string }>`SELECT status FROM scheduled_task_runs`;
        assert.deepStrictEqual(firings, [{ status: "dispatching" }]);
      }),
    {},
  ),
);

it.effect("a routine bound to a GOAT Bot thread before owners existed fails and says why", () =>
  withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const task = (yield* service.upsert(yield* routineInput(), {
          memoryGrantCeiling: "none",
          owner,
        })).task;
        yield* sql`UPDATE scheduled_tasks SET owner_json = NULL`;
        yield* service.runNow({ id: task.id }).pipe(Effect.ignore);
        const failed = (yield* service.list()).tasks[0];
        assert.strictEqual(failed?.lastRunStatus, "failed");
        assert.include(failed?.lastRunError ?? "", "Set this routine up again");
        assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_task_channel_inputs`, 0);
      }),
    {},
  ),
);
it.effect("a routine keeps its GOAT Bot binding after the bot's thread is replaced", () => {
  return withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const input = yield* routineInput();
        const task = (yield* service.upsert(input, { memoryGrantCeiling: "none", owner })).task;
        // The registry replaced the bot's thread: the old one is no longer a bot thread.
        yield* sql`DELETE FROM channel_runtime_state`;
        yield* service.upsert(
          { ...input, title: "Morning check-in" },
          {
            memoryGrantCeiling: "none",
            owner,
          },
        );
        const [saved] = yield* sql<{
          owner_json: string | null;
        }>`SELECT owner_json FROM scheduled_tasks`;
        assert.deepStrictEqual(JSON.parse(saved?.owner_json ?? "null"), owner);
        yield* service.runNow({ id: task.id });
        // Still a channel firing: linked for the bot, never sent to the thread directly.
        const links = yield* sql<LinkRow>`SELECT * FROM scheduled_task_channel_inputs`;
        assert.lengthOf(links, 1);
        const firings = yield* sql<{ message_id: string; status: string }>`
          SELECT message_id, status FROM scheduled_task_runs`;
        assert.deepStrictEqual(
          firings.map((firing) => [
            firing.message_id.startsWith("scheduled-task-routine:"),
            firing.status,
          ]),
          [[true, "dispatching"]],
        );
      }),
    {},
  );
});
it.effect("a GOAT Bot routine says so to clients, even after its bot thread is replaced", () =>
  withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const saved = yield* service.upsert(yield* routineInput(), {
          memoryGrantCeiling: "none",
          owner,
        });
        assert.strictEqual(saved.task.goatBotRoutine, true);
        yield* service.upsert(
          yield* routineInput({ id: "scheduled-task:coding", threadId: "coding-thread" }),
          { memoryGrantCeiling: "none", owner },
        );
        yield* service.upsert(
          yield* routineInput({
            id: "scheduled-task:fresh",
            threadId: null,
            notificationPolicy: "all_runs",
          }),
          { memoryGrantCeiling: "none" },
        );
        yield* sql`DELETE FROM channel_runtime_state`;
        const marked = (yield* service.list()).tasks.map(
          (task) => `${task.id}: ${task.goatBotRoutine === true ? "GOAT Bot" : "-"}`,
        );
        assert.sameMembers(marked, [
          "goat-bot-check-in:goat-bot-thread: GOAT Bot",
          "scheduled-task:coding: -",
          "scheduled-task:fresh: -",
        ]);
      }),
    {},
  ),
);
it.effect("an owner the server cannot read does not mark a routine as GOAT Bot's", () =>
  withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        yield* service.upsert(yield* routineInput(), { memoryGrantCeiling: "none", owner });
        yield* sql`UPDATE scheduled_tasks SET owner_json = '{"principalId":1}'`;
        assert.isUndefined((yield* service.list()).tasks[0]?.goatBotRoutine);
      }),
    {},
  ),
);
it.effect("a routine and its owner are saved together or not at all", () =>
  withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        // The owner write fails, as a crash between the two writes would leave it.
        yield* sql`CREATE TRIGGER refuse_owner BEFORE UPDATE OF owner_json ON scheduled_tasks
          BEGIN SELECT RAISE(ABORT, 'owner write failed'); END`;
        yield* Effect.flip(
          service.upsert(yield* routineInput(), { memoryGrantCeiling: "none", owner }),
        );
        assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_tasks`, 0);
      }),
    {},
  ),
);
it.effect(
  "a person's check-in becomes GOAT Bot input on Run now and on schedule, as the server assembles it",
  () => {
    const workers = new Map<string, Effect.Effect<void>>();
    return withWebhookService(
      ({ service, sql, runs }) =>
        Effect.gen(function* () {
          yield* registerBot(sql);
          const task = (yield* service.upsert(yield* routineInput(), {
            memoryGrantCeiling: "none",
            owner,
          })).task;
          yield* Effect.exit(service.runNow({ id: task.id }));
          const firings = () =>
            sql<{ message_id: string; status: string }>`
              SELECT message_id, status FROM scheduled_task_runs ORDER BY requested_at`;
          assert.deepStrictEqual(
            (yield* firings()).map((firing) =>
              firing.message_id.startsWith("scheduled-task-routine:"),
            ),
            [true],
          );
          // The channel side answers the firing; then the schedule comes due on its own.
          const [link] = yield* sql<LinkRow>`SELECT * FROM scheduled_task_channel_inputs`;
          const firingId = CommandId.make(link?.firing_id ?? "");
          const at = DateTime.formatIso(yield* DateTime.now);
          yield* runs.finishChannelFiring({
            firingId,
            outcome: { type: "accepted", threadId: task.threadId! },
            at,
          });
          yield* runs.finishChannelFiring({ firingId, outcome: { type: "completed" }, at });
          yield* TestClock.adjust(Duration.hours(2));
          yield* workers.get("scheduled-tasks") ?? Effect.die("scheduler worker missing");
          // The answered manual firing is pruned; the scheduled one is the routine's next firing.
          assert.deepStrictEqual(
            (yield* firings()).map((firing) => [
              firing.message_id.startsWith("scheduled-task-routine:"),
              firing.message_id.endsWith(":scheduled"),
            ]),
            [[true, true]],
          );
          assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_task_channel_inputs`, 2);
        }),
      { workers },
    );
  },
);

it.effect(
  "the routine line watcher sees set up, pause and resume made through the real service",
  () =>
    withWebhookService(
      ({ service, sql }) =>
        Effect.gen(function* () {
          yield* registerBot(sql);
          const lines = yield* Queue.unbounded<BotEvent>();
          const snapshots = yield* Queue.unbounded<number>();
          yield* watchRoutines({
            subscribe: () =>
              service
                .subscribeList()
                .pipe(Stream.tap((result) => Queue.offer(snapshots, result.tasks.length))),
            botForThread: (threadId) =>
              Effect.succeed(
                threadId === botThread
                  ? { ownerId: "owner", botId: BotId.make("main") }
                  : undefined,
              ),
            emit: (event) => Queue.offer(lines, event).pipe(Effect.asVoid),
          }).pipe(Effect.forkScoped);
          // The watcher's first snapshot is its baseline; change routines only after it.
          assert.strictEqual(yield* Queue.take(snapshots), 0);
          // The feed keeps only the latest list, so each change waits for the line before it.
          const saved = yield* service.upsert(yield* routineInput(), {
            memoryGrantCeiling: "none",
            owner,
          });
          assert.strictEqual((yield* Queue.take(lines)).text, "Routine Check in set up");
          const id = ScheduledTaskId.make(saved.task.id);
          yield* service.setEnabled({ id, enabled: false });
          assert.strictEqual((yield* Queue.take(lines)).text, "Routine Check in paused");
          yield* service.upsert(yield* routineInput({ enabled: true }), {
            memoryGrantCeiling: "none",
            owner,
          });
          assert.strictEqual((yield* Queue.take(lines)).text, "Routine Check in resumed");
        }).pipe(Effect.scoped),
      {},
    ),
);
