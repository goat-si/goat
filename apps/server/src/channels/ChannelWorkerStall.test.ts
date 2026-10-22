import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  RuntimeRequestId,
  type ChannelReceptionInput,
  type ChannelReceptionReadResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { deliveryIdFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import {
  defaultScript,
  goatInput,
  makeHarness,
  ownerId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const STARTED = "2026-10-12T00:00:00.000Z";

const notice = (title: string) =>
  '"' +
  title +
  '" has made no progress for 20 minutes. It may be stuck: say "stop" to stop it, or keep waiting.';

const stallCause = (taskId: string, runId: string, activityAt: string) =>
  "stall:" + taskId + ":" + runId + ":" + activityAt;

/** "pending?" reads the queue; everything else is the default work script. */
const withPending = () => {
  const harness = makeHarness();
  const reads: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
  harness.script.current = (input: ChannelReceptionInput) => {
    const text = input.inputText ?? "";
    if (input.mode === "input" && text.startsWith("pending?")) {
      if (input.readsAllowed === true) {
        return Effect.succeed({
          replyText: "",
          action: { type: "read" as const, reads: [{ kind: "pending" as const, query: "all" }] },
        });
      }
      reads.push(input.readResults ?? []);
      return Effect.succeed({
        replyText: "Here it is.",
        action: { type: "report_only" as const },
      });
    }
    return defaultScript(input);
  };
  return { harness, reads };
};

const dueStalls = (owner: string) =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const due = yield* ledger.claimDueDeliveries({
      owner,
      now: DateTime.formatIso(yield* DateTime.now),
      limit: 20,
    });
    return due.filter((row) => row.message.text.includes("made no progress"));
  });

