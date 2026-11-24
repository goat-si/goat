// @effect-diagnostics-next-line nodeBuiltinImport:off -- fixture signs the original byte body with HMAC.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import { BotId, CommandId, ScheduledTaskId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { hasPendingMigrations, runMigrations } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { BotEvent } from "../channels/ChannelBotEvents.ts";
import { watchRoutines } from "../channels/ChannelBotRoutineEvents.ts";
import {
  drainPendingDispatch,
  requestFor,
  waitForSpan,
  webhookTaskInput,
  withWebhookService,
} from "./ScheduledRunFixture.testkit.ts";
import { checkRollbackPredecessor } from "./rollbackPredecessorMigrations.testkit.ts";

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

it.effect(
  "a GOAT Bot routine stays in its conversation whatever thread mode a client asks for",
  () =>
    withWebhookService(
      ({ service, sql }) =>
        Effect.gen(function* () {
          yield* registerBot(sql);
          const input = yield* routineInput();
          const captured = { memoryGrantCeiling: "none" as const, owner };
          assert.strictEqual((yield* service.upsert(input, captured)).task.threadMode, "continue");
          const fresh = yield* service.upsert({ ...input, threadMode: "fresh_session" }, captured);
          assert.deepStrictEqual(
            [fresh.task.threadId, fresh.task.threadMode, fresh.task.goatBotRoutine],
            [botThread, "continue", true],
          );
          const rows = yield* sql<{ thread_mode: string }>`SELECT thread_mode FROM scheduled_tasks`;
          assert.deepStrictEqual(rows, [{ thread_mode: "continue" }]);
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
          // The answered manual firing stays in the routine's history; the scheduled one follows it.
          assert.deepStrictEqual(
            (yield* firings()).map((firing) => [
              firing.message_id.startsWith("scheduled-task-routine:"),
              firing.message_id.endsWith(":scheduled"),
            ]),
            [
              [true, false],
              [true, true],
            ],
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

it.effect("a paused work trigger keeps its mode on older saves and needs a secret to enable", () =>
  withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const captured = {
          memoryGrantCeiling: "none" as const,
          owner: {
            principalId: owner.principalId,
            grantedScopes: ["orchestration:operate", "settings:write"] as const,
            sessionId: "routine-owner-session",
          },
        };
        const signature = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" };
        const input = yield* routineInput({
          enabled: false,
          schedule: { type: "webhook", signature },
        });
        const draft = { ...input, routineMode: "work" as const };
        const { task } = yield* service.upsert(draft, captured);
        const freshId = ScheduledTaskId.make("fresh-work-trigger");
        assert.include(
          (yield* Effect.flip(service.upsert({ ...draft, id: freshId }))).message,
          "person",
        );
        assert.include(
          (yield* Effect.flip(service.upsert({ ...draft, id: freshId, enabled: true }, captured)))
            .message,
          "signing secret",
        );
        assert.include(
          (yield* Effect.flip(service.rotateWebhookToken({ id: task.id }))).message,
          "person",
        );
        assert.propertyVal(task, "routineMode", "work");
        assert.strictEqual(task.webhook?.hasSecret, false);
        assert.include(
          (yield* Effect.flip(service.setEnabled({ id: task.id, enabled: true }, captured)))
            .message,
          "signing secret",
        );
        assert.include(
          (yield* Effect.flip(service.upsert({ ...draft, enabled: true }, captured))).message,
          "signing secret",
        );
        const saved = yield* service.upsert(
          {
            ...input,
            title: "Older client edit",
            schedule: {
              type: "webhook",
              signature: { ...signature, encoding: "hex", secret: "synthetic-signing-secret" },
            },
          },
          captured,
        );
        assert.propertyVal(saved.task, "routineMode", "work");
        assert.strictEqual(saved.task.webhook?.hasSecret, true);
        for (const update of [
          service.upsert(draft),
          service.upsert({ ...input, threadId: null, threadMode: "new_thread" }),
          service.setEnabled({ id: task.id, enabled: true }),
        ]) {
          assert.include((yield* Effect.flip(update)).message, "person");
        }
        assert.strictEqual(
          (yield* service.setEnabled({ id: task.id, enabled: true }, captured)).task.enabled,
          true,
        );
      }),
    {},
  ),
);

it.effect("a signed webhook hands off one fenced input and a replay cannot start another", () =>
  withWebhookService(
    ({ service, sql, runs }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const secret = "synthetic-signing-secret";
        const captured = {
          memoryGrantCeiling: "none" as const,
          owner: {
            principalId: "person",
            sessionId: "fixture-session",
            grantedScopes: ["orchestration:operate", "settings:write"] as const,
          },
        };
        const { task } = yield* service.upsert(
          yield* routineInput({
            routineMode: "work",
            prompt: "Triage changes: {{body.action}}",
            schedule: {
              type: "webhook",
              signature: { header: "x-test-signature", encoding: "hex", prefix: "", secret },
            },
          }),
          captured,
        );
        const bodyText = '{"action":"fixture-marker"}';
        const body = new TextEncoder().encode(bodyText);
        const request = requestFor(task, { body, bodyText });
        assert.strictEqual((yield* service.triggerWebhook(request))._tag, "rejected_signature");
        const signed = {
          ...request,
          headers: {
            ...request.headers,
            "x-test-signature": NodeCrypto.createHmac("sha256", secret).update(body).digest("hex"),
          },
        };
        const delivery = yield* waitForSpan(
          service.triggerWebhook(signed),
          "ScheduledTaskService.runWebhookDelivery",
        );
        if (delivery._tag !== "accepted") return assert.fail("signed delivery was not accepted");
        const links =
          yield* sql<LinkRow>`SELECT firing_id, payload_json, state FROM scheduled_task_channel_inputs`;
        const deliveries = yield* service.listWebhookDeliveries({
          id: task.id,
          acceptAnyOutcome: true,
        });
        assert.lengthOf(
          links,
          1,
          JSON.stringify(
            deliveries.deliveries.map(({ outcome, error, signatureVerified }) => ({
              outcome,
              error,
              signatureVerified,
            })),
          ),
        );
        const payload = JSON.parse(links[0]?.payload_json ?? "{}");
        assert.strictEqual(payload.webhookDeliveryId, delivery.deliveryId);
        assert.include(payload.text, "fixture-marker");
        assert.notInclude(payload.text, "{{body.action}}");
        assert.include(payload.text, "untrusted");
        assert.strictEqual(
          (yield* runs.deliveryReceipt(delivery.deliveryId))?.dispatchStatus,
          "dispatching",
        );
        assert.deepInclude(yield* service.triggerWebhook(signed), { outcome: "duplicate" });
        assert.lengthOf(yield* sql`SELECT firing_id FROM scheduled_task_channel_inputs`, 1);
      }),
    {},
  ),
);

it.effect("a coalesced signed work delivery survives restart and hands off only one firing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secret = "coalesced-fixture-signing-secret";
    const accepted = yield* withWebhookService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* registerBot(sql);
          const { task } = yield* service.upsert(
            yield* routineInput({
              routineMode: "work",
              prompt: "Check the event: {{body.value}}",
              schedule: {
                type: "webhook",
                signature: { header: "x-test-signature", encoding: "hex", prefix: "", secret },
                dedupe: { coalesceKey: "{{body.group}}", coalesceWindowSeconds: 10 },
              },
            }),
            {
              memoryGrantCeiling: "none",
              owner: {
                principalId: owner.principalId,
                sessionId: "fixture-session",
                grantedScopes: ["orchestration:operate", "settings:write"],
              },
            },
          );
          const signed = (value: string) => {
            const bodyText = JSON.stringify({ group: "test", value });
            const body = new TextEncoder().encode(bodyText);
            const signature = NodeCrypto.createHmac("sha256", secret).update(body).digest("hex");
            return requestFor(task, {
              bodyText,
              body,
              headers: { "content-type": "application/json", "x-test-signature": signature },
            });
          };
          const first = yield* service.triggerWebhook(signed("first"));
          if (first._tag !== "accepted")
            return yield* Effect.die("Expected a pending webhook window");
          const latest = signed("latest");
          assert.deepInclude(yield* service.triggerWebhook(latest), { outcome: "coalesced" });
          assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_task_channel_inputs`, 0);
          return { first, latest };
        }),
      { sql, workers: new Map() },
    );
    yield* TestClock.adjust("10 seconds");
    const workers = new Map<string, Effect.Effect<void>>();
    yield* withWebhookService(
      ({ service, runs, launches }) =>
        Effect.gen(function* () {
          yield* drainPendingDispatch(workers);
          const [link, ...others] = yield* sql<LinkRow>`SELECT firing_id, state, payload_json
          FROM scheduled_task_channel_inputs`;
          assert.isDefined(link);
          assert.lengthOf(others, 0);
          assert.include(link?.payload_json ?? "", "latest");
          assert.include(link?.payload_json ?? "", accepted.first.deliveryId);
          assert.strictEqual(
            (yield* runs.deliveryReceipt(accepted.first.deliveryId))?.firingId,
            link?.firing_id,
          );
          assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`, 0);
          assert.deepInclude(yield* service.triggerWebhook(accepted.latest), {
            outcome: "duplicate",
          });
          assert.strictEqual(yield* Queue.size(launches), 0);
        }),
      { sql, workers },
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const eventTriggerOwner = {
  memoryGrantCeiling: "none" as const,
  owner: {
    principalId: owner.principalId,
    sessionId: "fixture-session",
    grantedScopes: ["orchestration:operate", "settings:write"] as const,
  },
};
const eventSecret = "event-fixture-signing-secret";
const eventSignature = {
  header: "x-test-signature",
  encoding: "hex",
  prefix: "",
  secret: eventSecret,
} as const;

