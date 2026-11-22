import { assert, it } from "@effect/vitest";
import { BotId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  linkSlackUser,
  makeHarness,
  onlyTask,
  owner,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

it.effect("a restricted bot refuses local launches and stops a live worker on narrowing", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const members = yield* ChannelBotMembers.ChannelBotMembers;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const botId = BotId.make("main");
    const tools = { mcpServers: [], skills: "all" } as const;
    const [before] = yield* members.list({}, owner);
    assert.isUndefined(before?.tools);
    yield* gateway.ingest(slackInput("do: inspect the build", "tools-before"), slackContext);
    yield* runtime.drain;
    const active = yield* onlyTask;
    assert.strictEqual(active.status, "running");
    yield* members.update({ botId, name: "Scout", tools }, owner);
    yield* runtime.drain;
    const stopped = (yield* ledger.getTask(active.taskId))?.task;
    assert.strictEqual(stopped?.status, "cancelled");
    assert.strictEqual(stopped?.resultSummary, "Stopped: Scout's tools changed");
    assert.include(harness.world.interrupts, active.worker!.threadId);
    const childWork = yield* ChannelChildWork.ChannelChildWork;
    const delegated = yield* childWork
      .admit({
        callerThreadId: active.worker!.threadId,
        surface: "thread_launch",
        prompt: "watch the deploy",
        destinationKey: "codex/gpt-6.1-sol",
      })
      .pipe(Effect.flip);
    assert.strictEqual(delegated.detail, "Scout's tool limits can't be applied on delegated work.");

    const renamed = yield* members.update({ botId, purpose: "Check builds" }, owner);
    assert.deepStrictEqual(renamed.tools, tools);
    yield* gateway.ingest(slackInput("do: inspect another build", "tools-after"), slackContext);
    yield* runtime.drain;
    const { tasks } = yield* ledger.listTasks({ ownerId: owner.ownerId, limit: 10 });
    const refused = tasks.find((task) => task.taskId !== active.taskId);
    assert.strictEqual(refused?.status, "failed");
    assert.include(refused?.resultSummary ?? "", "Scout's tool limits can't be applied");
    assert.isUndefined(refused?.worker);
  }).pipe(Effect.provide(harness.layer));
});
