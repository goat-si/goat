import { assert, it } from "@effect/vitest";
import { CommandId } from "@goat/contracts";
import * as Effect from "effect/Effect";
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

it.effect("only a person's owner context can bind a routine to a GOAT Bot thread", () =>
  withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
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
    { botThreads: new Set([botThread]) },
  ),
);

it.effect("a GOAT Bot routine firing freezes its input with the admission and sends nothing", () =>
  withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
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
    { botThreads: new Set([botThread]) },
  ),
);

it.effect("a channel firing advances the next run once and reports the bot's outcome", () =>
  withWebhookService(
    ({ service, sql, runs }) =>
      Effect.gen(function* () {
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
    { botThreads: new Set([botThread]) },
  ),
);

it.effect("a routine the bot refused before storing its input fails with the reason", () =>
  withWebhookService(
    ({ service, sql, runs }) =>
      Effect.gen(function* () {
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
    { botThreads: new Set([botThread]) },
  ),
);

it.effect("startup reconcile leaves channel firings to the channel side", () =>
  withWebhookService(
    ({ service, sql, runs }) =>
      Effect.gen(function* () {
        const task = (yield* service.upsert(yield* routineInput(), {
          memoryGrantCeiling: "none",
          owner,
        })).task;
        yield* service.runNow({ id: task.id });
        yield* runs.reconcile;
        const firings = yield* sql<{ status: string }>`SELECT status FROM scheduled_task_runs`;
        assert.deepStrictEqual(firings, [{ status: "dispatching" }]);
      }),
    { botThreads: new Set([botThread]) },
  ),
);

it.effect("a routine bound to a GOAT Bot thread before owners existed fails and says why", () =>
  withWebhookService(
    ({ service, sql }) =>
      Effect.gen(function* () {
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
    { botThreads: new Set([botThread]) },
  ),
);
