import { assert, describe, it } from "@effect/vitest";
import {
  ChannelChildWorkId,
  type ChannelTaskNeedsYou,
  NodeId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ChildStore from "./channelChildWorkStore.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import {
  goatInput,
  linkSlackUser,
  makeHarness,
  onlyTask,
  ownerId,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const since = "2026-10-12T00:01:00.000Z";
const request = (
  id: string,
  kind: OrchestrationV2RuntimeRequest["kind"],
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make("request:" + id),
  nodeId: NodeId.make("node:" + id),
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: DateTime.makeUnsafe(since),
  resolvedAt: null,
});

const responses = (harness: ReturnType<typeof makeHarness>) =>
  harness.world.commands.flatMap((command) =>
    command.type === "runtime-request.respond" ? [command] : [],
  );

/** A coding thread the task launched, recorded as child work in the given state. */
const launch = Effect.fn(function* (
  task: { readonly taskId: string; readonly generation: number },
  id: string,
  state: "bound" | "completed",
  generation = task.generation,
) {
  yield* (yield* ChildStore.ChannelChildWorkStore).admitReserved(
    {
      ownerId,
      taskId: task.taskId as never,
      childWorkId: ChannelChildWorkId.make(id),
      generation,
      callerThreadId: ThreadId.make("thread:caller"),
      requestKey: id,
      promptDigest: "digest",
      surface: "thread_launch",
      destination: { threadId: ThreadId.make("thread:" + id) },
      state,
      createdAt: since,
      updatedAt: since,
    },
    100,
  );
});

describe("GOAT Bot sees what the coding threads a task launched wait on", () => {
  it.effect(
    "adds a live launched thread's question and approval once, and drops them when answered",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* gateway.ingest(goatInput("do: start the build", "c1"), rpcContext);
        yield* runtime.drain;
        const task = yield* onlyTask;
        yield* launch(task, "live", "bound");
        yield* launch(task, "done", "completed");
        yield* launch(task, "stale", "bound", task.generation + 1);
        for (const id of ["live", "done", "stale"]) harness.world.runs.set("thread:" + id, []);
        harness.world.runtimeRequests.set("thread:live", [
          request("question", "user_input"),
          request("approval", "command"),
        ]);
        harness.world.runtimeRequests.set("thread:done", [request("old", "command")]);
        harness.world.runtimeRequests.set("thread:stale", [request("stale", "user_input")]);
        const expected: ReadonlyArray<ChannelTaskNeedsYou> = [
          {
            kind: "approval",
            since,
            approval: {
              requestId: RuntimeRequestId.make("request:approval"),
              threadId: ThreadId.make("thread:live"),
            },
          },
          { kind: "question", since },
        ];
        yield* reports.reconcile(runtime.ownerToken);
        assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, expected);
        assert.strictEqual(yield* ledger.countWaitingTasks(ownerId), 1);

        // The same thread can also be the worker's subagent; each request still counts once.
        harness.world.subagents.set(task.worker!.threadId, [
          {
            childThreadId: ThreadId.make("thread:live"),
            status: "running",
            origin: "app_owned",
          } as unknown as OrchestrationV2Subagent,
        ]);
        yield* reports.reconcile(runtime.ownerToken);
        assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, expected);

        harness.world.runtimeRequests.set("thread:live", []);
        yield* reports.reconcile(runtime.ownerToken);
        assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "lets the person answer a launched thread's approval, and refuses someone unlinked",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        const identities = yield* ChannelIdentityService.ChannelIdentityService;
        yield* gateway.ingest(slackInput("do: deploy staging", "Ev1"), slackContext);
        yield* runtime.drain;
        const task = yield* onlyTask;
        yield* launch(task, "deploy", "bound");
        harness.world.runs.set("thread:deploy", []);
        harness.world.runtimeRequests.set("thread:deploy", [request("run", "command")]);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;

        yield* gateway.ingest(slackInput("deny", "Ev2"), slackContext);
        yield* runtime.drain;
        const [answered] = responses(harness);
        assert.strictEqual(answered?.threadId, ThreadId.make("thread:deploy"));
        assert.strictEqual(answered?.decision, "decline");

        harness.world.runtimeRequests.set("thread:deploy", [request("again", "command")]);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        yield* identities.unlink({ connectionId: "slack-1", externalActorId: "U1" });
        yield* gateway.ingest(slackInput("approve", "Ev3"), slackContext);
        yield* runtime.drain;
        assert.strictEqual(responses(harness).length, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
