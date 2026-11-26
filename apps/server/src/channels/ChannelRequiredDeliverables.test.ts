import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelTask,
  type ChannelTaskReportInput,
  ChannelTaskEventId,
  RunId,
  ThreadId,
  requiredDeliverableRequestKey,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { remoteTaskObservationJson } from "../remoteReports/recordRemoteTaskResult.ts";
import * as ThreadResults from "../threadResults/ThreadResultService.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import { ask, current, reportFrom, sessionHarness, settle } from "./ChannelBotSession.testkit.ts";
import { readRequiredDeliverables } from "./channelDeliverables.ts";
import { owner, setupBot } from "./testkit/ChannelHarness.ts";
import { watchTaskChanges } from "./testkit/taskChanges.ts";
import { TASK_CHANGES_COALESCE } from "./channelTaskChanges.ts";

const plan = [
  { id: "mac", criterion: "Mac build produces an app" },
  { id: "linux", criterion: "Linux suite passes" },
];
const progress = (task: ChannelTask, id: string, changes: Partial<ChannelTaskReportInput>) =>
  reportFrom(task, task.worker!.runId!, {
    eventId: ChannelTaskEventId.make(id),
    milestone: false,
    ...changes,
  });
const accept = (task: ChannelTask, id: string, attempt = 1) =>
  progress(task, "accept-" + id + attempt, {
    reviewDeliverable: {
      id,
      attempt,
      decision: "accepted",
      evidence: "Verified the worker output.",
    },
  });

const parentReport = (task: ChannelTask) =>
  ThreadResults.ThreadResultService.pipe(
    Effect.flatMap((service) =>
      service.report(task.worker!.threadId, {
        runId: task.worker!.runId!,
        outcome: "succeeded",
        summary: "Both delivered.",
      }),
    ),
    Effect.provide(ThreadResults.layer),
  );

// Local task.create projects a subagent_result transfer with its source run and parent run.
// The worker's independent formal report is optional and may even belong to a different run.
const finishLocal = (
  task: ChannelTask,
  id: string,
  attempt: number,
  report: "succeeded" | "failed" | undefined,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* ChannelChildWork.ChannelChildWork;
    const worker = task.worker!;
    const key = requiredDeliverableRequestKey(id, attempt);
    const a = yield* service.admit({
      callerThreadId: worker.threadId,
      callerRunId: worker.runId,
      surface: "delegate_local",
      clientRequestId: key,
      prompt: "Verify " + id,
      destinationKey: "codex",
    });
    if (a._tag !== "admitted") return yield* Effect.die("Expected a fresh delegate");
    const child = ThreadId.make("thread-" + key);
    const run = "run-" + key;
    yield* Effect.scoped(service.claimLaunch(a.record, { threadId: child }));
    yield* service.markBound(a.record, { threadId: child });
    yield* service.markTerminal(a.record, "completed");
    yield* sql`INSERT INTO orchestration_v2_projection_subagents (subagent_id,thread_id,run_id,parent_node_id,provider,child_thread_id,origin,status,updated_at,payload_json)
    VALUES (${key},${worker.threadId},${worker.runId!},'parent','codex',${child},'app_owned','completed','now','{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
    VALUES (${run},${child},1,'codex','completed','now','{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_context_transfers (context_transfer_id,source_thread_id,target_thread_id,target_run_id,type,status,updated_at,payload_json)
    VALUES (${key},${child},${worker.threadId},${worker.runId!},'subagent_result','consumed','now',json_object('sourcePoint',json_object('runId',${run})))`;
    yield* sql`INSERT INTO thread_run_results (thread_id,run_id,report_json,reported_at)
    VALUES (${child},'unrelated-run','{"outcome":"succeeded"}','now')`;
    if (report)
      yield* sql`INSERT INTO thread_run_results (thread_id,run_id,report_json,reported_at)
    VALUES (${child},${run},json_object('outcome',${report}),'now')`;
  });
