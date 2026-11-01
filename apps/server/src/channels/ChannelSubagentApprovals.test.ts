import { assert, describe, it } from "@effect/vitest";
import { NodeId, type OrchestrationV2Subagent, RuntimeRequestId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import {
  goatInput,
  makeHarness,
  onlyTask,
  ownerId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const since = "2026-10-12T00:01:00.000Z";
const approval = (id: string) => ({
  id: RuntimeRequestId.make("approval:" + id),
  nodeId: NodeId.make("node:" + id),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command" as const,
  status: "pending" as const,
  responseCapability: { type: "message" as const },
  createdAt: DateTime.makeUnsafe(since),
  resolvedAt: null,
});

const subagent = (childThreadId: string, status: OrchestrationV2Subagent["status"]) =>
  ({ childThreadId: ThreadId.make(childThreadId), status, origin: "app_owned" }) as never;

describe("GOAT Bot sees approvals its workers' subagents wait on", () => {
  it.effect("counts a nested subagent's pending approval, and only a live subagent's", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: research the options", "a1"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      const worker = task.worker!.threadId;
      // The worker started a research subagent, which started its own; that one waits.
      harness.world.subagents.set(worker, [
        subagent("thread:child", "running"),
        subagent("thread:done-child", "completed"),
      ]);
      harness.world.subagents.set("thread:child", [subagent("thread:grandchild", "waiting")]);
      harness.world.runs.set("thread:child", []);
      harness.world.runs.set("thread:grandchild", []);
      harness.world.runs.set("thread:done-child", []);
      harness.world.runtimeRequests.set("thread:grandchild", [approval("grandchild")]);
      // A finished subagent's leftover request does not count.
      harness.world.runtimeRequests.set("thread:done-child", [approval("done-child")]);

      yield* reports.reconcile(runtime.ownerToken);
      const waiting = yield* onlyTask;
      assert.strictEqual(waiting.status, "running");
      assert.deepStrictEqual(waiting.observed?.needsYou, [
        {
          kind: "approval",
          since,
          approval: {
            requestId: RuntimeRequestId.make("approval:grandchild"),
            threadId: ThreadId.make("thread:grandchild"),
          },
        },
      ]);
      assert.strictEqual(yield* ledger.countWaitingTasks(ownerId), 1);

      harness.world.runtimeRequests.set("thread:grandchild", []);
      yield* reports.reconcile(runtime.ownerToken);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
    }).pipe(Effect.provide(harness.layer));
  });
});
