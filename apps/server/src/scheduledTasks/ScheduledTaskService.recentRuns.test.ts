import { assert, it } from "@effect/vitest";
import {
  ChannelInputId,
  CommandId,
  SCHEDULED_TASK_RECENT_RUN_BYTES,
  SCHEDULED_TASK_RECENT_RUN_ROUTINES,
  SCHEDULED_TASK_RECENT_RUNS,
  ScheduledTaskId,
  ScheduledTaskListResult,
  ThreadId,
  type ScheduledTask,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { webhookTaskInput, withWebhookService } from "./ScheduledRunFixture.testkit.ts";

type Fixture = Parameters<Parameters<typeof withWebhookService>[0]>[0];

const botThread = ThreadId.make("goat-bot-thread");
const owner = { principalId: "person", grantedScopes: ["orchestration:read" as const] };

/** A GOAT Bot routine on the bot's thread, saved as a person sets it up. */
const saveRoutine = ({ service, sql }: Fixture, id = "goat-bot-check-in:goat-bot-thread") =>
  Effect.gen(function* () {
    yield* sql`INSERT OR IGNORE INTO channel_runtime_state (key, value_json, updated_at)
      VALUES ('bot:environment:test', ${JSON.stringify({ bot: { threadId: botThread } })}, '2026-11-07T00:00:00.000Z')`;
    const input = yield* webhookTaskInput({
      id,
      title: "Check in",
      prompt: "Look over my GOAT Bot tasks.",
      schedule: { type: "interval", everyMs: 3_600_000 },
      threadId: botThread,
      notificationPolicy: "important_updates",
      runtimeMode: "approval-required",
    });
    return (yield* service.upsert(input, { memoryGrantCeiling: "none", owner })).task;
  });

const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** Run now, a second after the last firing, as the scheduler admits it; returns the firing. */
const fire = ({ service, sql }: Fixture, task: ScheduledTask) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(Duration.seconds(1));
    yield* service.runNow({ id: task.id });
    const [newest] = yield* sql<{
      readonly firing_id: string;
    }>`SELECT firing_id FROM scheduled_task_runs
      WHERE task_id = ${task.id} ORDER BY requested_at DESC LIMIT 1`;
    return CommandId.make(newest?.firing_id ?? "");
  });

/** What ChannelRoutineIntake does when the bot takes a firing: store its input, then accept it. */
const accept = ({ sql, runs }: Fixture, firingId: CommandId) =>
  Effect.gen(function* () {
    const inputId = ChannelInputId.make(`input:${firingId}`);
    yield* sql`UPDATE scheduled_task_channel_inputs SET input_id = ${inputId}, state = 'ingested'
      WHERE firing_id = ${firingId}`;
    yield* runs.finishChannelFiring({
      firingId,
      outcome: { type: "accepted", threadId: botThread },
      at: yield* now,
    });
    return inputId;
  });

/** The bot's answer as reception stores it; a quiet one is its no_update decision. */
const answer = (
  { sql, runs }: Fixture,
  firingId: CommandId,
  inputId: string,
  quiet: boolean | "malformed",
) =>
  Effect.gen(function* () {
    yield* sql`INSERT OR IGNORE INTO channel_conversations
      (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
      VALUES ('conversation', 'owner', 'goat', 'goat', ${botThread}, '2026-11-07T00:00:00.000Z')`;
    yield* sql`INSERT OR IGNORE INTO channel_bindings
      (binding_id, conversation_id, connection_id, reply_address_json, last_activity_at)
      VALUES ('binding', 'conversation', 'goat', '{}', '2026-11-07T00:00:00.000Z')`;
    const decision = { replyText: "Done.", action: { type: quiet ? "no_update" : "report_only" } };
    const decisionJson = quiet === "malformed" ? "{" : JSON.stringify(decision);
    yield* sql`INSERT INTO channel_inbox (input_id, owner_id, kind, connection_id, idempotency_key,
      content_hash, conversation_id, binding_id, message_json, state, accepted_at, decision_json)
      VALUES (${inputId}, 'owner', 'goat', 'goat', ${inputId}, '', 'conversation', 'binding', '{}',
      'replied', '2026-11-07T00:00:00.000Z', ${decisionJson})`;
    yield* runs.finishChannelFiring({ firingId, outcome: { type: "completed" }, at: yield* now });
  });

