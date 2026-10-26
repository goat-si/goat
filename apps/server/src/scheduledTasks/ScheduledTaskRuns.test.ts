import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ScheduledTask, ScheduledTaskRun } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Runs from "./ScheduledTaskRuns.ts";

const layer = Runs.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const encodeSchedule = Schema.encodeEffect(Schema.fromJsonString(ScheduledTask.fields.schedule));
const decodeRun = Schema.decodeUnknownEffect(ScheduledTaskRun);
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(ScheduledTaskRun));
const at = "2026-10-15T00:00:00.000Z";
const makeTask = (schedule: ScheduledTask["schedule"] = { type: "interval", everyMs: 60000 }) =>
  decodeTask({
    id: "task",
    title: "Synthetic",
    prompt: "Synthetic",
    enabled: true,
    schedule,
    projectId: "project",
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: at,
    updatedAt: at,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  });
const seed = Effect.fn("ScheduledTaskRunsTest.seed")(function* (task: ScheduledTask) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count)
    VALUES (${task.id},'Synthetic','Synthetic',1,${yield* encodeSchedule(task.schedule)},'project','{}','{}','full-access','default','user','web',${task.createdAt},${at},${task.nextRunAt},'never',0)`;
});
const claim = (
  task: ScheduledTask,
  id: string,
  triggerKind: "manual" | "webhook" | "scheduled" = "manual",
  requestedAt = at,
) => ({
  task,
  firingId: CommandId.make(id),
  messageId: MessageId.make(`message:${id}`),
  requestedAt,
  triggerKind,
  webhookDeliveryId: triggerKind === "webhook" ? `delivery:${id}` : null,
});
const admit = Effect.fn("ScheduledTaskRunsTest.admit")(function* (
  ...args: Parameters<typeof claim>
) {
  const runs = yield* Runs.ScheduledTaskRuns;
  const sql = yield* SqlClient.SqlClient;
  const [current] = yield* sql<{
    readonly next_run_at: string | null;
  }>`SELECT next_run_at FROM scheduled_tasks WHERE task_id=${args[0].id}`;
  return yield* runs.begin(
    claim({ ...args[0], nextRunAt: current?.next_run_at ?? null }, args[1], args[2], args[3]),
  );
});
const finish = (id: string, rejected = false) => ({
  firingId: CommandId.make(id),
  acceptedRun: null,
  at,
  dispatchEvidence: rejected ? ("rejected" as const) : ("unresolved" as const),
});

it.effect(
  "counts one admission, reserves dispatch until bookkeeping and treats return-only success as unknown",
  () =>
    Effect.gen(function* () {
      const runs = yield* Runs.ScheduledTaskRuns;
      const sql = yield* SqlClient.SqlClient;
      const task = makeTask();
      yield* seed(task);
      assert.deepEqual(yield* admit(task, "A"), { created: true, dispatch: true });
      assert.deepEqual(yield* admit(task, "A"), { created: false, dispatch: false });
      assert.equal((yield* Effect.flip(admit(task, "B")))._tag, "ScheduledTaskError");
      const unknown = yield* runs.finishDispatch(finish("A"));
      assert.equal(unknown.status, "unknown");
      assert.equal(unknown.runId, null);
      assert.deepEqual(yield* sql`SELECT run_count,last_run_status FROM scheduled_tasks`, [
        { run_count: 1, last_run_status: "running" },
      ]);
      yield* runs.reconcile;
      yield* runs.reconcile;
      assert.deepEqual(yield* admit(task, "A"), { created: false, dispatch: false });
      yield* admit(task, "B");
      assert.deepEqual(yield* sql`SELECT run_count FROM scheduled_tasks`, [{ run_count: 2 }]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "retry A after B refreshes admission and latest identity and restart never counts twice",
  () =>
    Effect.gen(function* () {
      const runs = yield* Runs.ScheduledTaskRuns;
      const sql = yield* SqlClient.SqlClient;
      const task = makeTask();
      yield* seed(task);
      yield* admit(task, "A", "webhook");
      yield* runs.finishDispatch(finish("A", true));
      // Delivery logs retain failed receipts until their replay cleanup has completed.
      yield* sql`INSERT INTO scheduled_task_webhook_pending (delivery_id,task_id,coalesce_key,task_json,request_json,due_at,state,delivery_ids_json)
    VALUES ('delivery:A','task','A','{}','{}',0,'failed','[]')`;
      yield* admit(task, "B");
      yield* runs.finishDispatch(finish("B"));
      const b = yield* sql`SELECT * FROM scheduled_task_runs WHERE firing_id='B'`;
      const retryAt = "2026-10-15T00:01:00.000Z";
      // The task is edited between attempts; the retry must admit the current configuration.
      const edited = makeTask({ type: "interval", everyMs: 120000 });
      yield* sql`UPDATE scheduled_tasks SET schedule_json=${yield* encodeSchedule(edited.schedule)},
        next_run_at='2026-10-15T00:05:00.000Z'`;
      assert.deepEqual(yield* sql`SELECT last_run_status,last_run_error FROM scheduled_tasks`, [
        {
          last_run_status: "running",
          last_run_error: "The scheduled run outcome could not be recovered.",
        },
      ]);
      assert.deepEqual(yield* admit(edited, "A", "webhook", retryAt), {
        created: false,
        dispatch: true,
      });
      assert.deepEqual(
        yield* sql`SELECT last_firing_id,last_run_at,run_count FROM scheduled_tasks`,
        [{ last_firing_id: "A", last_run_at: retryAt, run_count: 3 }],
      );
      assert.deepEqual(
        yield* sql`SELECT attempt,dispatch_bookkept_at FROM scheduled_task_runs WHERE firing_id='A'`,
        [{ attempt: 2, dispatch_bookkept_at: null }],
      );
      assert.deepEqual(
        yield* sql`SELECT admitted_next_run_at,admitted_schedule_digest,admitted_enabled FROM scheduled_task_runs WHERE firing_id='A'`,
        [
          {
            admitted_next_run_at: "2026-10-15T00:05:00.000Z",
            admitted_schedule_digest: '{"type":"interval","everyMs":120000}',
            admitted_enabled: 1,
          },
        ],
      );
      assert.deepEqual(yield* sql`SELECT last_run_status,last_run_error FROM scheduled_tasks`, [
        { last_run_status: "running", last_run_error: null },
      ]);
      yield* runs.reconcile;
      yield* runs.reconcile;
      assert.deepEqual(yield* sql`SELECT run_count FROM scheduled_tasks`, [{ run_count: 3 }]);
      assert.deepEqual(yield* sql`SELECT * FROM scheduled_task_runs WHERE firing_id='B'`, b);
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["manual", "scheduled", "webhook"] as const)(
  "%s advancement uses admitted nullable time and configuration and never overwrites edits",
  (kind) =>
    Effect.gen(function* () {
      const runs = yield* Runs.ScheduledTaskRuns;
      const sql = yield* SqlClient.SqlClient;
      const task = { ...makeTask(), nextRunAt: kind === "scheduled" ? at : null };
      yield* seed(task);
      yield* admit(task, "A", kind);
      assert.deepEqual(
        yield* sql`SELECT admitted_next_run_at,admitted_enabled,admitted_schedule_digest FROM scheduled_task_runs`,
        [
          {
            admitted_next_run_at: task.nextRunAt,
            admitted_enabled: 1,
            admitted_schedule_digest: '{"type":"interval","everyMs":60000}',
          },
        ],
      );
      yield* sql`UPDATE scheduled_tasks SET next_run_at='2026-11-01T00:00:00.000Z',enabled=0`;
      yield* runs.finishDispatch(finish("A"));
      yield* runs.finishDispatch(finish("A"));
      assert.deepEqual(yield* sql`SELECT next_run_at,enabled,run_count FROM scheduled_tasks`, [
        { next_run_at: "2026-11-01T00:00:00.000Z", enabled: 0, run_count: 1 },
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect("retains only five bookkept unknowns plus current and pending pins across restart", () =>
  Effect.gen(function* () {
    const runs = yield* Runs.ScheduledTaskRuns;
    const sql = yield* SqlClient.SqlClient;
    const task = makeTask();
    yield* seed(task);
    yield* admit(task, "A", "webhook");
    yield* sql`INSERT INTO scheduled_task_webhook_pending (delivery_id,task_id,coalesce_key,task_json,request_json,due_at,state,delivery_ids_json)
      VALUES ('delivery:A','task','A','{}','{}',0,'failed','[]')`;
    yield* runs.finishDispatch(finish("A"));
    for (let i = 0; i < 9; i++) {
      yield* admit(task, `firing:${i}`);
      yield* runs.finishDispatch(finish(`firing:${i}`));
    }
    assert.equal((yield* sql`SELECT * FROM scheduled_task_runs`).length, 6);
    yield* runs.reconcile;
    assert.equal((yield* sql`SELECT * FROM scheduled_task_runs`).length, 6);
    yield* sql`DELETE FROM scheduled_tasks WHERE task_id='task'`;
    assert.deepEqual(yield* sql`SELECT * FROM scheduled_task_runs`, []);
    assert.equal(
      (yield* Effect.flip(runs.finishDispatch(finish("firing:8"))))._tag,
      "ScheduledTaskError",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { dispatchStatus: "accepted", status: "queued", threadId: null, runId: null },
  { dispatchStatus: "dispatching", status: "dispatching", threadId: "thread", runId: "run" },
  { dispatchStatus: "failed", status: "failed", threadId: "thread", runId: "run" },
] as const)("rejects corrupt stored ID nullability ($dispatchStatus)", (invalid) =>
  Effect.gen(function* () {
    const runs = yield* Runs.ScheduledTaskRuns;
    const sql = yield* SqlClient.SqlClient;
    const task = makeTask();
    yield* seed(task);
    yield* admit(task, "A");
    const snapshot = yield* decodeRun({
      firingId: "A",
      ...invalid,
      requestedAt: at,
      dispatchedAt: null,
      startedAt: null,
      completedAt: null,
    });
    yield* sql`UPDATE scheduled_task_runs SET snapshot_json=${yield* encodeRun(snapshot)},dispatch_status=${invalid.dispatchStatus},status=${invalid.status},thread_id=${invalid.threadId},run_id=${invalid.runId}`;
    assert.equal((yield* Effect.flip(runs.finishDispatch(finish("A"))))._tag, "ScheduledTaskError");
  }).pipe(Effect.provide(layer)),
);
