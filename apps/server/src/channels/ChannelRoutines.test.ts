import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelGatewayError,
  type ChannelInputId,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2RuntimeRequest,
  RuntimeRequestId,
  type ScheduledTask,
  ScheduledTaskId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ScheduledTaskRuns from "../scheduledTasks/ScheduledTaskRuns.ts";
import {
  makeScheduledBotRoutines,
  ROUTINE_MESSAGE_PREFIX,
} from "../scheduledTasks/scheduledBotRoutines.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { inputIdFor } from "./channelIds.ts";
import { ROUTINE_COPY, ROUTINE_KEY_PREFIX } from "./channelRoutineInputs.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import {
  botMessages,
  botThreadId,
  defaultScript,
  goatInput,
  makeHarness,
  modelSelection,
  onlyTask,
  owner,
  ownerId,
  rpcContext,
  scratchProjectId,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const AT = "2026-11-09T08:00:00.000Z";
const routineOwner = { principalId: owner.principalId, grantedScopes: [...owner.grantedScopes] };

/** What the scheduler does when a routine bound to a bot thread fires: firing and link together. */
const admit = (prompt: string, key: string, threadId: ThreadId = botThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runs = yield* ScheduledTaskRuns.make();
    const routines = yield* makeScheduledBotRoutines();
    const task: ScheduledTask = {
      id: ScheduledTaskId.make("goat-bot-check-in:" + key),
      title: "Check in",
      prompt,
      enabled: true,
      notificationPolicy: "important_updates",
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId: scratchProjectId,
      threadId,
      workspaceStrategy: { type: "root" },
      modelSelection,
      memoryGrantCeiling: "none",
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      createdAt: AT,
      updatedAt: AT,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    };
    yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, notification_policy,
      schedule_json, project_id, thread_id, workspace_strategy_json, model_selection_json,
      memory_grant_ceiling, runtime_mode, interaction_mode, created_by, creation_source, created_at,
      updated_at, next_run_at, last_run_at, last_run_status, last_run_error, run_count)
      VALUES (${task.id}, ${task.title}, ${prompt}, 1, 'important_updates',
      ${JSON.stringify(task.schedule)}, ${task.projectId}, ${threadId}, ${JSON.stringify(task.workspaceStrategy)},
      ${JSON.stringify(modelSelection)}, 'none', 'approval-required', 'default', 'user', 'web',
      ${AT}, ${AT}, NULL, NULL, 'never', NULL, 0)`;
    const firingId = CommandId.make("scheduled-task:" + key);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* runs.begin({
          task,
          firingId,
          messageId: MessageId.make(ROUTINE_MESSAGE_PREFIX + key),
          requestedAt: AT,
          triggerKind: "manual",
          webhookDeliveryId: null,
        });
        yield* routines.link({ task, owner: routineOwner, firingId, at: AT });
      }),
    );
    return { firingId, taskId: task.id };
  });

const firing = (firingId: CommandId) =>
  Effect.flatMap(ScheduledTaskRuns.make(), (runs) => runs.readFiring(firingId));

const linkOf = (firingId: CommandId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      readonly state: string;
      readonly error: string | null;
      readonly input_id: ChannelInputId | null;
    }>`SELECT state, error, input_id FROM scheduled_task_channel_inputs WHERE firing_id = ${firingId}`.pipe(
      Effect.map((rows) => rows[0]),
    ),
  );

const said = (role: "user" | "assistant") =>
  Effect.map(botMessages, (records) =>
    records.messages.flatMap((message) => (message.role === role ? [message.text] : [])),
  );

const refusal = <A, R>(effect: Effect.Effect<A, ChannelGatewayError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

const approval: OrchestrationV2RuntimeRequest = {
  id: RuntimeRequestId.make("approval:deploy"),
  nodeId: NodeId.make("node:deploy"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: DateTime.makeUnsafe("2026-10-12T00:01:00.000Z"),
  resolvedAt: null,
};

/** A routine sees its own flag; "quiet" check-ins have nothing to report. */
const routineScript =
  (seen: Array<{ readonly text: string; readonly routine: boolean }>): typeof defaultScript =>
  (input) => {
    if (input.mode === "input")
      seen.push({ text: input.inputText ?? "", routine: input.routine === true });
    if (input.mode === "input" && input.inputText === "quiet")
      return Effect.succeed({ replyText: "Nothing new.", action: { type: "no_update" } });
    if (input.mode === "input" && input.inputText === "Look over my tasks")
      return Effect.succeed({
        replyText: "One task waits on you.",
        action: { type: "report_only" },
        remember: "Check in hourly.",
        rememberQuote: "Look over my tasks",
      });
    return defaultScript(input);
  };

describe("GOAT Bot routines", () => {
  it.effect(
    "a check-in is answered in the bot conversation without showing the check-in or keeping a note",
    () => {
      const harness = makeHarness();
      const seen: Array<{ readonly text: string; readonly routine: boolean }> = [];
      harness.script.current = routineScript(seen);
      return Effect.gen(function* () {
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const { firingId } = yield* admit("Look over my tasks", "answer");
        yield* runtime.drain;

        assert.deepStrictEqual(seen, [{ text: "Look over my tasks", routine: true }]);
        assert.deepStrictEqual(yield* said("user"), []);
        assert.deepStrictEqual(yield* said("assistant"), ["One task waits on you."]);
        assert.lengthOf((yield* botMessages).runs, 0);
        assert.strictEqual((yield* firing(firingId))?.status, "completed");
        assert.deepInclude(yield* linkOf(firingId), { state: "settled", error: null });
        // The model asked to keep a note; a check-in never writes one.
        const [decided] = yield* sql<{ readonly decision_json: string }>`
        SELECT decision_json FROM channel_inbox`;
        assert.notInclude(decided?.decision_json ?? "", "remember");

        // A crash before the link was marked repeats the ingest: same key, still one input.
        yield* sql`UPDATE scheduled_task_channel_inputs SET state = 'pending'`;
        yield* runtime.drain;
        assert.lengthOf(yield* sql`SELECT 1 FROM channel_inbox`, 1);
        assert.deepStrictEqual(yield* said("assistant"), ["One task waits on you."]);
        assert.lengthOf(seen, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a check-in cannot start work, and with nothing to report it stays silent", () => {
    const harness = makeHarness();
    const seen: Array<{ readonly text: string; readonly routine: boolean }> = [];
    harness.script.current = routineScript(seen);
    return Effect.gen(function* () {
      yield* setupBot;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const work = yield* admit("do: build the release", "work");
      yield* runtime.drain;
      assert.lengthOf((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks, 0);
      assert.deepStrictEqual(yield* said("assistant"), [ROUTINE_COPY.cannotStartWork]);
      assert.strictEqual((yield* firing(work.firingId))?.status, "completed");

      const quiet = yield* admit("quiet", "quiet");
      yield* runtime.drain;
      assert.deepStrictEqual(yield* said("assistant"), [ROUTINE_COPY.cannotStartWork]);
      assert.strictEqual((yield* firing(quiet.firingId))?.status, "completed");
      const inputId = (yield* linkOf(quiet.firingId))?.input_id;
      const snapshot = yield* gateway.getInput(inputId!, rpcContext);
      assert.strictEqual(snapshot.state, "replied");
      assert.strictEqual(snapshot.reply?.text, ROUTINE_COPY.noUpdate);
      assert.isUndefined(snapshot.reply?.sentAt);
      // Later passes still see that a check-in happened.
      const tail = yield* ledger.readConversationTail(snapshot.conversationId, 20);
      assert.deepInclude(
        tail.map((entry) => ({ text: entry.text, replyText: entry.replyText })),
        { text: "quiet", replyText: ROUTINE_COPY.noUpdate },
      );

      // A person's no_update is an ordinary answer.
      yield* gateway.ingest(goatInput("quiet", "person-quiet"), rpcContext);
      yield* runtime.drain;
      assert.include(yield* said("assistant"), "Nothing new.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a check-in's words answer no approval", () => {
    const harness = makeHarness();
    const seen: Array<{ readonly text: string; readonly routine: boolean }> = [];
    harness.script.current = routineScript(seen);
    const responses = () =>
      harness.world.commands.filter((command) => command.type === "runtime-request.respond");
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: deploy staging", "deploy"), rpcContext);
      yield* runtime.drain;
      harness.world.runtimeRequests.set((yield* onlyTask).worker!.threadId, [approval]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;

      yield* admit("Approve A1", "approve");
      yield* runtime.drain;
      assert.lengthOf(responses(), 0);
      assert.deepInclude(seen, { text: "Approve A1", routine: true });

      // The same words from the person approve.
      yield* gateway.ingest(goatInput("Approve A1", "person-approve"), rpcContext);
      yield* runtime.drain;
      assert.lengthOf(responses(), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("routine keys belong to the scheduler", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      assert.strictEqual(
        yield* refusal(gateway.ingest(goatInput("hi", "routine:claimed"), rpcContext)),
        "forbidden",
      );
      const schedule = {
        ...owner,
        caller: {
          type: "schedule" as const,
          scheduledTaskId: ScheduledTaskId.make("goat-bot-check-in:x"),
          firingId: CommandId.make("scheduled-task:x"),
        },
      };
      assert.strictEqual(
        yield* refusal(gateway.ingest(goatInput("hi", "ordinary"), schedule)),
        "forbidden",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "an admitted firing is answered once, as a routine, even after its routine is deleted",
    () => {
      const harness = makeHarness();
      harness.script.current = routineScript([]);
      return Effect.gen(function* () {
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const before = yield* admit("do: deploy before", "before");
        yield* sql`DELETE FROM scheduled_tasks WHERE task_id = ${before.taskId}`;
        yield* runtime.drain;
        assert.deepStrictEqual(yield* said("assistant"), [ROUTINE_COPY.cannotStartWork]);
        assert.deepInclude(yield* linkOf(before.firingId), { state: "settled" });

        const after = yield* admit("do: deploy after", "after");
        yield* runtime.runPass;
        yield* sql`DELETE FROM scheduled_tasks WHERE task_id = ${after.taskId}`;
        yield* runtime.drain;
        assert.deepStrictEqual(yield* said("assistant"), [
          ROUTINE_COPY.cannotStartWork,
          ROUTINE_COPY.cannotStartWork,
        ]);
        assert.lengthOf((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a member bot's routine lands in its conversation and fails once the member is gone",
    () => {
      const harness = makeHarness();
      harness.script.current = routineScript([]);
      return Effect.gen(function* () {
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const member = yield* members.create(
          {
            clientRequestId: "routine-member",
            name: "Helper",
            avatar: null,
            purpose: "Checks builds.",
            defaultModelSelection: null,
          },
          owner,
        );
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-member-thread"),
          threadId: member.sessionThreadId,
          projectId: scratchProjectId,
          title: "Helper",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "system",
          creationSource: "server",
        });
        const landed = yield* admit("Look over my tasks", "member", member.sessionThreadId);
        yield* runtime.drain;
        assert.strictEqual((yield* firing(landed.firingId))?.status, "completed");
        const inboxBots = yield* sql<{ readonly bot_id: string }>`SELECT bot_id FROM channel_inbox`;
        assert.deepStrictEqual(inboxBots, [{ bot_id: member.botId }]);

        yield* members.remove({ botId: member.botId }, owner);
        const orphan = yield* admit("Look over my tasks", "orphan", member.sessionThreadId);
        yield* runtime.drain;
        const failed = yield* firing(orphan.firingId);
        assert.strictEqual(failed?.status, "failed");
        const refused = yield* linkOf(orphan.firingId);
        assert.strictEqual(refused?.state, "settled");
        assert.include(refused?.error ?? "", "Set the routine up again");
        assert.lengthOf(yield* sql`SELECT 1 FROM channel_inbox`, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
describe("GOAT Bot routine resilience", () => {
  it.effect(
    "routines that keep failing do not hold back the routines after them, however many",
    () => {
      const harness = makeHarness();
      harness.script.current = routineScript([]);
      return Effect.gen(function* () {
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const later = yield* admit("Look over my tasks", "b-later");
        const [link] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM scheduled_task_channel_inputs WHERE firing_id = ${later.firingId}`;
        const payload = link!.payload_json;
        // A full batch of older firings whose input id another link already holds: storing each
        // fails on every pass.
        const stuck = Array.from({ length: 50 }, (_, index) =>
          CommandId.make("scheduled-task:a-stuck-" + String(index).padStart(2, "0")),
        );
        for (const firingId of stuck) {
          const taken = inputIdFor({
            ownerId,
            kind: "goat",
            connectionId: ChannelGateway.GOAT_CONNECTION_ID,
            idempotencyKey: ROUTINE_KEY_PREFIX + firingId,
          });
          yield* sql`INSERT INTO scheduled_task_channel_inputs
          (firing_id, task_id, input_id, payload_json, state, created_at) VALUES
          (${firingId}, 'stuck', NULL, ${payload}, 'pending', ${AT}),
          (${"stray:" + firingId}, 'stray', ${taken}, '{}', 'settled', ${AT})`;
        }
        yield* runtime.drain;
        yield* runtime.drain;
        assert.strictEqual((yield* firing(later.firingId))?.status, "completed");
        assert.deepInclude(yield* linkOf(stuck[0]!), { state: "pending" });
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