it.effect("a second accepted signed delivery waits for intake and keeps its delivery id", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  let frames = 0;
  return withWebhookService(
    ({ service, sql, runs }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const { task } = yield* service.upsert(
          yield* routineInput({
            routineMode: "work",
            schedule: { type: "webhook", signature: eventSignature },
          }),
          eventTriggerOwner,
        );
        const first = yield* waitForSpan(
          service.triggerWebhook(signedEvent(task, "first")),
          "ScheduledTaskService.runWebhookDelivery",
        );
        const second = yield* waitForSpan(
          service.triggerWebhook(signedEvent(task, "second")),
          "ScheduledTaskService.runWebhookDelivery",
        );
        if (first._tag !== "accepted" || second._tag !== "accepted")
          return assert.fail("Both signed deliveries should be accepted");
        assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_task_channel_inputs`, 1);
        assert.deepStrictEqual(yield* sql`SELECT delivery_id FROM scheduled_task_webhook_pending`, [
          { delivery_id: second.deliveryId },
        ]);
        const pending = yield* service.getWebhookDelivery({
          id: task.id,
          deliveryId: second.deliveryId,
        });
        assert.deepInclude(pending.delivery, { firingAccepted: false, pendingWindow: false });
        const before = frames;
        yield* drainPendingDispatch(workers);
        assert.strictEqual(frames, before, "a busy retry must not frame the payload again");
        const receipt = yield* runs.deliveryReceipt(first.deliveryId);
        if (receipt === null) return assert.fail("First firing should exist");
        yield* runs.finishChannelFiring({
          firingId: receipt.firingId,
          outcome: { type: "accepted", threadId: task.threadId! },
          at: DateTime.formatIso(yield* DateTime.now),
        });
        yield* drainPendingDispatch(workers);
        assert.strictEqual(
          (yield* runs.deliveryReceipt(second.deliveryId))?.dispatchStatus,
          "dispatching",
        );
        assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_task_channel_inputs`, 2);
        assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`, 0);
      }),
    {
      workers,
      onFrame: () => {
        frames += 1;
      },
    },
  );
});

it.effect("a completed signed delivery keeps firing evidence after its run is pruned", () =>
  withWebhookService(
    ({ service, sql, runs }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const { task } = yield* service.upsert(
          yield* routineInput({
            routineMode: "work",
            schedule: { type: "webhook", signature: eventSignature },
          }),
          eventTriggerOwner,
        );
        const threadId = task.threadId;
        if (threadId === null || threadId === undefined)
          return assert.fail("Expected a bot thread");
        const deliveries = [];
        for (let index = 0; index < 8; index++) {
          yield* TestClock.adjust("1 second");
          const result = yield* waitForSpan(
            service.triggerWebhook(signedEvent(task, String(index))),
            "ScheduledTaskService.runWebhookDelivery",
          );
          if (result._tag !== "accepted") return assert.fail("Expected an accepted delivery");
          deliveries.push(result.deliveryId);
          const firing = yield* runs.deliveryReceipt(result.deliveryId);
          if (firing === null) return assert.fail("Expected a firing to settle");
          const at = DateTime.formatIso(yield* DateTime.now);
          yield* runs.finishChannelFiring({
            firingId: firing.firingId,
            outcome: { type: "accepted", threadId },
            at,
          });
          yield* runs.finishChannelFiring({
            firingId: firing.firingId,
            outcome: { type: "completed" },
            at,
          });
        }
        const deliveryId = deliveries[0]!;
        assert.isNull(yield* runs.deliveryReceipt(deliveryId));
        assert.deepInclude(
          (yield* service.getWebhookDelivery({ id: task.id, deliveryId })).delivery,
          { outcome: "accepted", firingAccepted: true },
        );
        assert.deepInclude(
          (yield* service.listWebhookDeliveries({ id: task.id })).deliveries.find(
            (delivery) => delivery.id === deliveryId,
          ),
          { outcome: "accepted", firingAccepted: true },
        );
      }),
    {},
  ),
);

it.effect("a signed delivery after a rebind starts its own coalescing window", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  return withWebhookService(
    ({ service, sql, runs }) =>
      Effect.gen(function* () {
        yield* registerBot(sql);
        const schedule = {
          type: "webhook",
          signature: eventSignature,
          dedupe: { coalesceKey: "{{body.group}}", coalesceWindowSeconds: 10 },
        };
        const { task } = yield* service.upsert(
          yield* routineInput({
            routineMode: "work",
            schedule,
            prompt: "Triage {{body.value}}",
          }),
          eventTriggerOwner,
        );
        assert.deepInclude(yield* service.triggerWebhook(signedEvent(task, "old")), {
          outcome: "accepted",
        });
        const { task: moved } = yield* service.upsert(
          yield* routineInput({
            projectId: "new-project",
            routineMode: "work",
            schedule,
            prompt: "Triage {{body.value}}",
          }),
          eventTriggerOwner,
        );
        const delivery = yield* service.triggerWebhook(signedEvent(moved, "new"));
        assert.deepInclude(delivery, { outcome: "accepted" });
        assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`, 2);
        yield* TestClock.adjust("10 seconds");
        yield* drainPendingDispatch(workers);
        if (delivery._tag !== "accepted") return assert.fail("Expected signed delivery");
        const [link, ...others] = yield* sql<LinkRow>`SELECT * FROM scheduled_task_channel_inputs`;
        assert.lengthOf(others, 0);
        assert.include(link?.payload_json ?? "", "new-project");
        assert.include(link?.payload_json ?? "", "Triage");
        assert.strictEqual(
          (yield* runs.deliveryReceipt(delivery.deliveryId))?.firingId,
          link?.firing_id,
        );
      }),
    { workers },
  );
});

