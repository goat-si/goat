// @effect-diagnostics-next-line nodeBuiltinImport:off -- fixture signs the original byte body with HMAC.
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelGatewayError,
  type ChannelInputId,
  ChannelQuestionId,
  type ChannelReceptionResult,
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  type OrchestrationV2RuntimeRequest,
  RuntimeRequestId,
  type ScheduledTask,
  ScheduledTaskId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { layerSessionStore } from "../auth/SessionEnd.testkit.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { preparationSettled } from "../orchestration-v2/testkit/preparationSettled.ts";
import {
  drainPendingDispatch,
  requestFor,
  waitForSpan,
  webhookTaskInput,
  withWebhookService,
} from "../scheduledTasks/ScheduledRunFixture.testkit.ts";
import * as ScheduledTaskRuns from "../scheduledTasks/ScheduledTaskRuns.ts";
import { readRecentRuns } from "../scheduledTasks/scheduledTaskRecentRuns.ts";
import {
  makeScheduledBotRoutines,
  ROUTINE_MESSAGE_PREFIX,
} from "../scheduledTasks/scheduledBotRoutines.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { inputIdFor } from "./channelIds.ts";
import { ROUTINE_COPY, ROUTINE_KEY_PREFIX } from "./channelRoutineInputs.ts";
import * as ChannelRoutineIntake from "./ChannelRoutineIntake.ts";
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
  projectId,
  owner,
  ownerId,
  rpcContext,
  scratchProjectId,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const AT = "2026-11-09T08:00:00.000Z";
const routineOwner = { principalId: owner.principalId, grantedScopes: [...owner.grantedScopes] };

