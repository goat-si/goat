import { assert, describe, it } from "@effect/vitest";
import { NodeId, type OrchestrationV2RuntimeRequest, RuntimeRequestId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import {
  linkSlackUser,
  makeHarness,
  owner,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const approval = (id: string): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make("approval:" + id),
  nodeId: NodeId.make("node:" + id),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: DateTime.makeUnsafe("2026-10-12T00:01:00.000Z"),
  resolvedAt: null,
});

const stranger = { ...owner, ownerId: "environment:stranger" };

describe("open asks across bots", () => {
  it.effect("lists a task's open question with its words, for its owner only", () => {
    const harness = makeHarness({ projects: 2 });
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      assert.deepStrictEqual(yield* members.openAsks(owner), []);
      yield* gateway.ingest(slackInput("do: which repo?", "Ev-q"), slackContext);
      yield* runtime.drain;
      const asks = yield* members.openAsks(owner);
      assert.deepStrictEqual(
        asks.map((ask) => [ask.kind, ask.botId]),
        [["question", "main"]],
      );
      assert.isAbove(asks[0]?.text.length ?? 0, 0);
      assert.isDefined(asks[0]?.questionId);
      assert.deepStrictEqual(yield* members.openAsks(stranger), []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("words each approval as its card does, newest first", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const ask = (text: string, key: string, request: OrchestrationV2RuntimeRequest) =>
        Effect.gen(function* () {
          yield* gateway.ingest(slackInput(text, key), slackContext);
          yield* runtime.drain;
          const tasks = (yield* ledger.listTasks({ ownerId: owner.ownerId, limit: 10 })).tasks;
          const task = tasks.find((each) => text.includes(each.title));
          harness.world.runtimeRequests.set(task!.worker!.threadId, [request]);
          yield* reports.reconcile(runtime.ownerToken);
          yield* runtime.drain;
        });
      yield* ask("do: deploy staging", "Ev-1", approval("deploy"));
      yield* TestClock.adjust("1 minute");
      yield* ask("do: drop the cache", "Ev-2", approval("cache"));
      const asks = yield* members.openAsks(owner);
      assert.deepStrictEqual(
        asks.map((each) => [each.kind, each.requestId]),
        [
          ["approval", "approval:cache"],
          ["approval", "approval:deploy"],
        ],
      );
      assert.strictEqual(asks[1]?.text, "deploy staging: the agent wants to run a command.");
    }).pipe(Effect.provide(harness.layer));
  });
});