function signedEvent(task: Parameters<typeof requestFor>[0], value: string) {
  const bodyText = JSON.stringify({ group: "one", value });
  const body = new TextEncoder().encode(bodyText);
  const signature = NodeCrypto.createHmac("sha256", eventSecret).update(body).digest("hex");
  return requestFor(task, {
    body,
    bodyText,
    headers: { "content-type": "application/json", "x-test-signature": signature },
  });
}

it.effect("work triggers fence startup on a build that cannot enforce their grants", () =>
  withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
        const checkOldBuild = (through: 176 | 177) => checkRollbackPredecessor(sql, through);
        assert.isUndefined(yield* checkOldBuild(176));
        assert.isUndefined(yield* checkOldBuild(177));
        yield* registerBot(sql);
        yield* service.upsert(
          yield* routineInput({
            routineMode: "work",
            enabled: false,
            schedule: { type: "webhook", signature: eventSignature },
          }),
          eventTriggerOwner,
        );
        for (const through of [176, 177] as const) {
          assert.include(
            (yield* checkOldBuild(through))?.message ?? "",
            "would skip required schema migrations",
            `startup through migration ${through} must refuse the database`,
          );
        }
        const migrate = runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, sql));
        assert.isEmpty(yield* migrate);
        yield* sql`UPDATE effect_sql_migrations SET name='ChannelLedger' WHERE name='ChannelLedgerRequiresWorkerReleaseAuthority'`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 177`;
        yield* sql`ALTER TABLE channel_inbox DROP COLUMN auth_session_id`;
        yield* sql`ALTER TABLE remote_dispatches DROP COLUMN remote_environment_id`;
        yield* sql`DROP TABLE channel_bot_attention`;
        yield* sql`DROP INDEX channel_bot_attention_approval_openings`;
        yield* sql`DROP TRIGGER turn_memory_delete_thread`;
        yield* sql`DROP TABLE turn_memory_receipts`;
        yield* sql`DROP TABLE turn_memory_receipt_failures`;
        yield* sql`DROP TABLE scheduled_task_webhook_firings`;
        yield* sql`DROP TABLE channel_worker_generations`;
        yield* sql`DROP TRIGGER channel_task_status_version`;
        yield* sql`DROP INDEX channel_task_views_by_task`;
        yield* sql`ALTER TABLE channel_tasks DROP COLUMN status_version`;
        yield* sql`DELETE FROM channel_runtime_state WHERE key = 'bot-task-activity-since'`;
        yield* sql`ALTER TABLE channel_conversations DROP COLUMN slack_bot_id`;
        assert.isUndefined(yield* checkOldBuild(176));
        assert.deepStrictEqual(
          yield* runMigrations({ toMigrationInclusive: 177 }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
          [[177, "WorkTriggerAuthorityFence"]],
        );
        assert.isUndefined(yield* checkOldBuild(177));
        assert.deepStrictEqual(yield* migrate, [
          [178, "WebhookDeliveryFiringEvidence"],
          [179, "ChannelWorkerGenerations"],
          [180, "ChannelBotTaskSnooze"],
          [181, "ChannelBotAttention"],
          [182, "SlackConversationBot"],
          [183, "ChannelInputSessionAuthority"],
          [184, "RemoteDispatchEnvironment"],
          [185, "TurnMemoryReceipts"],
        ]);
        for (const through of [176, 177] as const) {
          assert.include(
            (yield* checkOldBuild(through))?.message ?? "",
            "would skip required schema migrations",
          );
        }
        assert.isEmpty(yield* migrate);
      }),
    {},
  ),
);

it.effect(
  "both predecessors refuse a second rollback after the older writer adds work triggers",
  () =>
    withWebhookService(({ sql }) =>
      Effect.gen(function* () {
        assert.isUndefined(yield* checkRollbackPredecessor(sql, 176));
        assert.isUndefined(yield* checkRollbackPredecessor(sql, 177));
        // The older writer fences a work routine on write. Its input can outlive deletion of the routine.
        yield* sql`UPDATE effect_sql_migrations SET name = 'ChannelLedgerRequiresWorkTriggerAuthority'
        WHERE name = 'ChannelLedger'`;
        yield* sql`INSERT INTO scheduled_task_channel_inputs
        (firing_id, task_id, input_id, payload_json, state, created_at)
        VALUES ('rollback-firing', 'rollback-routine', 'rollback-input',
          '{"routineMode":"work"}', 'settled', '2026-11-21T00:00:00Z')`;
        assert.include(
          (yield* checkRollbackPredecessor(sql, 176))?.message ?? "",
          "93_ChannelLedger (recorded: ChannelLedgerRequiresWorkTriggerAuthority)",
        );
        assert.isUndefined(yield* checkRollbackPredecessor(sql, 177));
        const migrate = runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, sql));
        assert.isEmpty(yield* migrate);
        for (const through of [176, 177] as const) {
          assert.include(
            (yield* checkRollbackPredecessor(sql, through))?.message ?? "",
            "93_ChannelLedger (recorded: ChannelLedgerRequiresWorkerReleaseAuthority)",
          );
        }
        assert.isEmpty(yield* migrate);
      }),
    ),
);

it.effect.each(["with indexes", "without indexes"] as const)(
  "startup %s fences a work-trigger input written by #3795 after migration 179 without changing the schema",
  (indexState) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepInclude(yield* runMigrations({ skipStartupRepairs: true }), [
        179,
        "ChannelWorkerGenerations",
      ]);
      if (indexState === "without indexes") {
        yield* sql`DROP INDEX IF EXISTS scheduled_tasks_work_trigger_idx`;
        yield* sql`DROP INDEX IF EXISTS scheduled_task_channel_inputs_work_trigger_idx`;
        yield* sql`DROP INDEX IF EXISTS channel_tasks_work_trigger_idx`;
      }
      const at = "2026-11-21T00:00:00.000Z";
      const payload = JSON.stringify({
        ...owner,
        routineMode: "work",
        threadId: botThread,
        text: "Triage the event",
        receivedAt: at,
        projectId: "rollback-project",
        webhookDeliveryId: "rollback-delivery",
        taskCreatedAt: at,
      });
      yield* sql`INSERT INTO scheduled_task_channel_inputs
      (firing_id, task_id, payload_json, state, created_at)
      VALUES ('rollback-firing', 'rollback-routine', ${payload}, 'pending', ${at})`;
      for (const through of [176, 177] as const) {
        assert.isUndefined(yield* checkRollbackPredecessor(sql, through));
      }

      assert.isFalse(yield* hasPendingMigrations());
      const schemaVersion = yield* sql`PRAGMA schema_version`;
      assert.isEmpty(yield* runMigrations());
      assert.deepStrictEqual(yield* sql`PRAGMA schema_version`, schemaVersion);

      for (const through of [176, 177] as const) {
        assert.include(
          (yield* checkRollbackPredecessor(sql, through))?.message ?? "",
          "93_ChannelLedger (recorded: ChannelLedgerRequiresWorkerReleaseAuthority)",
          `startup through migration ${through} must refuse the database`,
        );
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
