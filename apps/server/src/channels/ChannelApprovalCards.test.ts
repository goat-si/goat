import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { CHANNEL_COPY } from "./channelCopy.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import {
  botMessages,
  goatInput,
  linkSlackUser,
  makeHarness,
  onlyTask,
  ownerId,
  resultsTo,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const approval = (
  id: string,
  kind: OrchestrationV2RuntimeRequest["kind"] = "command",
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make("approval:" + id),
  nodeId: NodeId.make("node:" + id),
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: DateTime.makeUnsafe("2026-10-12T00:01:00.000Z"),
  resolvedAt: null,
});

const subagent = (childThreadId: string) =>
  ({
    childThreadId: ThreadId.make(childThreadId),
    status: "running",
    origin: "app_owned",
  }) as unknown as OrchestrationV2Subagent;

const responses = (harness: ReturnType<typeof makeHarness>) =>
  harness.world.commands.flatMap((command) =>
    command.type === "runtime-request.respond" ? [command] : [],
  );

const assistantTexts = Effect.map(botMessages, (records) =>
  records.messages.filter((message) => message.role === "assistant").map((m) => m.text),
);

describe("GOAT Bot approval cards", () => {
  it.effect("sends one card per approval and answers it from a button", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: clean the build cache", "a1"), rpcContext);
      yield* runtime.drain;
      const worker = (yield* onlyTask).worker!.threadId;
      const request = approval("rm");
      harness.world.runtimeRequests.set(worker, [request]);
      harness.world.approvalPrompts.set(request.id, "rm -rf build/");

      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      // A later pass that still sees the same approval sends nothing new.
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const cards = (yield* botMessages).messages.filter(
        (message) => message.channel?.kind === "question",
      );
      assert.strictEqual(cards.length, 1);
      assert.strictEqual(
        cards[0]?.text,
        "clean the build cache: the agent wants to run a command.\nrm -rf build/",
      );
      // Codes are issued in order per conversation and never reused.
      const code = "A1";
      assert.deepStrictEqual(cards[0]?.channel?.options, ["Approve " + code, "Deny " + code]);

      // The button sends its label, which is answered without the model.
      yield* gateway.ingest(goatInput("Approve " + code, "a2"), rpcContext);
      yield* runtime.drain;
      const [answered] = responses(harness);
      assert.strictEqual(answered?.threadId, worker);
      assert.strictEqual(answered?.requestId, request.id);
      assert.strictEqual(answered?.decision, "accept");
      assert.strictEqual(answered?.respondedBy?.type, "client");
      assert.include(yield* assistantTexts, "Approved. clean the build cache continues.");

      // Answered, the approval leaves the work. A newer approval does not inherit the old card's
      // button: pressed again, it says the approval was answered.
      yield* reports.reconcile(runtime.ownerToken);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
      harness.world.runtimeRequests.set(worker, [
        { ...request, status: "resolved" },
        approval("rm-again"),
      ]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("Approve " + code, "a3"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(responses(harness).length, 1);
      assert.strictEqual((yield* assistantTexts).at(-1), CHANNEL_COPY.approvalAlreadyAnswered);

      // A bare word answers the only open card.
      yield* gateway.ingest(goatInput("approve", "a4"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(responses(harness).length, 2);
      assert.strictEqual(responses(harness)[1]?.requestId, approval("rm-again").id);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("denies a subagent's approval in its own thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: research the options", "s1"), rpcContext);
      yield* runtime.drain;
      const worker = (yield* onlyTask).worker!.threadId;
      harness.world.subagents.set(worker, [subagent("thread:child")]);
      harness.world.runs.set("thread:child", []);
      harness.world.runtimeRequests.set("thread:child", [approval("edit", "file-change")]);

      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.include(
        yield* assistantTexts,
        "research the options: a subagent wants to change files.",
      );
      yield* gateway.ingest(goatInput("거절", "s2"), rpcContext);
      yield* runtime.drain;
      const [answered] = responses(harness);
      assert.strictEqual(answered?.threadId, ThreadId.make("thread:child"));
      assert.strictEqual(answered?.decision, "decline");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "asks which one when a bare answer fits several cards, and never matches titles",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* gateway.ingest(goatInput("do: fix login", "m1"), rpcContext);
        yield* gateway.ingest(goatInput("do: bump deps", "m2"), rpcContext);
        yield* runtime.drain;
        const tasks = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
        const login = tasks.find((task) => task.title === "fix login")!;
        const deps = tasks.find((task) => task.title === "bump deps")!;
        harness.world.runtimeRequests.set(login.worker!.threadId, [approval("login")]);
        harness.world.runtimeRequests.set(deps.worker!.threadId, [approval("deps")]);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;

        yield* gateway.ingest(goatInput("deny", "m3"), rpcContext);
        yield* runtime.drain;
        assert.strictEqual(responses(harness).length, 0);
        const ask = (yield* botMessages).messages.findLast(
          (message) => message.channel?.kind === "question",
        );
        // Asking again for an issued request returns the code its card already shows.
        const codeOf = (requestId: string) =>
          ledger.issueApprovalCode({
            conversationId: deps.conversationId,
            requestId,
            now: "2026-10-12T00:02:00.000Z",
          });
        const depsCode = yield* codeOf("approval:deps");
        const loginCode = yield* codeOf("approval:login");
        assert.sameMembers([depsCode, loginCode], ["A1", "A2"]);
        assert.include(ask?.channel?.options ?? [], "Deny " + depsCode);

        yield* gateway.ingest(goatInput("Deny " + depsCode, "m4"), rpcContext);
        yield* runtime.drain;
        const [answered] = responses(harness);
        assert.strictEqual(answered?.threadId, deps.worker!.threadId);
        assert.strictEqual(answered?.decision, "decline");
        // Words that happen to match a title are conversation, not an approval.
        yield* gateway.ingest(goatInput("approve the fix login PR", "m5"), rpcContext);
        yield* runtime.drain;
        assert.strictEqual(responses(harness).length, 1);
        // A code no card was issued under is conversation too.
        yield* gateway.ingest(goatInput("approve A9", "m6"), rpcContext);
        yield* runtime.drain;
        assert.strictEqual(responses(harness).length, 1);
        yield* gateway.ingest(goatInput("approve " + loginCode.toLowerCase(), "m7"), rpcContext);
        yield* runtime.drain;
        assert.strictEqual(responses(harness)[1]?.threadId, login.worker!.threadId);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("keeps an old approval answerable behind newer work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: first thing", "o0"), rpcContext);
      yield* runtime.drain;
      const first = yield* onlyTask;
      harness.world.runtimeRequests.set(first.worker!.threadId, [approval("first")]);
      yield* reports.reconcile(runtime.ownerToken);
      for (let index = 1; index <= 21; index += 1) {
        yield* TestClock.adjust("1 second");
        yield* gateway.ingest(goatInput("do: later thing " + index, "o" + index), rpcContext);
      }
      yield* runtime.drain;
      const recent = yield* ledger.listConversationTasks(first.conversationId);
      assert.isFalse(recent.some((task) => task.taskId === first.taskId));
      yield* gateway.ingest(goatInput("approve", "o-answer"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(responses(harness)[0]?.threadId, first.worker!.threadId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lists the choices on Slack and refuses a person whose link was removed", () => {
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
      const worker = (yield* onlyTask).worker!.threadId;
      harness.world.runtimeRequests.set(worker, [approval("deploy")]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const card = resultsTo(harness.slackSent, "question")[0];
      assert.strictEqual(
        card?.message.text,
        "deploy staging: the agent wants to run a command.\n1. Approve A1\n2. Deny A1",
      );

      yield* identities.unlink({ connectionId: "slack-1", externalActorId: "U1" });
      yield* gateway.ingest(slackInput("approve", "Ev2"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(responses(harness).length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("drops a card answered elsewhere and says when an answer cannot be passed on", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: tidy logs", "r1"), rpcContext);
      yield* runtime.drain;
      const worker = (yield* onlyTask).worker!.threadId;
      const request = approval("tidy");
      harness.world.runtimeRequests.set(worker, [request]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      // The thread refuses the answer: the card stays open and the person hears so.
      harness.world.dispatchFailures.add(worker);
      yield* gateway.ingest(goatInput("approve", "r2"), rpcContext);
      yield* runtime.drain;
      assert.include(yield* assistantTexts, CHANNEL_COPY.approvalFailed);
      harness.world.dispatchFailures.delete(worker);

      // Someone answered in the thread: the bot's next pass drops the card, so "approve" is
      // ordinary conversation again.
      harness.world.runtimeRequests.set(worker, [{ ...request, status: "resolved" }]);
      yield* gateway.ingest(goatInput("approve", "r3"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(responses(harness).length, 0);
      assert.strictEqual((yield* assistantTexts).at(-1), "Okay.");
    }).pipe(Effect.provide(harness.layer));
  });
});