const refuse = ({ runs }: Fixture, firingId: CommandId) =>
  Effect.gen(function* () {
    yield* runs.finishChannelFiring({
      firingId,
      outcome: { type: "failed", error: "GOAT Bot could not take this routine's check-in." },
      at: yield* now,
    });
  });

const historyOf = (result: { readonly tasks: ReadonlyArray<ScheduledTask> }, id: string) =>
  result.tasks.find((task) => task.id === id)?.recentRuns;

const encodeList = Schema.encodeSync(Schema.fromJsonString(ScheduledTaskListResult));

it.effect("a GOAT Bot routine lists its newest seven runs, newest first, with what each sent", () =>
  withWebhookService((fixture) =>
    Effect.gen(function* () {
      const routine = yield* saveRoutine(fixture);
      const ordinary = (yield* fixture.service.upsert(
        yield* webhookTaskInput({ schedule: { type: "interval", everyMs: 3_600_000 } }),
        { memoryGrantCeiling: "none" },
      )).task;
      const expected: Array<Array<string | boolean | undefined>> = [];
      for (let index = 0; index < 9; index++) {
        const firingId = yield* fire(fixture, routine);
        if (index === 5) {
          yield* refuse(fixture, firingId);
          expected.unshift([firingId, "failed", undefined, false, true]);
          continue;
        }
        const inputId = yield* accept(fixture, firingId);
        yield* answer(fixture, firingId, inputId, index % 2 === 0);
        expected.unshift([firingId, "completed", inputId, index % 2 === 0, false]);
      }
      const listed = yield* fixture.service.list();
      assert.deepStrictEqual(
        historyOf(listed, routine.id)?.map((run) => [
          run.firingId,
          run.status,
          run.conversation?.inputId,
          run.quiet === true,
          run.dispatchFailed === true,
        ]),
        expected.slice(0, SCHEDULED_TASK_RECENT_RUNS),
      );
      assert.isTrue(
        historyOf(listed, routine.id)?.every(
          (run) => run.conversation === undefined || run.conversation.threadId === botThread,
        ),
      );
      assert.notProperty(
        listed.tasks.find((task) => task.id === ordinary.id),
        "recentRuns",
      );
    }),
  ),
);

it.effect(
  "at the eighth firing's admission a routine keeps its seven most recent firings: six finished and the one in flight",
  () =>
    withWebhookService((fixture) =>
      Effect.gen(function* () {
        const routine = yield* saveRoutine(fixture);
        const finished: Array<CommandId> = [];
        for (let index = 0; index < SCHEDULED_TASK_RECENT_RUNS; index++) {
          const firingId = yield* fire(fixture, routine);
          yield* refuse(fixture, firingId);
          finished.unshift(firingId);
        }
        const inFlight = yield* fire(fixture, routine);
        assert.deepStrictEqual(
          historyOf(yield* fixture.service.list(), routine.id)?.map((run) => [
            run.firingId,
            run.status,
          ]),
          [
            [inFlight, "dispatching"],
            ...finished.slice(0, SCHEDULED_TASK_RECENT_RUNS - 1).map((id) => [id, "failed"]),
          ],
        );
        const oldest = finished.at(-1) ?? "";
        assert.lengthOf(
          yield* fixture.sql`SELECT 1 FROM scheduled_task_runs WHERE firing_id = ${oldest}`,
          0,
        );
      }),
    ),
);

