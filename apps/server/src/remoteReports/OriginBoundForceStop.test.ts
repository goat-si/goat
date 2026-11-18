// @effect-diagnostics nodeBuiltinImport:off - the binding stores the read key's sha256, as launch does.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  interruptResult,
  runCauses,
  runStatuses,
  stopRequested,
} from "../orchestration-v2/delegatedForceStop.testkit.ts";
import { createWatchingThread, layerTest, send } from "../orchestration-v2/ThreadStop.testkit.ts";
import { originBoundForceStop } from "./OriginBoundForceStop.ts";

const readKey = "ab".repeat(32);
const limits = { runtimeMode: "full-access", interactionMode: "default" } as const;

/** A thread another machine launched as a task, bound for reports, mid-run with a Stop sent. */
const boundThread = (name: string, unanswered: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* createWatchingThread(threadId, 50);
    yield* send(threadId, "remote task", "start_immediately");
    yield* stopRequested(threadId, unanswered);
    const runId = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
    const correlationId = `correlation:${name}`;
    const hash = NodeCrypto.createHash("sha256").update(readKey, "utf8").digest("hex");
    yield* sql`INSERT INTO remote_report_bindings (thread_id, correlation_id, origin_label, origin_thread_id, read_key_hash, created_at)
      VALUES (${threadId}, ${correlationId}, 'origin-mac', 'thread:origin-parent', ${hash}, '2026-11-16T00:00:00.000Z')`;
    return { threadId, runId, correlationId, readKey };
  });

it.effect(
  "the origin's force stop through its binding ends the bound thread's unanswered run",
  () =>
    Effect.gen(function* () {
      const bound = yield* boundThread("origin-force-ok", true);
      const result = yield* originBoundForceStop(bound, limits);
      assert.deepEqual(result, { outcome: "released", sharedWithThreadIds: [] });
      assert.deepEqual(yield* runStatuses(bound.threadId), ["interrupted"]);
      assert.deepEqual(yield* runCauses(bound.threadId), ["agent_stop"]);
      assert.equal(
        yield* interruptResult(bound.threadId),
        "Force stopped by its origin task owner on origin-mac",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("another read key, thread or run, or a Stop not yet unanswered, stops nothing", () =>
  Effect.gen(function* () {
    const bound = yield* boundThread("origin-force-refused", true);
    const early = yield* boundThread("origin-force-early", false);
    const refusals = yield* Effect.forEach(
      [
        { ...bound, readKey: "cd".repeat(32) },
        { ...bound, threadId: early.threadId },
        { ...bound, runId: RunId.make("run:not-the-live-one") },
        early,
      ],
      (input) =>
        originBoundForceStop(input, limits).pipe(
          Effect.flip,
          Effect.map((error) => `${error.code} ${error.message.split(":")[0]}`),
        ),
    );
    assert.deepEqual(refusals, [
      "thread_not_found This read key is not bound to that thread.",
      "thread_not_found This read key is not bound to that thread.",
      "task_not_cancellable superseded",
      "task_not_cancellable not_unresponsive",
    ]);
    assert.deepEqual(yield* runStatuses(bound.threadId), ["running"]);
    assert.deepEqual(yield* runStatuses(early.threadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a session ceiling below the bound thread's mode refuses before anything stops", () =>
  Effect.gen(function* () {
    const bound = yield* boundThread("origin-force-ceiling", true);
    const error = yield* originBoundForceStop(bound, {
      ...limits,
      runtimeMode: "approval-required",
    }).pipe(Effect.flip);
    assert.equal(error.code, "runtime_mode_escalation_denied");
    assert.deepEqual(yield* runStatuses(bound.threadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);