/** What the scheduler does when a routine bound to a bot thread fires: firing and link together. */
const admit = (
  prompt: string,
  key: string,
  threadId: ThreadId = botThreadId,
  work?: { readonly sessionId: string; readonly projectId: ProjectId },
) =>
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
      ...(work === undefined ? {} : { routineMode: "work" as const }),
      schedule:
        work === undefined
          ? { type: "interval", everyMs: 3_600_000 }
          : {
              type: "webhook",
              signature: { header: "x-test-signature", encoding: "hex", prefix: "" },
            },
      projectId: work?.projectId ?? scratchProjectId,
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
      schedule_json, project_id, thread_id, thread_mode, workspace_strategy_json, model_selection_json,
      memory_grant_ceiling, runtime_mode, interaction_mode, created_by, creation_source, created_at,
      updated_at, next_run_at, last_run_at, last_run_status, last_run_error, run_count)
      VALUES (${task.id}, ${task.title}, ${prompt}, 1, 'important_updates',
      ${JSON.stringify(task.schedule)}, ${task.projectId}, ${threadId}, 'continue', ${JSON.stringify(task.workspaceStrategy)},
      ${JSON.stringify(modelSelection)}, 'none', 'approval-required', 'default', 'user', 'web',
      ${AT}, ${AT}, NULL, NULL, 'never', NULL, 0)`;
    const triggerOwner =
      work === undefined
        ? routineOwner
        : {
            ...routineOwner,
            sessionId: work.sessionId,
            routineMode: "work" as const,
          };
    if (work !== undefined)
      yield* sql`UPDATE scheduled_tasks SET owner_json=${JSON.stringify(triggerOwner)}, webhook_secret='fixture' WHERE task_id=${task.id}`;
    const firingId = CommandId.make("scheduled-task:" + key);
    const deliveryId = work === undefined ? null : "delivery:" + key;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* runs.begin({
          task,
          firingId,
          messageId: MessageId.make(ROUTINE_MESSAGE_PREFIX + key),
          requestedAt: AT,
          triggerKind: deliveryId === null ? "manual" : "webhook",
          webhookDeliveryId: deliveryId,
        });
        yield* routines.link({
          task,
          owner: triggerOwner,
          firingId,
          at: AT,
          ...(deliveryId === null ? {} : { webhook: { deliveryId, prompt } }),
        });
      }),
    );
    return { firingId, taskId: task.id };
  });

const firing = (firingId: CommandId) =>
  Effect.flatMap(ScheduledTaskRuns.make(), (runs) => runs.readFiring(firingId));

const providerStarts = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql`SELECT 1 FROM orchestration_v2_effect_outbox
    WHERE thread_id=${threadId} AND effect_type='provider-turn.start'`;

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
      // Its run reads as quiet in the routine's history, through the input it sent.
      const workInputId = (yield* linkOf(work.firingId))?.input_id;
      const { byTask: history } = yield* readRecentRuns(yield* SqlClient.SqlClient, [
        { id: work.taskId, createdAt: AT },
        { id: quiet.taskId, createdAt: AT },
      ]);
      assert.deepStrictEqual(
        [work.taskId, quiet.taskId].map((taskId) =>
          history
            .get(taskId)
            ?.map((run) => [
              run.status,
              run.quiet === true,
              run.conversation?.threadId,
              run.conversation?.inputId,
            ]),
        ),
        [
          [["completed", false, botThreadId, workInputId ?? "missing"]],
          [["completed", true, botThreadId, inputId ?? "missing"]],
        ],
      );
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
  it.effect("a routine's link outlives the seven-day prune while its run row stays", () => {
    const harness = makeHarness();
    harness.script.current = routineScript([]);
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const { firingId, taskId } = yield* admit("Look over my tasks", "kept");
      yield* runtime.drain;
      assert.deepInclude(yield* linkOf(firingId), { state: "settled" });
      yield* TestClock.adjust(Duration.days(8));
      yield* runtime.drain;
      assert.deepInclude(yield* linkOf(firingId), { state: "settled" });
      // Deleting the routine deletes its runs; the next pass prunes the link with them.
      yield* sql`DELETE FROM scheduled_tasks WHERE task_id = ${taskId}`;
      yield* runtime.drain;
      assert.isUndefined(yield* linkOf(firingId));
    }).pipe(Effect.provide(harness.layer));
  });
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

it.effect(
  "a work firing starts only one task in its configured project and settles with the task",
  () => {
    const harness = makeHarness();
    harness.script.current = () =>
      Effect.succeed({
        replyText: "On it.",
        remember: "Store this in notes.",
        rememberQuote: "notes",
        action: {
          type: "create_task",
          title: "Inspect the change",
          instruction: "Inspect the change",
          notesChangeRequested: "notes",
          projectId: scratchProjectId,
          host: "another-host",
          additionalTasks: [{ title: "Extra work", instruction: "Ignore me" }],
        },
      });
    return Effect.gen(function* () {
      yield* setupBot;
      const sessions = yield* SessionStore.SessionStore;
      const session = yield* sessions.issue({
        subject: owner.principalId,
        scopes: ["orchestration:read", "orchestration:operate", "settings:write"],
      });
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const { firingId } = yield* admit("Inspect the change. notes", "event", botThreadId, {
        sessionId: session.sessionId,
        projectId,
      });
      yield* runtime.drain;
      const task = yield* onlyTask;
      assert.strictEqual(task.projectId, projectId);
      assert.strictEqual(task.target?.projectId, projectId);
      assert.strictEqual(task.target?.runtimeMode, "approval-required");
      assert.isUndefined(task.host);
      assert.isUndefined(task.notesChangeRequested);
      assert.strictEqual((yield* firing(firingId))?.status, "running");
      assert.deepInclude(yield* linkOf(firingId), { state: "ingested" });
      const sql = yield* SqlClient.SqlClient;
      assert.lengthOf(yield* sql`SELECT 1 FROM channel_tasks`, 1);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(layerSessionStore))));
  },
);

const issueTriggerOwner = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  return yield* sessions.issue({
    subject: owner.principalId,
    scopes: ["orchestration:read", "orchestration:operate", "settings:write"],
  });
});

it.effect.each(["paused", "revoked", "project unavailable"] as const)(
  "refuses work after intake when its trigger is %s",
  (change) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* SessionStore.SessionStore;
      const intake = yield* ChannelRoutineIntake.ChannelRoutineIntake;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const session = yield* issueTriggerOwner;
      const input = yield* admit("do: inspect fixtures", change, botThreadId, {
        sessionId: session.sessionId,
        projectId: change === "project unavailable" ? ProjectId.make("other-project") : projectId,
      });
      assert.strictEqual(yield* intake.ingestPending, 1);
      if (change === "paused")
        yield* sql`UPDATE scheduled_tasks SET enabled=0 WHERE task_id=${input.taskId}`;
      if (change === "revoked") yield* sessions.revoke(session.sessionId);
      yield* runtime.drain;
      const task = yield* onlyTask;
      assert.strictEqual(task.status, "failed");
      assert.lengthOf(harness.world.launches, 0);
      assert.strictEqual((yield* firing(input.firingId))?.status, "failed");
      assert.include(
        (yield* linkOf(input.firingId))?.error ?? "",
        change === "project unavailable" ? "unavailable" : change,
      );
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(layerSessionStore))));
  },
);

it.effect.each(["paused during launch", "revoked during recovery"] as const)(
  "never enqueues a provider start for a work trigger %s",
  (change) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const recovering = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let branchReads = 0;
      const harness = makeHarness({
        realWorkerLaunch: true,
        getWorkerBranch: () =>
          Effect.gen(function* () {
            // The first read only seeds the thread shell, before it has a preparing run.
            if (branchReads++ === 0) return null;
            if (yield* Deferred.succeed(started, undefined)) {
              if (change === "revoked during recovery") return yield* Effect.never;
            } else {
              yield* Deferred.succeed(recovering, undefined);
            }
            yield* Deferred.await(resume);
            return null;
          }),
      });
      yield* Effect.gen(function* () {
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionStore.SessionStore;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const session = yield* issueTriggerOwner;
        const input = yield* admit("do: inspect fixtures", change, botThreadId, {
          sessionId: session.sessionId,
          projectId,
        });
        yield* runtime.drain;
        const { worker } = yield* onlyTask;
        if (worker === undefined) return assert.fail("Expected a bound worker in preparation");
        yield* Deferred.await(started);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const before = yield* threads.getThreadProjection(worker.threadId);
        const run = before.runs[0];
        if (run?.status !== "preparing") return assert.fail("Expected a durable preparing run");
        if (change === "revoked during recovery") {
          const launches = yield* ThreadLaunch.ThreadLaunchService;
          yield* launches.prepareRun({
            commandId: CommandId.make(`${harness.world.launches[0]?.commandId}:recovery`),
            threadId: worker.threadId,
            runId: run.id,
          });
          yield* Deferred.await(recovering);
          yield* sessions.revoke(session.sessionId);
        } else {
          yield* sql`UPDATE scheduled_tasks SET enabled=0 WHERE task_id=${input.taskId}`;
        }
        yield* Deferred.succeed(resume, undefined);
        const prepared = yield* preparationSettled(worker.threadId);
        assert.lengthOf(yield* providerStarts(sql, worker.threadId), 0);
        assert.strictEqual(prepared.runs[0]?.status, "failed");
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, "failed");
        assert.strictEqual((yield* firing(input.firingId))?.status, "failed");
        assert.include(
          (yield* linkOf(input.firingId))?.error ?? "",
          change === "paused during launch" ? "paused" : "revoked",
        );
      }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(layerSessionStore))));
    }),
);

it.effect.each(["paused", "revoked", "input missing", "settled generation"] as const)(
  "refuses a work trigger %s while release is planning its commit",
  (change) =>
    Effect.gen(function* () {
      const preparing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const planning = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      let branchReads = 0;
      const harness = makeHarness({
        realWorkerLaunch: true,
        getWorkerBranch: () =>
          Effect.gen(function* () {
            if (branchReads++ === 0) return null;
            yield* Deferred.succeed(preparing, undefined);
            yield* Deferred.await(release);
            return null;
          }),
        beforeWorkerCapabilities: Effect.gen(function* () {
          if (!(yield* Deferred.isDone(release))) return;
          yield* Deferred.succeed(planning, undefined);
          yield* Deferred.await(commit);
        }),
      });
      yield* Effect.gen(function* () {
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const session = yield* issueTriggerOwner;
        const input = yield* admit("do: inspect fixtures", change, botThreadId, {
          sessionId: session.sessionId,
          projectId,
        });
        yield* runtime.drain;
        const { taskId, worker } = yield* onlyTask;
        if (worker === undefined) return assert.fail("Expected a bound worker");
        yield* Deferred.await(preparing);
        const threads = yield* ThreadManagement.ThreadManagementService;
        assert.strictEqual(
          (yield* threads.getThreadProjection(worker.threadId)).runs[0]?.status,
          "preparing",
        );
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(planning);
        if (change === "paused")
          yield* sql`UPDATE scheduled_tasks SET enabled=0 WHERE task_id=${input.taskId}`;
        // The revocation commits before the session's live-scope cache is invalidated.
        if (change === "revoked")
          yield* sql`UPDATE auth_sessions SET revoked_at=${AT} WHERE session_id=${session.sessionId}`;
        if (change === "input missing")
          yield* sql`DELETE FROM scheduled_task_channel_inputs WHERE firing_id=${input.firingId}`;
        if (change === "settled generation")
          yield* sql`UPDATE channel_tasks SET status='failed' WHERE task_id=${taskId}`;
        yield* Deferred.succeed(commit, undefined);
        const prepared = yield* preparationSettled(worker.threadId);
        assert.lengthOf(yield* providerStarts(sql, worker.threadId), 0);
        const reason = {
          paused: "paused",
          revoked: "revoked",
          "input missing": "work trigger was deleted",
          "settled generation": "generation is no longer active",
        }[change];
        const denial = prepared.turnItems.find((item) => item.type === "error")?.failure;
        assert.include(denial?.message ?? "", reason);
      }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(layerSessionStore))));
    }),
);

it.effect("workspace Retry cannot start a denied trigger after its firing settled", () =>
  Effect.gen(function* () {
    const preparing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let branchReads = 0;
    const harness = makeHarness({
      realWorkerLaunch: true,
      getWorkerBranch: () =>
        Effect.gen(function* () {
          if (branchReads++ === 0) return null;
          yield* Deferred.succeed(preparing, undefined);
          yield* Deferred.await(release);
          return null;
        }),
    });
    yield* Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const input = yield* admit("do: inspect fixtures", "workspace retry", botThreadId, {
        sessionId: (yield* issueTriggerOwner).sessionId,
        projectId,
      });
      yield* runtime.drain;
      const { worker } = yield* onlyTask;
      if (worker?.runId === undefined) return assert.fail("Expected a bound worker run");
      yield* Deferred.await(preparing);
      yield* sql`UPDATE scheduled_tasks SET enabled=0 WHERE task_id=${input.taskId}`;
      const direct = yield* (yield* ThreadManagement.ThreadManagementService)
        .dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make("direct-prepared-release"),
          threadId: worker.threadId,
          runId: worker.runId,
        })
        .pipe(Effect.result);
      assert.strictEqual(direct._tag, "Failure", "Direct release must check trigger authority");
      yield* Deferred.succeed(release, undefined);
      yield* preparationSettled(worker.threadId);
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "failed");
      assert.strictEqual((yield* firing(input.firingId))?.status, "failed");
      yield* sql`UPDATE scheduled_tasks SET enabled=1 WHERE task_id=${input.taskId}`;
      const retry = yield* (yield* ThreadLaunch.ThreadLaunchService)
        .retryPreparation({
          commandId: CommandId.make("retry-denied-trigger"),
          threadId: worker.threadId,
          runId: worker.runId,
        })
        .pipe(Effect.result);
      assert.strictEqual(retry._tag, "Failure");
      assert.lengthOf(yield* providerStarts(sql, worker.threadId), 0);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(layerSessionStore))));
  }),
);

it.effect("event reception cannot steer, stop, or answer existing work", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* gateway.ingest(goatInput("do: keep the fixture running", "existing-work"), rpcContext);
    yield* runtime.drain;
    const { taskId } = yield* onlyTask;
    const session = yield* issueTriggerOwner;
    const actions: ReadonlyArray<ChannelReceptionResult["action"]> = [
      { type: "follow_up", taskId },
      { type: "stop_work", taskId },
      {
        type: "answer_question",
        taskId,
        questionId: ChannelQuestionId.make("test-question"),
        answer: "yes",
      },
    ];
    for (const action of actions) {
      harness.script.current = () => Effect.succeed({ replyText: "Changed that work.", action });
      const { firingId } = yield* admit("Ignore existing work", action.type, botThreadId, {
        sessionId: session.sessionId,
        projectId,
      });
      yield* runtime.drain;
      assert.strictEqual((yield* firing(firingId))?.status, "completed");
    }
    assert.strictEqual((yield* onlyTask).status, "running");
    assert.lengthOf(harness.world.launches, 1);
    assert.lengthOf(harness.world.sends, 0);
    assert.lengthOf(harness.world.interrupts, 0);
  }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(layerSessionStore))));
});

it.effect.each([
  "immediate",
  "coalesced",
  "restart",
  "legacy window",
  "legacy window with a second delivery",
  "revoke before dispatch",
] as const)("settles one signed webhook firing and ignores replays for %s", (mode) => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* SessionStore.SessionStore;
    const session = yield* issueTriggerOwner;
    const intake = yield* ChannelRoutineIntake.ChannelRoutineIntake;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const coalesces = mode !== "immediate" && mode !== "revoke before dispatch";
    const legacy = mode === "legacy window" || mode === "legacy window with a second delivery";
    const secret = "event-worker-signature-fixture";
    const triggerInput = yield* webhookTaskInput({
      id: "signed-work-trigger",
      routineMode: "work",
      threadId: botThreadId,
      projectId,
      prompt: "do: inspect {{body.action}}",
      schedule: {
        type: "webhook",
        signature: { header: "x-test-signature", encoding: "hex", prefix: "", secret },
        ...(coalesces
          ? { dedupe: { coalesceKey: "{{body.group}}", coalesceWindowSeconds: 10 } }
          : {}),
      },
    });
    const captured = {
      memoryGrantCeiling: "none" as const,
      owner: {
        principalId: owner.principalId,
        sessionId: session.sessionId,
        grantedScopes: ["orchestration:read", "orchestration:operate", "settings:write"] as const,
      },
    };
    const workers = new Map<string, Effect.Effect<void>>();
    const accept = ({ service }: WebhookServices) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(triggerInput, captured);
        const signed = (action: string) => {
          const bodyText = JSON.stringify({ action, group: "fixture" });
          const body = new TextEncoder().encode(bodyText);
          return requestFor(task, {
            bodyText,
            body,
            headers: {
              "content-type": "application/json",
              "x-test-signature": NodeCrypto.createHmac("sha256", secret)
                .update(body)
                .digest("hex"),
            },
          });
        };
        const first = signed("first fixture");
        const delivered = coalesces
          ? yield* service.triggerWebhook(first)
          : yield* waitForSpan(
              service.triggerWebhook(first),
              "ScheduledTaskService.runWebhookDelivery",
            );
        if (delivered._tag !== "accepted" || delivered.outcome !== "accepted")
          return yield* Effect.die("Expected a signed delivery");
        const latest = signed("latest fixture");
        if (legacy) {
          // Legacy windows stored the bare SHA-256 key and omitted the binding revision.
          yield* sql`UPDATE scheduled_task_webhook_pending SET coalesce_key=substr(coalesce_key, -64),
            task_json=json_remove(task_json, '$.bindingRevision') WHERE delivery_id=${delivered.deliveryId}`;
          yield* sql`UPDATE scheduled_tasks SET owner_json=json_remove(owner_json, '$.bindingRevision')
            WHERE task_id=${task.id}`;
        } else if (coalesces) {
          assert.deepInclude(yield* service.triggerWebhook(latest), { outcome: "coalesced" });
        }
        return { task, delivered, first, latest };
      });
    const settle = (
      { service, runs }: WebhookServices,
      { task, delivered, first, latest }: Effect.Success<ReturnType<typeof accept>>,
      activeWorkers: Map<string, Effect.Effect<void>>,
    ) =>
      Effect.gen(function* () {
        const hasLatest =
          mode === "coalesced" ||
          mode === "restart" ||
          mode === "legacy window with a second delivery";
        if (legacy) yield* service.upsert(triggerInput, captured);
        if (mode === "legacy window with a second delivery")
          assert.deepInclude(yield* service.triggerWebhook(latest), { outcome: "coalesced" });
        if (coalesces) {
          yield* TestClock.adjust("10 seconds");
          yield* drainPendingDispatch(activeWorkers);
        }
        assert.strictEqual(yield* intake.ingestPending, 1);
        if (mode === "revoke before dispatch") yield* sessions.revoke(session.sessionId);
        yield* runtime.drain;
        const work = yield* onlyTask;
        if (mode !== "revoke before dispatch") {
          if (work.worker === undefined) return assert.fail("The bot did not launch a worker");
          assert.strictEqual(work.projectId, projectId);
          assert.include(
            harness.world.launches[0]?.initialMessage?.text ?? "",
            hasLatest ? "latest fixture" : "first fixture",
          );
          assert.strictEqual(
            (yield* runs.deliveryReceipt(delivered.deliveryId))?.status,
            "running",
          );
          assert.isTrue(
            (yield* service.getWebhookDelivery({
              id: task.id,
              deliveryId: delivered.deliveryId,
            })).delivery.firingAccepted,
          );
          harness.world.setStatus(
            work.worker.threadId,
            1,
            "completed",
            "Inspected the fixture change.",
          );
          yield* runtime.drain;
          assert.strictEqual((yield* onlyTask).status, "completed");
        } else {
          assert.lengthOf(harness.world.launches, 0);
          assert.include(work.resultSummary ?? "", "revoked");
          const {
            deliveries: [refused],
          } = yield* service.listWebhookDeliveries({ id: task.id });
          if (refused === undefined) return assert.fail("Expected the refused delivery");
          assert.strictEqual(refused.outcome, "dispatch_failed");
          assert.strictEqual(refused.error, work.resultSummary ?? null);
        }
        const terminal = yield* runs.deliveryReceipt(delivered.deliveryId);
        assert.strictEqual(
          terminal?.status,
          mode === "revoke before dispatch" ? "failed" : "completed",
        );
        assert.isNotNull(terminal?.completedAt);
        assert.deepInclude(yield* service.triggerWebhook(first), { outcome: "duplicate" });
        if (hasLatest)
          assert.deepInclude(yield* service.triggerWebhook(latest), { outcome: "duplicate" });
        yield* runtime.drain;
        assert.lengthOf(yield* sql`SELECT 1 FROM channel_inbox`, 1);
        assert.lengthOf(yield* sql`SELECT 1 FROM channel_tasks`, 1);
        assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_task_runs`, 1);
        assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`, 0);
        assert.lengthOf(harness.world.launches, mode === "revoke before dispatch" ? 0 : 1);
        assert.deepStrictEqual(yield* runs.deliveryReceipt(delivered.deliveryId), terminal);
      }).pipe(Effect.provideService(ChannelLedger.ChannelLedger, ledger));
    if (mode === "restart" || legacy) {
      const accepted = yield* withWebhookService(accept, { sql, workers });
      const recoveredWorkers = new Map<string, Effect.Effect<void>>();
      yield* withWebhookService((context) => settle(context, accepted, recoveredWorkers), {
        sql,
        workers: recoveredWorkers,
      });
    } else {
      yield* withWebhookService(
        (context) =>
          Effect.flatMap(accept(context), (accepted) => settle(context, accepted, workers)),
        { sql, workers },
      );
    }
  }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(layerSessionStore))));
});

type WebhookServices = Parameters<Parameters<typeof withWebhookService>[0]>[0];
