import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  ChannelChildWorkId,
  ChannelQuestionId,
  ChannelTaskId,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as BotThreads from "./ChannelBotThreads.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { nextTaskChange, watchTaskChanges } from "./testkit/taskChanges.ts";
import { commitTransition, prepareTransition } from "./channelTaskWrites.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as TaskViews from "./channelTaskViews.ts";
import * as ChildStore from "./channelChildWorkStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import {
  botThreadId,
  environmentId,
  goatInput,
  makeHarness,
  owner,
  ownerId,
  rpcContext,
  scratchProjectId,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const time = "2026-10-12T00:00:00.000Z";
const old = "2026-10-01T00:00:00.000Z";
const insertTask = (id: string, taskOwner: string, status: string, updatedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const data = JSON.stringify({
      taskId: id,
      conversationId: "conv:bot",
      originBindingId: "binding:1",
      originInputId: "input:1",
      originAddress: { kind: "goat", environmentId, threadId: botThreadId },
      requester: {
        ownerId: taskOwner,
        principalId: "owner",
        displayName: "Owner",
        originKind: "goat",
        runtimeModeCeiling: "full-access",
        grantedScopes: [],
      },
      title: id,
      instruction: "",
      status,
      version: 1,
      generation: 1,
      openQuestions: [],
      createdAt: updatedAt,
      updatedAt,
      ...(status === "completed" ? { completedAt: updatedAt } : {}),
    });
    yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version, generation, task_json, created_at, updated_at) VALUES (${id}, ${taskOwner}, 'conv:bot', ${status}, 1, 1, ${data}, ${updatedAt}, ${updatedAt})`;
  });

describe("ChannelBotThreads", () => {
  it.effect("snooze preserves the task version a worker's in-flight question will commit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(1791763200000);
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const service = yield* BotThreads.ChannelBotThreads;
      yield* gateway.ingest(goatInput("do: prepare the release", "question-race"), rpcContext);
      yield* runtime.drain;
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      assert.isDefined(task);
      if (task === undefined) return yield* Effect.die("Work was not created");
      const stored = (yield* ledger.getTask(task.taskId))!;
      const questionId = ChannelQuestionId.make("release-question");
      const prepared = prepareTransition(
        stored,
        {
          type: "task.question.opened",
          payload: {
            question: { questionId, text: "Which release?", askedAt: time },
          },
        },
        time,
        undefined,
      );
      if (!prepared.ok) return yield* Effect.die(prepared.reason);
      yield* service.snooze(
        { taskId: task.taskId, botId: BotId.make("main"), until: "2026-10-12T01:00:00.000Z" },
        owner,
      );
      yield* ledger.applyTaskEvent({ write: prepared.write, deliveries: [] });
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      assert.include((yield* members.openAsks(owner)).asks[0], { questionId });
      assert.lengthOf((yield* service.list(owner)).snoozed ?? [], 0);
    }).pipe(
      Effect.provide(
        BotThreads.layer.pipe(
          Layer.provideMerge(TaskViews.layer),
          Layer.provideMerge(harness.layer),
        ),
      ),
    );
  });

  it.effect("reads the bot's completion criterion and newest task activity with subjects", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(1791763200000);
      yield* setupBot;
      const doneMeans = "The build passes and the fix has a pull request.";
      harness.script.current = () =>
        Effect.succeed({
          replyText: "On it.",
          action: {
            type: "create_task",
            title: "Repair build",
            instruction: "Fix the build.",
            doneMeans,
          },
        });
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const service = yield* BotThreads.ChannelBotThreads;
      yield* gateway.ingest(goatInput("do: repair build", "done-means"), rpcContext);
      yield* runtime.drain;
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      assert.isDefined(task?.worker);
      if (!task?.worker) return yield* Effect.die("Work did not start");
      const read = () =>
        service.getBotTask({ taskId: task.taskId, botId: BotId.make("main") }, owner);
      const remoteThreadId = ThreadId.make("ssh-build-check");
      const children = yield* ChildStore.ChannelChildWorkStore;
      yield* children.admitReserved(
        {
          ownerId,
          taskId: task.taskId,
          childWorkId: ChannelChildWorkId.make("ssh-build"),
          generation: task.generation,
          callerThreadId: botThreadId,
          surface: "ssh_thread_launch",
          requestKey: "ssh-build",
          promptDigest: "release",
          state: "bound",
          createdAt: old,
          updatedAt: time,
          destination: {
            correlationId: "ssh-build-dispatch",
            host: "builder",
            environmentId,
            threadId: remoteThreadId,
          },
        },
        10,
      );
      const sql = yield* SqlClient.SqlClient;
      const pr = {
        repository: "example/remote-build",
        number: 3,
        watching: false,
        url: "https://github.com/example/remote-build/pull/3",
      };
      yield* sql`INSERT INTO remote_dispatches (
        correlation_id, kind, origin_thread_id, host, remote_thread_id, read_key, delivery, state,
        reports_supported, observation, created_at, updated_at
      ) VALUES (
        'ssh-build-dispatch', 'thread', ${botThreadId}, 'builder', ${remoteThreadId}, 'fixture', 'wake', 'running',
        1, ${JSON.stringify({ pullRequests: [pr], needsYou: [] })}, ${time}, ${time}
      )`;
      const questionId = ChannelQuestionId.make("which-build");
      const stored = (yield* ledger.getTask(task.taskId))!;
      yield* TestClock.adjust("1 minute");
      yield* commitTransition(ledger, stored, {
        type: "task.worker.observed",
        payload: {
          generation: task.generation,
          observed: {
            pullRequests: [
              {
                repository: "example/build",
                number: 12,
                watching: false,
                url: "https://github.com/example/build/pull/12",
              },
            ],
            needsYou: [],
          },
        },
      });
      yield* TestClock.adjust("1 minute");
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.question.opened",
          payload: {
            question: { questionId, text: "Which build?", askedAt: "2026-10-12T00:02:00.000Z" },
          },
        },
        { actor: "agent" },
      );
      const result = yield* read();
      assert.strictEqual(
        result.task.state === "known" && result.task.row.task.doneMeans,
        doneMeans,
      );
      const entries = result.activity?.entries ?? [];
      assert.deepInclude(
        entries.map(({ type }) => type),
        "created",
      );
      assert.include(
        entries.find((entry) => entry.type === "worker_started"),
        {
          environmentId: task.worker.environmentId,
          threadId: task.worker.threadId,
        },
      );
      assert.include(
        entries.find((entry) => entry.type === "pr_linked"),
        { repo: "example/build", number: 12 },
      );
      assert.isTrue(
        entries.some(
          (entry) =>
            entry.type === "pr_linked" &&
            entry.repo === "example/remote-build" &&
            entry.number === 3,
        ),
      );
      assert.include(entries[0], { type: "asked", requestId: questionId, actor: "bot" });
      // An early launch can still provide the newest finish after many later starts.
      for (let index = 0; index <= 50; index++) {
        const finished = index === 0;
        yield* children.admitReserved(
          {
            ownerId,
            taskId: task.taskId,
            childWorkId: ChannelChildWorkId.make("launch:" + index),
            generation: task.generation,
            callerThreadId: botThreadId,
            surface: "thread_launch",
            requestKey: "launch:" + index,
            promptDigest: "release",
            state: finished ? "completed" : "bound",
            createdAt: finished ? old : time,
            updatedAt: finished ? "2026-10-12T00:03:00.000Z" : time,
            destination: { threadId: ThreadId.make("launch-thread:" + index) },
          },
          100,
        );
      }
      assert.include((yield* read()).activity?.entries[0], {
        type: "worker_finished",
        threadId: ThreadId.make("launch-thread:0"),
      });
      yield* sql`UPDATE remote_dispatches SET updated_at = '2026-10-12T00:03:30.000Z'
        WHERE correlation_id = 'ssh-build-dispatch'`;
      assert.include((yield* read()).activity?.entries[0], {
        type: "pr_linked",
        repo: "example/remote-build",
        number: 3,
      });
      yield* TestClock.adjust("2 minutes");
      for (let index = 0; index < 26; index++) {
        yield* TestClock.adjust("1 second");
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.question.answered",
            payload: { questionId, answer: "Staging." },
          },
          { actor: "user" },
        );
        yield* TestClock.adjust("1 second");
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.question.opened",
            payload: {
              question: { questionId, text: "Which build?", askedAt: "2026-10-12T00:02:00.000Z" },
            },
          },
          { actor: "agent" },
        );
      }
      const latest = (yield* read()).activity?.entries ?? [];
      assert.lengthOf(latest, 50);
      assert.include(latest[0], { type: "asked", requestId: questionId });
      assert.deepStrictEqual(
        latest.map((entry) => entry.at),
        latest
          .map((entry) => entry.at)
          .toSorted()
          .reverse(),
      );
    }).pipe(
      Effect.provide(
        BotThreads.layer.pipe(
          Layer.provideMerge(TaskViews.layer),
          Layer.provideMerge(harness.layer),
        ),
      ),
    );
  });

  it.effect(
    "moves snoozed work out of the current rows until expiry and never mutes an open ask",
    () => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        yield* TestClock.setTime(1791763200000);
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const service = yield* BotThreads.ChannelBotThreads;
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* gateway.ingest(goatInput("do: choose a project", "snoozed-ask"), rpcContext);
        yield* runtime.drain;
        const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
        assert.strictEqual(task?.status, "waiting_input");
        if (task === undefined) return yield* Effect.die("Work was not created");
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const before = yield* members.openAsks(owner);
        assert.strictEqual(before.total, 1);
        const target = { taskId: task.taskId, botId: BotId.make("main") };
        const denied = yield* Effect.flip(
          service.snooze(
            { ...target, until: "2026-10-12T01:00:00.000Z" },
            { ...owner, ownerId: "another-owner" },
          ),
        );
        assert.strictEqual(denied.reason, "task_not_found");
        const wrongBot = yield* Effect.flip(
          service.snooze(
            { ...target, botId: BotId.make("other"), until: "2026-10-12T01:00:00.000Z" },
            owner,
          ),
        );
        assert.strictEqual(wrongBot.reason, "task_not_found");
        const seen = yield* watchTaskChanges(owner);
        yield* service.snooze({ ...target, until: "2026-10-12T01:00:00.000Z" }, owner);
        assert.strictEqual(yield* nextTaskChange(seen), 1);
        const home = yield* service.list(owner);
        assert.deepStrictEqual(home.rows, []);
        assert.include(home.snoozed?.[0]?.view, {
          taskId: task.taskId,
          snoozedUntil: "2026-10-12T01:00:00.000Z",
        });
        assert.isFalse(home.snoozed?.[0]?.unread ?? true);
        assert.deepStrictEqual(yield* members.openAsks(owner), before);
        yield* service.unsnooze(target, owner);
        assert.lengthOf((yield* service.list(owner)).rows, 1);
        const activity = (yield* service.getBotTask(target, owner)).activity?.entries ?? [];
        assert.deepStrictEqual(
          activity
            .filter((entry) => entry.type === "snoozed" || entry.type === "unsnoozed")
            .map(({ type, actor }) => [type, actor]),
          [
            ["unsnoozed", "person"],
            ["snoozed", "person"],
          ],
        );
        yield* service.snooze({ ...target, until: "2026-10-12T01:00:00.000Z" }, owner);
        yield* TestClock.adjust("1 hour");
        assert.lengthOf((yield* service.list(owner)).rows, 1);
        yield* service.snooze({ ...target, until: "2026-10-12T02:00:00.000Z" }, owner);
        yield* commitTransition(ledger, (yield* ledger.getTask(task.taskId))!, {
          type: "task.failed",
          payload: { generation: task.generation, reason: "Stopped before selecting a project." },
        });
        const after = yield* service.list(owner);
        assert.lengthOf(after.rows, 1);
        assert.lengthOf(after.snoozed ?? [], 0);
      }).pipe(
        Effect.provide(
          BotThreads.layer.pipe(
            Layer.provideMerge(TaskViews.layer),
            Layer.provideMerge(harness.layer),
          ),
        ),
      );
    },
  );

  it.effect(
    "keeps an old pinned task within the cap and restores the newest tasks on unpin",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* TestClock.setTime(1791763200000);
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at) VALUES ('conv:bot', ${ownerId}, 'goat', 'goat', ${botThreadId}, ${time})`;
        for (let index = 0; index < 101; index++) {
          const updated = `2026-10-12T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
          yield* insertTask(`task:${String(index).padStart(3, "0")}`, ownerId, "running", updated);
        }
        yield* insertTask("task:pinned", ownerId, "completed", old);
        const views = yield* TaskViews.ChannelTaskViews;
        yield* views.update({ taskId: ChannelTaskId.make("task:pinned"), pinned: true }, owner);
        const service = yield* BotThreads.ChannelBotThreads;
        const ids = (result: Awaited<Effect.Success<ReturnType<typeof service.list>>>) =>
          result.rows.flatMap((row) => (row.kind === "task" ? [row.task.taskId] : []));
        const pinned = ids(yield* service.list(owner));
        assert.lengthOf(pinned, 100);
        assert.deepStrictEqual(pinned, [
          ...Array.from(
            { length: 99 },
            (_, index) => `task:${String(100 - index).padStart(3, "0")}`,
          ),
          "task:pinned",
        ]);
        yield* views.update({ taskId: ChannelTaskId.make("task:pinned"), pinned: false }, owner);
        assert.deepStrictEqual(
          ids(yield* service.list(owner)),
          Array.from({ length: 100 }, (_, index) => `task:${String(100 - index).padStart(3, "0")}`),
        );
        for (let index = 0; index < 101; index++) {
          yield* views.update(
            { taskId: ChannelTaskId.make(`task:${String(index).padStart(3, "0")}`), pinned: true },
            owner,
          );
        }
        assert.deepStrictEqual(
          ids(yield* service.list(owner)),
          Array.from({ length: 100 }, (_, index) => `task:${String(100 - index).padStart(3, "0")}`),
        );
      }).pipe(
        Effect.provide(
          BotThreads.layer.pipe(
            Layer.provideMerge(TaskViews.layer),
            Layer.provideMerge(harness.layer),
          ),
        ),
      );
    },
  );
  it.effect(
    "scopes tasks, retains pinned old work, and deduplicates resolvable coding rows",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* TestClock.setTime(1791763200000);
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at) VALUES ('conv:bot', ${ownerId}, 'goat', 'goat', ${botThreadId}, ${time})`;
        yield* insertTask("task:active", ownerId, "running", time);
        yield* insertTask("task:turn", ownerId, "running", time);
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.kind', 'turn') WHERE task_id = 'task:turn'`;
        yield* insertTask("task:old", ownerId, "completed", old);
        yield* insertTask("task:pinned", ownerId, "completed", old);
        yield* insertTask("task:foreign", "foreign", "running", time);
        for (let index = 0; index < 101; index++) {
          yield* insertTask(
            `task:stale-${index}`,
            ownerId,
            "completed",
            "2026-10-02T00:00:00.000Z",
          );
        }
        const views = yield* TaskViews.ChannelTaskViews;
        yield* views.update({ taskId: ChannelTaskId.make("task:pinned"), pinned: true }, owner);
        yield* sql`INSERT INTO channel_bindings (binding_id, conversation_id, connection_id, reply_address_json, last_activity_at) VALUES ('binding:1', 'conv:bot', 'goat', '{}', ${time})`;
        for (const [id, message] of [
          ["main", { intent: "message", actor: {} }],
          ["task", { intent: "message", taskId: "task:active", actor: {} }],
          ["agent", { intent: "message", actor: { senderThreadId: "thread:worker" } }],
          ["report", { intent: "report", actor: {} }],
        ] as const) {
          const encoded = JSON.stringify(message);
          yield* sql`INSERT INTO channel_inbox (input_id, owner_id, kind, connection_id, idempotency_key, content_hash, conversation_id, binding_id, message_json, state, accepted_at) VALUES (${id}, ${ownerId}, 'goat', 'goat', ${id}, 'hash', 'conv:bot', 'binding:1', ${encoded}, 'accepted', '2026-10-12T01:00:00.000Z')`;
        }
        const children = yield* ChildStore.ChannelChildWorkStore;
        const base = {
          ownerId,
          taskId: ChannelTaskId.make("task:active"),
          generation: 1,
          callerThreadId: botThreadId,
          requestKey: "key",
          promptDigest: "digest",
          state: "bound" as const,
          createdAt: time,
          updatedAt: time,
        };
        for (const [id, surface, destination] of [
          ["one", "thread_launch", { threadId: ThreadId.make("thread:child") }],
          ["two", "thread_launch", { threadId: ThreadId.make("thread:child") }],
          [
            "remote",
            "ssh_thread_launch",
            { threadId: ThreadId.make("thread:remote"), host: "remote" },
          ],
          ["missing", "thread_launch", {}],
        ] as const) {
          yield* children.admitReserved(
            { ...base, childWorkId: ChannelChildWorkId.make(id), surface, destination },
            100,
          );
        }
        const service = yield* BotThreads.ChannelBotThreads;
        const result = yield* service.list(owner);
        assert.deepStrictEqual(
          result.rows
            .filter((row) => row.kind === "task")
            .map((row) => row.task.taskId)
            .sort(),
          ["task:active", "task:pinned"],
        );
        assert.strictEqual(result.mainMessageCount, 1);
        const active = result.rows.find(
          (row) => row.kind === "task" && row.task.taskId === "task:active",
        );
        assert.strictEqual(active?.kind === "task" && active.mainMessagesSinceQuiet, 1);
        assert.strictEqual(active?.kind === "task" && active.unread, true);
        const coding = result.rows.filter((row) => row.kind === "coding");
        assert.lengthOf(coding, 1);
        assert.strictEqual(coding[0]?.threadId, "thread:child");
        assert.strictEqual(coding[0]?.environmentId, environmentId);
        const key =
          "task-view:" + encodeURIComponent(ownerId) + ":" + encodeURIComponent("task:pinned");
        yield* sql`UPDATE channel_runtime_state SET value_json = 'broken' WHERE key = ${key}`;
        assert.strictEqual((yield* Effect.flip(service.list(owner))).reason, "persistence_failed");
      }).pipe(
        Effect.provide(
          BotThreads.layer.pipe(
            Layer.provideMerge(TaskViews.layer),
            Layer.provideMerge(harness.layer),
          ),
        ),
      );
    },
  );
  it.effect(
    "lists a bot turn while its launched child work lives, and drops it when the child ends",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at) VALUES ('conv:bot', ${ownerId}, 'goat', 'goat', ${botThreadId}, ${time})`;
        // One turn per child state, plus a live child of an older generation and another owner's.
        const cases = [
          ["turn:launched", "launched", 1, ownerId],
          ["turn:bound", "bound", 1, ownerId],
          ["turn:unknown", "unknown", 1, ownerId],
          ["turn:reserved", "reserved", 1, ownerId],
          ["turn:completed", "completed", 1, ownerId],
          ["turn:cancelled", "cancelled", 1, ownerId],
          ["turn:old-generation", "bound", 2, ownerId],
          ["turn:foreign", "bound", 1, "foreign"],
        ] as const;
        const children = yield* ChildStore.ChannelChildWorkStore;
        for (const [taskId, state, taskGeneration, taskOwner] of cases) {
          yield* insertTask(taskId, taskOwner, "running", time);
          yield* sql`UPDATE channel_tasks SET generation = ${taskGeneration}, task_json = json_set(task_json, '$.kind', 'turn', '$.generation', ${taskGeneration}) WHERE task_id = ${taskId}`;
          yield* children.admitReserved(
            {
              ownerId: taskOwner,
              taskId: ChannelTaskId.make(taskId),
              childWorkId: ChannelChildWorkId.make("child"),
              generation: 1,
              callerThreadId: botThreadId,
              requestKey: taskId,
              promptDigest: "digest",
              surface: "thread_launch",
              destination: { threadId: ThreadId.make("thread:" + taskId) },
              state,
              createdAt: time,
              updatedAt: time,
            },
            100,
          );
        }
        // An earlier, finished launch of the same turn stays in its history.
        yield* children.admitReserved(
          {
            ownerId,
            taskId: ChannelTaskId.make("turn:bound"),
            childWorkId: ChannelChildWorkId.make("earlier"),
            generation: 1,
            callerThreadId: botThreadId,
            requestKey: "earlier",
            promptDigest: "digest",
            surface: "thread_launch",
            destination: { threadId: ThreadId.make("thread:earlier") },
            state: "completed",
            createdAt: old,
            updatedAt: old,
          },
          100,
        );
        const service = yield* BotThreads.ChannelBotThreads;
        const listed = (yield* service.list(owner)).rows;
        assert.deepStrictEqual(
          listed.flatMap((row) => (row.kind === "task" ? [row.task.taskId] : [])).sort(),
          ["turn:bound", "turn:launched", "turn:unknown"],
        );
        assert.deepStrictEqual(
          listed
            .flatMap((row) =>
              row.kind === "coding" && row.taskId === "turn:bound" ? [row.threadId] : [],
            )
            .sort(),
          ["thread:earlier", "thread:turn:bound"],
        );

        for (const [taskId] of cases) {
          yield* sql`UPDATE channel_runtime_state SET value_json = json_set(value_json, '$.state', 'completed') WHERE key = ${"child-work:" + taskId + ":child"}`;
        }
        assert.deepStrictEqual((yield* service.list(owner)).rows, []);
      }).pipe(
        Effect.provide(
          BotThreads.layer.pipe(
            Layer.provideMerge(TaskViews.layer),
            Layer.provideMerge(harness.layer),
          ),
        ),
      );
    },
  );

  it.effect(
    "says whether each launch the bot made is coding or a chore, and names a task's local worker",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at) VALUES ('conv:bot', ${ownerId}, 'goat', 'goat', ${botThreadId}, ${time})`;
        yield* insertTask("task:local", ownerId, "running", time);
        yield* insertTask("task:remote", ownerId, "running", time);
        const worker = (threadId: string, host?: string) =>
          JSON.stringify({ environmentId, threadId, generation: 1, ...(host ? { host } : {}) });
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.worker', json(${worker("channel-worker:local")})) WHERE task_id = 'task:local'`;
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.worker', json(${worker("channel-worker:remote", "remote")})) WHERE task_id = 'task:remote'`;
        const children = yield* ChildStore.ChannelChildWorkStore;
        // A launch's project and the work kind its launcher recorded, if any.
        const launches = [
          ["chore", "project:repo", "chore"],
          ["coding", "project:repo", "coding"],
          ["old-scratch", scratchProjectId, undefined],
          ["old-repo", "project:repo", undefined],
          ["unprojected", undefined, undefined],
        ] as const;
        for (const [id, projectId, workKind] of launches) {
          const threadId = "thread:" + id;
          yield* children.admitReserved(
            {
              ownerId,
              taskId: ChannelTaskId.make("task:local"),
              childWorkId: ChannelChildWorkId.make(id),
              generation: 1,
              callerThreadId: botThreadId,
              requestKey: id,
              promptDigest: "digest",
              surface: "thread_launch",
              destination: { threadId: ThreadId.make(threadId) },
              state: "bound",
              createdAt: time,
              updatedAt: time,
            },
            100,
          );
          if (projectId === undefined) continue;
          const payload = JSON.stringify({
            launchedBy: {
              kind: "launch",
              threadId: botThreadId,
              environmentId: null,
              environmentLabel: null,
              threadTitle: null,
              via: "thread_launch",
              ...(workKind === undefined ? {} : { workKind }),
            },
          });
          yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, ${projectId}, ${id}, 'codex', 'full-access', 'default', ${time}, ${time}, ${payload})`;
        }
        const service = yield* BotThreads.ChannelBotThreads;
        const remoteTask = yield* service.getBotTask(
          { taskId: ChannelTaskId.make("task:remote"), botId: BotId.make("main") },
          owner,
        );
        assert.include(remoteTask.remoteWork[0], {
          host: "remote",
          environmentId,
          threadId: ThreadId.make("channel-worker:remote"),
        });
        const rows = (yield* service.list(owner).pipe(
          Effect.provideService(
            ManagedProjectFolders.ManagedProjectFolders,
            ManagedProjectFolders.ManagedProjectFolders.of({
              isScratchProject: (projectId) => Effect.succeed(projectId === scratchProjectId),
            } as ManagedProjectFolders.ManagedProjectFolders["Service"]),
          ),
        )).rows;
        assert.deepStrictEqual(
          Object.fromEntries(
            rows.flatMap((row) =>
              row.kind === "coding" ? [[row.threadId, row.workKind ?? "unmarked"]] : [],
            ),
          ),
          {
            "thread:chore": "chore",
            "thread:coding": "coding",
            "thread:old-scratch": "chore",
            "thread:old-repo": "unmarked",
            "thread:unprojected": "unmarked",
          },
        );
        assert.deepStrictEqual(
          Object.fromEntries(
            rows.flatMap((row) =>
              row.kind === "task" ? [[row.task.taskId, row.worker ?? "none"]] : [],
            ),
          ),
          {
            "task:local": { environmentId, threadId: ThreadId.make("channel-worker:local") },
            // Another machine's worker is not one this bot's rows can open here.
            "task:remote": "none",
          },
        );
      }).pipe(
        Effect.provide(
          BotThreads.layer.pipe(
            Layer.provideMerge(TaskViews.layer),
            Layer.provideMerge(harness.layer),
          ),
        ),
      );
    },
  );

  it.effect(
    "lists the bot's SSH launches by host without borrowing a local thread's title or kind",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* TestClock.setTime(1791763200000);
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at) VALUES ('conv:bot', ${ownerId}, 'goat', 'goat', ${botThreadId}, ${time})`;
        yield* insertTask("task:live", ownerId, "running", time);
        // Older than the retention window and not pinned, so its launches are not listed.
        yield* insertTask("task:expired", ownerId, "completed", old);
        yield* insertTask("task:foreign", "foreign", "running", time);
        const children = yield* ChildStore.ChannelChildWorkStore;
        const shared = ThreadId.make("thread:shared");
        const launches = [
          [
            "task:live",
            "remote-chore",
            "ssh_thread_launch",
            "bound",
            {
              correlationId: "cw-chore",
              host: "box",
              threadId: shared,
              environmentId: EnvironmentId.make("env-box"),
              workKind: "chore" as const,
            },
          ],
          // A record from before remote identities were kept: the same thread id elsewhere.
          [
            "task:live",
            "remote-old",
            "ssh_thread_launch",
            "bound",
            {
              correlationId: "cw-old",
              host: "box",
              threadId: shared,
              environmentId: EnvironmentId.make("env-other"),
            },
          ],
          [
            "task:live",
            "remote-unknown",
            "ssh_thread_launch",
            "unknown",
            {
              correlationId: "cw-unknown",
              host: "mac",
            },
          ],
          [
            "task:live",
            "remote-released",
            "ssh_thread_launch",
            "released",
            {
              correlationId: "cw-released",
              host: "box",
            },
          ],
          ["task:live", "local", "thread_launch", "bound", { threadId: shared }],
          [
            "task:expired",
            "remote-expired",
            "ssh_thread_launch",
            "bound",
            {
              correlationId: "cw-expired",
              host: "box",
            },
          ],
          [
            "task:foreign",
            "remote-foreign",
            "ssh_thread_launch",
            "bound",
            {
              correlationId: "cw-foreign",
              host: "box",
            },
          ],
        ] as const;
        for (const [taskId, id, surface, state, destination] of launches) {
          yield* children.admitReserved(
            {
              ownerId: taskId === "task:foreign" ? "foreign" : ownerId,
              taskId: ChannelTaskId.make(taskId),
              childWorkId: ChannelChildWorkId.make(id),
              generation: 1,
              callerThreadId: botThreadId,
              requestKey: id,
              promptDigest: "digest",
              surface,
              destination,
              state,
              createdAt: time,
              updatedAt: time,
            },
            100,
          );
        }
        const payload = JSON.stringify({
          launchedBy: {
            kind: "launch",
            threadId: botThreadId,
            environmentId: null,
            environmentLabel: null,
            threadTitle: null,
            via: "thread_launch",
            workKind: "coding",
          },
        });
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${shared}, 'project:repo', 'Local title', 'codex', 'full-access', 'default', ${time}, ${time}, ${payload})`;
        const service = yield* BotThreads.ChannelBotThreads;
        const result = yield* service.list(owner);
        assert.deepStrictEqual(
          result.rows.flatMap((row) => (row.kind === "coding" ? [row] : [])),
          [
            {
              kind: "coding",
              taskId: ChannelTaskId.make("task:live"),
              environmentId,
              threadId: shared,
              title: "Local title",
              state: "bound",
              lastActivityAt: time,
              workKind: "coding",
            },
          ],
        );
        const base = {
          taskId: ChannelTaskId.make("task:live"),
          callerThreadId: botThreadId,
          lastActivityAt: time,
        };
        assert.deepStrictEqual(result.remoteWork, [
          {
            ...base,
            childWorkId: ChannelChildWorkId.make("remote-chore"),
            host: "box",
            state: "bound",
            threadId: shared,
            environmentId: EnvironmentId.make("env-box"),
            workKind: "chore",
          },
          {
            ...base,
            childWorkId: ChannelChildWorkId.make("remote-old"),
            host: "box",
            state: "bound",
            threadId: shared,
            environmentId: EnvironmentId.make("env-other"),
          },
          {
            ...base,
            childWorkId: ChannelChildWorkId.make("remote-unknown"),
            host: "mac",
            state: "unknown",
          },
        ]);
      }).pipe(
        Effect.provide(
          BotThreads.layer.pipe(
            Layer.provideMerge(TaskViews.layer),
            Layer.provideMerge(harness.layer),
          ),
        ),
      );
    },
  );

  it.effect("limits the task list to 100", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at) VALUES ('conv:bot', ${ownerId}, 'goat', 'goat', ${botThreadId}, ${time})`;
      for (let index = 0; index < 102; index++) {
        yield* insertTask(`task:active-${index}`, ownerId, "running", time);
      }
      const service = yield* BotThreads.ChannelBotThreads;
      const result = yield* service.list(owner);
      assert.lengthOf(result.rows, 100);
    }).pipe(
      Effect.provide(
        BotThreads.layer.pipe(
          Layer.provideMerge(TaskViews.layer),
          Layer.provideMerge(harness.layer),
        ),
      ),
    );
  });

  it.effect("lists work a person started by messaging the bot, with the messages since", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("do: count the stars", "real-1"), rpcContext);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("thanks", "real-2"), rpcContext);
      yield* runtime.drain;
      const result = yield* (yield* BotThreads.ChannelBotThreads).list(owner);
      assert.deepStrictEqual(
        result.rows.map((row) => (row.kind === "task" ? row.task.title : row.kind)),
        ["count the stars"],
      );
      assert.strictEqual(result.mainMessageCount, 2);
    }).pipe(Effect.provide(harness.layer));
  });
});