it.effect("a run that cannot be read is left out, and the rest of the list stays", () =>
  withWebhookService((fixture) =>
    Effect.gen(function* () {
      const routine = yield* saveRoutine(fixture);
      const firings: Array<CommandId> = [];
      for (let index = 0; index < 3; index++) {
        const firingId = yield* fire(fixture, routine);
        yield* refuse(fixture, firingId);
        firings.unshift(firingId);
      }
      yield* fixture.sql`UPDATE scheduled_task_runs SET snapshot_json = '{' WHERE firing_id = ${firings[1]}`;
      assert.deepStrictEqual(
        historyOf(yield* fixture.service.list(), routine.id)?.map((run) => run.firingId),
        [firings[0], firings[2]],
      );
    }),
  ),
);

it.effect("a decision that is not JSON leaves its run not quiet and every history in place", () =>
  withWebhookService((fixture) =>
    Effect.gen(function* () {
      const broken = yield* saveRoutine(fixture, "goat-bot-check-in:broken");
      const other = yield* saveRoutine(fixture, "goat-bot-check-in:other");
      const brokenFiring = yield* fire(fixture, broken);
      yield* answer(fixture, brokenFiring, yield* accept(fixture, brokenFiring), "malformed");
      const otherFiring = yield* fire(fixture, other);
      yield* answer(fixture, otherFiring, yield* accept(fixture, otherFiring), true);
      const listed = yield* fixture.service.list();
      assert.deepStrictEqual(
        [broken.id, other.id].map((id) =>
          historyOf(listed, id)?.map((run) => [run.firingId, run.status, run.quiet === true]),
        ),
        [[[brokenFiring, "completed", false]], [[otherFiring, "completed", true]]],
      );
    }),
  ),
);

it.effect(
  "a run whose stored input id is blank loads without a conversation, and failing after the bot took it only failed",
  () =>
    withWebhookService((fixture) =>
      Effect.gen(function* () {
        const routine = yield* saveRoutine(fixture);
        const firingId = yield* fire(fixture, routine);
        yield* fixture.sql`UPDATE scheduled_task_channel_inputs SET input_id = ' ' WHERE firing_id = ${firingId}`;
        yield* fixture.runs.finishChannelFiring({
          firingId,
          outcome: { type: "accepted", threadId: botThread },
          at: yield* now,
        });
        yield* refuse(fixture, firingId);
        assert.deepStrictEqual(
          historyOf(yield* fixture.service.list(), routine.id)?.map((run) => [
            run.firingId,
            run.status,
            run.conversation,
            run.dispatchFailed,
          ]),
          [[firingId, "failed", undefined, undefined]],
        );
      }),
    ),
);

it.effect("a run stored with a status this server does not know stays in the history", () =>
  withWebhookService((fixture) =>
    Effect.gen(function* () {
      const routine = yield* saveRoutine(fixture);
      const older = yield* fire(fixture, routine);
      yield* refuse(fixture, older);
      const newer = yield* fire(fixture, routine);
      yield* refuse(fixture, newer);
      // As a later server could have written it before this one was started again.
      yield* fixture.sql`UPDATE scheduled_task_runs SET snapshot_json = json_set(snapshot_json, '$.status', 'paused_by_policy')
        WHERE firing_id = ${older}`;
      assert.deepStrictEqual(
        historyOf(yield* fixture.service.list(), routine.id)?.map((run) => [
          run.firingId,
          run.status,
        ]),
        [
          [newer, "failed"],
          [older, "paused_by_policy"],
        ],
      );
    }),
  ),
);