describe("GOAT Bot stalled worker runs", () => {
  it.effect(
    "stalls a quiet running run once, recovers without a notice, and notices the next quiet period",
    () => {
      const { harness, reads } = withPending();
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(STARTED));
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* gateway.ingest(goatInput("do: fix the build", "stall-1"), rpcContext);
        yield* runtime.drain;
        const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
        const threadId = task!.worker!.threadId;
        const startedAt = DateTime.makeUnsafe(STARTED);
        harness.world.activityAt.set(threadId, startedAt);
        const activityIso = DateTime.formatIso(startedAt);

        yield* TestClock.adjust(Duration.minutes(19));
        yield* reports.reconcile(runtime.ownerToken);
        let runs = yield* ledger.listWorkerRuns([task!.taskId]);
        assert.strictEqual(runs[0]!.status, "running");
        assert.deepStrictEqual(yield* dueStalls(runtime.ownerToken), []);

        // Exactly the bound is still running: stalling is strictly past it.
        yield* TestClock.adjust(Duration.minutes(1));
        yield* reports.reconcile(runtime.ownerToken);
        runs = yield* ledger.listWorkerRuns([task!.taskId]);
        assert.strictEqual(runs[0]!.status, "running");
        assert.deepStrictEqual(yield* dueStalls(runtime.ownerToken), []);

        yield* TestClock.adjust(Duration.millis(1));
        yield* reports.reconcile(runtime.ownerToken);
        runs = yield* ledger.listWorkerRuns([task!.taskId]);
        assert.strictEqual(runs[0]!.status, "stalled");
        assert.isUndefined(runs[0]!.endedAt);
        assert.strictEqual((yield* ledger.getTask(task!.taskId))!.task.status, "running");
        assert.strictEqual(
          (yield* ledger.listOpenWorkerRuns()).find((run) => run.runId === runs[0]!.runId)?.status,
          "stalled",
        );
        const cause = stallCause(task!.taskId, runs[0]!.runId, activityIso);
        assert.strictEqual(yield* ledger.getDeliveryState(deliveryIdFor(cause)), "pending");
        const [first, ...extra] = yield* dueStalls(runtime.ownerToken);
        assert.deepStrictEqual(extra, []);
        assert.strictEqual(first?.message.text, notice("fix the build"));
        assert.strictEqual(first?.message.kind, "receipt");
        assert.strictEqual(first?.deliveryId, deliveryIdFor(cause));
        // A later notice for this task waits while this one is still in flight.
        yield* ledger.recordDelivery({
          owner: runtime.ownerToken,
          deliveryId: first!.deliveryId,
          outcome: { type: "delivered" },
          now: DateTime.formatIso(yield* DateTime.now),
        });

        yield* gateway.ingest(goatInput("pending? stalled", "stall-ask"), rpcContext);
        yield* runtime.drain;
        const digest = reads.at(-1)![0]!.text;
        assert.include(digest, "fix the build [in progress]");
        assert.include(digest, "run 1: stalled, for 20 min");

        yield* reports.reconcile(runtime.ownerToken);
        assert.deepStrictEqual(yield* dueStalls(runtime.ownerToken), []);
        assert.strictEqual((yield* ledger.listWorkerRuns([task!.taskId]))[0]!.status, "stalled");

        const resumedAt = yield* DateTime.now;
        harness.world.activityAt.set(threadId, resumedAt);
        yield* reports.reconcile(runtime.ownerToken);
        runs = yield* ledger.listWorkerRuns([task!.taskId]);
        assert.strictEqual(runs[0]!.status, "running");
        assert.isUndefined(runs[0]!.endedAt);
        assert.deepStrictEqual(yield* dueStalls(runtime.ownerToken), []);

        yield* TestClock.adjust(Duration.millis(ChannelWorkerReports.STALLED_AFTER_MS + 1));
        yield* reports.reconcile(runtime.ownerToken);
        runs = yield* ledger.listWorkerRuns([task!.taskId]);
        assert.strictEqual(runs[0]!.status, "stalled");
        const againCause = stallCause(task!.taskId, runs[0]!.runId, DateTime.formatIso(resumedAt));
        assert.notStrictEqual(againCause, cause);
        assert.strictEqual(yield* ledger.getDeliveryState(deliveryIdFor(againCause)), "pending");
        const [again, ...more] = yield* dueStalls(runtime.ownerToken);
        assert.deepStrictEqual(more, []);
        assert.strictEqual(again?.message.text, notice("fix the build"));
        assert.notStrictEqual(again?.deliveryId, first?.deliveryId);
        assert.strictEqual((yield* ledger.getTask(task!.taskId))!.task.status, "running");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("keeps a run that is waiting on an approval from becoming stalled", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(STARTED));
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: fix the build", "wait-1"), rpcContext);
      yield* runtime.drain;
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      const threadId = task!.worker!.threadId;
      harness.world.activityAt.set(threadId, DateTime.makeUnsafe(STARTED));
      harness.world.runtimeRequests.set(threadId, [
        {
          id: RuntimeRequestId.make("approval:stall"),
          nodeId: NodeId.make("node:stall"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command" as const,
          status: "pending" as const,
          responseCapability: { type: "message" as const },
          createdAt: DateTime.makeUnsafe(STARTED),
          resolvedAt: null,
        },
      ]);
      yield* TestClock.adjust(Duration.millis(ChannelWorkerReports.STALLED_AFTER_MS + 60_000));
      yield* reports.reconcile(runtime.ownerToken);
      const [run] = yield* ledger.listWorkerRuns([task!.taskId]);
      assert.strictEqual(run!.status, "waiting");
      assert.isUndefined(run!.endedAt);
      assert.strictEqual((yield* ledger.getTask(task!.taskId))!.task.status, "running");
      assert.deepStrictEqual(yield* dueStalls(runtime.ownerToken), []);
      assert.strictEqual(
        (yield* ledger.listOpenWorkerRuns()).find((open) => open.runId === run!.runId)?.status,
        "waiting",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("shows an MCP requester's quiet run as stalled without notifying", () => {
    const { harness, reads } = withPending();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(STARTED));
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: fix the build", "mcp-1"), rpcContext);
      yield* runtime.drain;
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      const stored = (yield* ledger.getTask(task!.taskId))!;
      const amended = yield* commitTransition(
        ledger,
        stored,
        { type: "task.progress", payload: { generation: task!.generation, summary: "working" } },
        {
          owner: runtime.ownerToken,
          amend: (next) => ({
            ...next,
            requester: { ...next.requester, originKind: "mcp" },
          }),
        },
      );
      assert.strictEqual(amended?.requester.originKind, "mcp");
      const threadId = task!.worker!.threadId;
      const startedAt = DateTime.makeUnsafe(STARTED);
      harness.world.activityAt.set(threadId, startedAt);
      yield* TestClock.adjust(Duration.millis(ChannelWorkerReports.STALLED_AFTER_MS + 60_000));
      yield* reports.reconcile(runtime.ownerToken);
      const [run] = yield* ledger.listWorkerRuns([task!.taskId]);
      assert.strictEqual(run!.status, "stalled");
      assert.strictEqual((yield* ledger.getTask(task!.taskId))!.task.status, "running");
      const cause = stallCause(task!.taskId, run!.runId, DateTime.formatIso(startedAt));
      assert.isUndefined(yield* ledger.getDeliveryState(deliveryIdFor(cause)));
      assert.deepStrictEqual(yield* dueStalls(runtime.ownerToken), []);

      yield* gateway.ingest(goatInput("pending? mcp", "mcp-ask"), rpcContext);
      yield* runtime.drain;
      const digest = reads.at(-1)![0]!.text;
      assert.include(digest, "run 1: stalled, for 21 min");
    }).pipe(Effect.provide(harness.layer));
  });
});
