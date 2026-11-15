import { assert, it } from "@effect/vitest";
import {
  ChannelInputId,
  CommandId,
  MessageId,
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
import { MAX_ROUTINE_ID_BYTES, MAX_STORED_RUN_BYTES } from "./scheduledTaskRecentRuns.ts";

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

it.effect(
  "a routine with more than seven firings in flight keeps them all and lists the seven most recent",
  () =>
    withWebhookService((fixture) =>
      Effect.gen(function* () {
        const routine = yield* saveRoutine(fixture);
        const running: Array<CommandId> = [];
        // An accepted firing runs until the bot answers; the next can be admitted meanwhile.
        for (let index = 0; index < SCHEDULED_TASK_RECENT_RUNS + 2; index++) {
          const firingId = yield* fire(fixture, routine);
          yield* accept(fixture, firingId);
          running.unshift(firingId);
        }
        assert.lengthOf(
          yield* fixture.sql`SELECT 1 FROM scheduled_task_runs WHERE task_id = ${routine.id}`,
          SCHEDULED_TASK_RECENT_RUNS + 2,
        );
        assert.deepStrictEqual(
          historyOf(yield* fixture.service.list(), routine.id)?.map((run) => [
            run.firingId,
            run.status,
          ]),
          running.slice(0, SCHEDULED_TASK_RECENT_RUNS).map((id) => [id, "running"]),
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

it.effect(
  "an older firing stored with a status this server does not know stays in the history",
  () =>
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

it.effect(
  "two firings of one routine at the same instant are listed by firing id, not admission order",
  () =>
    withWebhookService((fixture) =>
      Effect.gen(function* () {
        const routine = yield* saveRoutine(fixture);
        const at = yield* now;
        const admit = (key: string) =>
          Effect.gen(function* () {
            const current = (yield* fixture.service.list()).tasks.find(
              (task) => task.id === routine.id,
            );
            const firingId = CommandId.make(`scheduled-task:${routine.id}:${key}`);
            yield* fixture.runs.begin({
              task: current ?? routine,
              firingId,
              messageId: MessageId.make(`scheduled-task-routine:${routine.id}:${key}`),
              requestedAt: at,
              triggerKind: "manual",
              webhookDeliveryId: null,
            });
            yield* refuse(fixture, firingId);
            return firingId;
          });
        const admittedFirst = yield* admit("b");
        const admittedSecond = yield* admit("a");
        assert.deepStrictEqual(
          historyOf(yield* fixture.service.list(), routine.id)?.map((run) => run.firingId),
          [admittedFirst, admittedSecond],
        );
      }),
    ),
);

it.effect(
  "a stored input id that is not plain printable ASCII leaves its run without a conversation",
  () =>
    withWebhookService((fixture) =>
      Effect.gen(function* () {
        const routine = yield* saveRoutine(fixture);
        const firingId = yield* fire(fixture, routine);
        yield* accept(fixture, firingId);
        // Under the byte cap, but each control character would encode as six bytes of JSON.
        const controlInputId = "channel-input:" + "\u0001".repeat(100);
        yield* fixture.sql`UPDATE scheduled_task_channel_inputs SET input_id = ${controlInputId} WHERE firing_id = ${firingId}`;
        assert.deepStrictEqual(
          historyOf(yield* fixture.service.list(), routine.id)?.map((run) => [
            run.firingId,
            run.status,
            run.conversation,
          ]),
          [[firingId, "running", undefined]],
        );
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

it.effect(
  "history stops at its byte budget: the routine that would pass it and every later one carry none",
  () =>
    withWebhookService((fixture) =>
      Effect.gen(function* () {
        // Ids of 250 bytes stay under the 256-byte id cap, and each accepted run stores 809 bytes
        // (snapshot plus input id), under the 1,024-byte run cap, so only the budget omits a routine.
        // Each history encodes to 5,041 bytes, so 25 fit after the empty one; all are one size.
        const full = (index: number) =>
          `goat-bot-check-in:${String(index).padStart(2, "0")}-${"x".repeat(250 - 21)}`;
        const noRunsFirst = yield* saveRoutine(fixture, "goat-bot-check-in:00");
        const fullRoutines: Array<ScheduledTask> = [];
        for (let index = 1; index <= 28; index++)
          fullRoutines.push(yield* saveRoutine(fixture, full(index)));
        const noRunsLast = yield* saveRoutine(fixture, "goat-bot-check-in:zz");
        // Firing ids hold the clock in milliseconds; keep every one six digits long, and stay well
        // inside the routines' hourly schedule so only these firings exist.
        yield* TestClock.adjust(Duration.seconds(100));
        for (const routine of fullRoutines)
          for (let index = 0; index < SCHEDULED_TASK_RECENT_RUNS; index++)
            yield* accept(fixture, yield* fire(fixture, routine));

        const listed = yield* fixture.service.list();
        const task = (routine: ScheduledTask) =>
          listed.tasks.find((each) => each.id === routine.id);
        // A routine with no runs carries an empty history; an omitted one carries no key at all.
        assert.deepStrictEqual(task(noRunsFirst)?.recentRuns, []);
        assert.notProperty(task(noRunsLast), "recentRuns");

        // The routines that carry history are a prefix of the list; the rest carry no key.
        const lengths = fullRoutines.map((routine) => task(routine)?.recentRuns?.length);
        const carried = lengths.indexOf(undefined);
        assert.isAbove(carried, 1);
        assert.deepStrictEqual(lengths, [
          ...Array.from({ length: carried }, () => SCHEDULED_TASK_RECENT_RUNS),
          ...Array.from({ length: fullRoutines.length - carried }, () => undefined),
        ]);

        const bytes = (tasks: ReadonlyArray<ScheduledTask>) =>
          new TextEncoder().encode(encodeList({ tasks })).length;
        const withoutHistory = listed.tasks.map(({ recentRuns: _recent, ...rest }) => rest);
        const added = bytes(listed.tasks) - bytes(withoutHistory);
        const oneHistory =
          bytes(
            withoutHistory.map((rest, index) =>
              rest.id === fullRoutines[0]?.id ? (listed.tasks[index] ?? rest) : rest,
            ),
          ) - bytes(withoutHistory);
        assert.isAtMost(added, SCHEDULED_TASK_RECENT_RUN_BYTES);
        // The first omitted routine's history is the same size, so adding it would pass the budget.
        assert.isAbove(added + oneHistory, SCHEDULED_TASK_RECENT_RUN_BYTES);
      }),
    ),
);

it.effect(
  "a routine whose task id is over the id cap is never read, and the routines after it keep their history",
  () =>
    withWebhookService((fixture) =>
      Effect.gen(function* () {
        // 150 two-byte characters: 300 bytes, under the cap if counted as characters (168).
        const longId = `goat-bot-check-in:a-${"é".repeat(150)}`;
        const overCap = yield* saveRoutine(fixture, longId);
        const after = yield* saveRoutine(fixture, "goat-bot-check-in:b");
        // Its stored runs stay under the stored-run cap, so had its id reached the query, it would
        // carry this history: the missing key shows the id was left out where routines are chosen.
        yield* refuse(fixture, yield* fire(fixture, overCap));
        const kept = yield* fire(fixture, after);
        yield* refuse(fixture, kept);
        const listed = yield* fixture.service.list();
        assert.isAbove(Buffer.byteLength(longId), MAX_ROUTINE_ID_BYTES);
        assert.notProperty(
          listed.tasks.find((task) => task.id === overCap.id),
          "recentRuns",
        );
        assert.deepStrictEqual(
          historyOf(listed, after.id)?.map((run) => run.firingId),
          [kept],
        );
      }),
    ),
);

it.effect(
  "a stored run over the byte cap leaves only its own routine without history, NULs included",
  () =>
    withWebhookService((fixture) =>
      Effect.gen(function* () {
        const oversized = yield* saveRoutine(fixture, "goat-bot-check-in:a");
        const other = yield* saveRoutine(fixture, "goat-bot-check-in:b");
        const nulInput = yield* saveRoutine(fixture, "goat-bot-check-in:c");
        const older = yield* fire(fixture, oversized);
        yield* refuse(fixture, older);
        const newer = yield* fire(fixture, oversized);
        yield* refuse(fixture, newer);
        const kept = yield* fire(fixture, other);
        yield* refuse(fixture, kept);
        const withNul = yield* fire(fixture, nulInput);
        yield* refuse(fixture, withNul);
        // A stored row larger than any run this server writes: the read leaves it in the database.
        const padding = "x".repeat(MAX_STORED_RUN_BYTES);
        yield* fixture.sql`UPDATE scheduled_task_runs SET snapshot_json = json_set(snapshot_json, '$.padding', ${padding})
        WHERE firing_id = ${older}`;
        // A short prefix, a NUL, then the bulk: SQLite's length() on text stops at the NUL.
        const nulInputId = "x\u0000" + "y".repeat(MAX_STORED_RUN_BYTES);
        yield* fixture.sql`UPDATE scheduled_task_channel_inputs SET input_id = ${nulInputId} WHERE firing_id = ${withNul}`;
        const listed = yield* fixture.service.list();
        for (const routine of [oversized, nulInput])
          assert.notProperty(
            listed.tasks.find((task) => task.id === routine.id),
            "recentRuns",
          );
        assert.deepStrictEqual(
          historyOf(listed, other.id)?.map((run) => run.firingId),
          [kept],
        );
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