it.effect(
  "a run kept from before history began stays, without a conversation, beside new runs",
  () =>
    withWebhookService((fixture) =>
      Effect.gen(function* () {
        const routine = yield* saveRoutine(fixture);
        // Before this change: one kept firing, whose link to the bot input was pruned after 7 days.
        const old = yield* fire(fixture, routine);
        yield* accept(fixture, old);
        yield* refuse(fixture, old);
        yield* fixture.sql`DELETE FROM scheduled_task_channel_inputs WHERE firing_id = ${old}`;
        const fresh = yield* fire(fixture, routine);
        const inputId = yield* accept(fixture, fresh);
        yield* answer(fixture, fresh, inputId, false);
        assert.deepStrictEqual(
          historyOf(yield* fixture.service.list(), routine.id)?.map((run) => [
            run.firingId,
            run.status,
            run.conversation?.inputId,
            run.dispatchFailed,
          ]),
          [
            [fresh, "completed", inputId, undefined],
            [old, "failed", undefined, undefined],
          ],
        );
      }),
    ),
);

it.effect("two routines firing in the same second each keep their own run", () =>
  withWebhookService((fixture) =>
    Effect.gen(function* () {
      const first = yield* saveRoutine(fixture, "goat-bot-check-in:first");
      const second = yield* saveRoutine(fixture, "goat-bot-check-in:second");
      yield* TestClock.adjust(Duration.seconds(1));
      yield* fixture.service.runNow({ id: first.id });
      yield* fixture.service.runNow({ id: second.id });
      const listed = yield* fixture.service.list();
      const firings = [first, second].map((routine) =>
        historyOf(listed, routine.id)?.map((run) => [
          run.firingId.includes(routine.id),
          run.status,
        ]),
      );
      assert.deepStrictEqual(firings, [[[true, "dispatching"]], [[true, "dispatching"]]]);
    }),
  ),
);

it.effect("only the first fifty GOAT Bot routines carry a history", () =>
  withWebhookService((fixture) =>
    Effect.gen(function* () {
      for (let index = 0; index <= SCHEDULED_TASK_RECENT_RUN_ROUTINES; index++)
        yield* saveRoutine(fixture, `goat-bot-check-in:${String(index).padStart(2, "0")}`);
      const { tasks } = yield* fixture.service.list();
      assert.lengthOf(tasks, SCHEDULED_TASK_RECENT_RUN_ROUTINES + 1);
      assert.deepStrictEqual(
        tasks.map((task) => task.recentRuns),
        [...Array.from({ length: SCHEDULED_TASK_RECENT_RUN_ROUTINES }, () => []), undefined],
      );
      assert.notProperty(tasks.at(-1), "recentRuns");
    }),
  ),
);

it.effect("history stops at its byte budget: later routines carry none, however small", () =>
  withWebhookService((fixture) =>
    Effect.gen(function* () {
      // Task ids have no maximum length, and every firing id repeats the task id. The helper's
      // input ids repeat it too, which real ones (a digest) do not, so this reaches the budget sooner.
      const long = (letter: string) => `goat-bot-check-in:${letter}-${"x".repeat(9_000)}`;
      const routines = [
        yield* saveRoutine(fixture, long("a")),
        yield* saveRoutine(fixture, long("b")),
        yield* saveRoutine(fixture, long("c")),
        yield* saveRoutine(fixture, "goat-bot-check-in:d"),
      ];
      for (const routine of routines.slice(0, 3))
        for (let index = 0; index < 3; index++) {
          const firingId = yield* fire(fixture, routine);
          yield* answer(fixture, firingId, yield* accept(fixture, firingId), false);
        }
      const listed = yield* fixture.service.list();
      assert.deepStrictEqual(
        routines.map((routine) => historyOf(listed, routine.id)?.length),
        [3, 3, undefined, undefined],
      );
      const bytes = (tasks: ReadonlyArray<ScheduledTask>) =>
        new TextEncoder().encode(encodeList({ tasks })).length;
      const added =
        bytes(listed.tasks) - bytes(listed.tasks.map(({ recentRuns: _recent, ...task }) => task));
      assert.isAtMost(added, SCHEDULED_TASK_RECENT_RUN_BYTES);
      assert.isAbove(added, SCHEDULED_TASK_RECENT_RUN_BYTES / 2);
    }),
  ),
);