describe("GOAT Bot required worker delivery", () => {
  it.effect("announces a committed silent required-result update", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const task = yield* ask("look: verify releases", "silent-revision");
      const seen = yield* watchTaskChanges(owner);
      yield* progress(task, "declare-silent", { requiredDeliverables: plan });
      yield* TestClock.adjust(TASK_CHANGES_COALESCE);
      assert.deepStrictEqual(yield* Queue.poll(seen), Option.some(1));
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect(
    "keeps an omitted worker pending, refuses a missing report, and accepts only the current retried worker",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const task = yield* ask("look: verify releases", "release-check");
        yield* progress(task, "declare", { requiredDeliverables: plan });
        yield* progress(task, "declare", { requiredDeliverables: plan });
        const early = yield* parentReport(task).pipe(Effect.flip);
        assert.deepInclude(early, { reason: "deliverables_pending", missing: ["mac", "linux"] });
        yield* finishLocal(task, "mac", 1, "succeeded");
        yield* accept(task, "mac");
        const absent = yield* parentReport(task).pipe(Effect.flip);
        assert.deepInclude(absent, { reason: "deliverables_pending", missing: ["linux"] });
        assert.strictEqual(
          (yield* progress(task, "claim-done", { status: "completed" }).pipe(Effect.flip)).reason,
          "invalid_input",
        );
        yield* finishLocal(task, "linux", 1, undefined);
        assert.strictEqual(
          (yield* accept(task, "linux").pipe(Effect.flip)).reason,
          "invalid_input",
        );
        const sql = yield* SqlClient.SqlClient;
        const views = () =>
          current(task.taskId).pipe(Effect.flatMap((t) => readRequiredDeliverables(sql, t)));
        assert.deepStrictEqual(
          (yield* views())?.map((i) => i.state),
          ["accepted", "failed"],
        );
        const retry = { retryDeliverable: { id: "linux", attempt: 1 } };
        yield* progress(task, "retry-linux", retry);
        yield* progress(task, "retry-linux", retry);
        assert.deepStrictEqual(
          (yield* views())?.map((i) => [i.attempt, i.state]),
          [
            [1, "accepted"],
            [2, "pending"],
          ],
        );
        yield* finishLocal(task, "linux", 2, "succeeded");
        assert.strictEqual(
          (yield* accept(task, "linux", 1).pipe(Effect.flip)).reason,
          "invalid_input",
        );
        yield* accept(task, "linux", 2);
        yield* parentReport(task);
        assert.deepStrictEqual(
          (yield* views())?.map((i) => i.state),
          ["accepted", "accepted"],
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect(
    "waits for the remote terminal observation before reviewing and merges concurrent sibling decisions",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const task = yield* ask("look: verify hosts", "hosts");
        const worker = task.worker!;
        yield* progress(task, "declare", { requiredDeliverables: plan });
        yield* finishLocal(task, "mac", 1, "succeeded");
        const service = yield* ChannelChildWork.ChannelChildWork;
        const key = requiredDeliverableRequestKey("linux", 1);
        const a = yield* service.admit({
          callerThreadId: worker.threadId,
          callerRunId: worker.runId,
          surface: "delegate_remote",
          clientRequestId: key,
          prompt: "Verify Linux",
          destinationKey: "linux-host",
        });
        if (a._tag !== "admitted") return yield* Effect.die("Expected remote delegate");
        const dest = { host: "linux-host", correlationId: "linux-dispatch" };
        yield* Effect.scoped(service.claimLaunch(a.record, dest));
        yield* service.markBound(a.record, dest);
        yield* service.markTerminal(a.record, "completed");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_subagents (subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,payload_json)
        VALUES ('linux-task',${worker.threadId},${worker.runId!},'parent','codex','app_owned','completed','now','{}')`;
        yield* sql`INSERT INTO remote_dispatches (correlation_id,origin_thread_id,host,kind,read_key,delivery,state,task_id,launched_run_id,created_at,updated_at)
        VALUES ('linux-dispatch',${worker.threadId},'linux-host','task','key','wake','running','linux-task','linux-run','now','now')`;
        const views = () =>
          current(task.taskId).pipe(Effect.flatMap((t) => readRequiredDeliverables(sql, t)));
        assert.deepInclude((yield* views())?.[1], { state: "running", host: "linux-host" });
        assert.strictEqual(
          (yield* progress(task, "retry-early", {
            retryDeliverable: { id: "linux", attempt: 1 },
          }).pipe(Effect.flip)).reason,
          "invalid_input",
        );
        const observed = (id: string) =>
          remoteTaskObservationJson({
            runId: RunId.make(id),
            status: "completed",
            summary: "Done",
            reported: { outcome: "succeeded" },
          });
        yield* sql`UPDATE remote_dispatches SET state='settled', known_run_status='completed',known_run_id='linux-run',observation=${observed("other-run")} WHERE correlation_id='linux-dispatch'`;
        assert.strictEqual(
          (yield* accept(task, "linux").pipe(Effect.flip)).reason,
          "invalid_input",
        );
        yield* sql`UPDATE remote_dispatches SET observation=${observed("linux-run")} WHERE correlation_id='linux-dispatch'`;
        assert.deepInclude((yield* views())?.[1], {
          state: "awaiting_acceptance",
          host: "linux-host",
        });
        yield* Effect.all([accept(task, "mac"), accept(task, "linux")], { concurrency: 2 });
        yield* parentReport(task);
        assert.deepInclude((yield* views())?.[1], { state: "accepted", host: "linux-host" });
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect("refuses a declaration made after a formal parent result", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const task = yield* ask("look: read status", "simple");
      yield* parentReport(task);
      assert.strictEqual(
        (yield* progress(task, "late", { requiredDeliverables: plan }).pipe(Effect.flip)).reason,
        "invalid_input",
      );
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect(
    "opens one question on a missing worker and resumes the same checklist on answer",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const task = yield* ask("look: verify releases", "resume");
        yield* progress(task, "declare", { requiredDeliverables: plan });
        harness.world.setStatus(task.worker!.threadId, 1, "completed", "Done");
        yield* settle;
        yield* settle;
        const blocked = yield* current(task.taskId);
        assert.strictEqual(blocked.status, "waiting_input");
        const question = blocked.openQuestions[0]!;
        assert.include(question.text, "linux");
        yield* ask(
          "answer:" + task.taskId + " " + question.questionId + " Continue both workers",
          "answer",
        );
        const resumed = yield* current(task.taskId);
        assert.deepStrictEqual(resumed.requiredDeliverables, blocked.requiredDeliverables);
        assert.strictEqual(resumed.status, "running");
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