/** Every list the subscription pushes, in order. */
const watchList = (fixture: Fixture) =>
  Effect.gen(function* () {
    const lists = yield* Queue.unbounded<{ readonly tasks: ReadonlyArray<ScheduledTask> }>();
    yield* fixture.service.subscribeList().pipe(
      Stream.runForEach((result) => Queue.offer(lists, result)),
      Effect.forkScoped,
    );
    return lists;
  });

it.effect("each step of a firing pushes one list that shows it", () =>
  withWebhookService((fixture) =>
    Effect.gen(function* () {
      const routine = yield* saveRoutine(fixture);
      const lists = yield* watchList(fixture);
      assert.deepStrictEqual(historyOf(yield* Queue.take(lists), routine.id), []);
      const newest = Effect.map(Queue.take(lists), (result) => {
        const run = historyOf(result, routine.id)?.[0];
        return [run?.firingId, run?.status, run?.conversation?.inputId];
      });

      const firingId = yield* fire(fixture, routine);
      assert.deepStrictEqual(yield* newest, [firingId, "dispatching", undefined]);
      const inputId = yield* accept(fixture, firingId);
      assert.deepStrictEqual(yield* newest, [firingId, "running", inputId]);
      yield* answer(fixture, firingId, inputId, false);
      assert.deepStrictEqual(yield* newest, [firingId, "completed", inputId]);
    }).pipe(Effect.scoped),
  ),
);

it.effect("a refused firing pushes one list after each step", () =>
  withWebhookService((fixture) =>
    Effect.gen(function* () {
      const routine = yield* saveRoutine(fixture);
      const lists = yield* watchList(fixture);
      yield* Queue.take(lists);
      const newest = Effect.map(Queue.take(lists), (result) => {
        const run = historyOf(result, routine.id)?.[0];
        return [run?.firingId, run?.status, run?.conversation];
      });

      const firingId = yield* fire(fixture, routine);
      assert.deepStrictEqual(yield* newest, [firingId, "dispatching", undefined]);
      yield* refuse(fixture, firingId);
      assert.deepStrictEqual(yield* newest, [firingId, "failed", undefined]);
    }).pipe(Effect.scoped),
  ),
);

it.effect("fifty routines with seven runs each and typical ids fit the history budget", () =>
  withWebhookService((fixture) =>
    Effect.gen(function* () {
      // Long but typical ids: a UUID bot thread inside every task id and firing id.
      const thread = ThreadId.make("4f9c2a7e-1b3d-4c8e-9a6f-2d5b7e0c1a93");
      const template = yield* saveRoutine(fixture);
      const tasks = Array.from({ length: SCHEDULED_TASK_RECENT_RUN_ROUTINES }, (_, routine) => {
        const id = ScheduledTaskId.make(`goat-bot-check-in:${thread}:${routine}`);
        const recentRuns = Array.from({ length: SCHEDULED_TASK_RECENT_RUNS }, (_, run) => ({
          firingId: CommandId.make(`scheduled-task:${id}:${1_794_000_000_000 + run}:scheduled`),
          status: "completed",
          requestedAt: "2026-11-14T09:00:00.000Z",
          completedAt: "2026-11-14T09:00:42.000Z",
          conversation: {
            threadId: thread,
            inputId: ChannelInputId.make(`channel-input:${"0".repeat(32)}${run}`),
          },
          quiet: true as const,
        }));
        return { ...template, id, threadId: thread, recentRuns };
      });
      const bytes = (result: ScheduledTaskListResult) =>
        new TextEncoder().encode(encodeList(result)).length;
      const before = bytes({
        tasks: tasks.map(({ recentRuns: _recent, ...task }) => task),
        timeZone: "Asia/Seoul",
      });
      const after = bytes({ tasks, timeZone: "Asia/Seoul" });
      assert.isAtMost(after - before, SCHEDULED_TASK_RECENT_RUN_BYTES);
    }),
  ),
);
