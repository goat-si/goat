import { assert, describe, it } from "@effect/vitest";
import {
  ChannelChildWorkId,
  type ChannelReceptionInput,
  type ChannelTaskNeedsYou,
  ChannelQuestionId,
  NodeId,
  ProviderInstanceId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as ChildStore from "./channelChildWorkStore.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { receptionDecisionChannels } from "./testkit/channelReceptionHarness.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  owner,
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

const cards = Effect.map(
  botMessages,
  (records) => records.messages.filter((message) => message.channel?.kind === "question").length,
);

/** Links a Slack user with the given ceiling and scopes, as a person would with a code. */
const linkSlackPerson = (
  user: string,
  runtimeModeCeiling: "approval-required" | "auto-accept-edits",
  grantedScopes: ReadonlyArray<"orchestration:read" | "orchestration:operate">,
) =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const { code } = yield* identities.createLink(
      { connectionId: "slack-1", runtimeModeCeiling, grantedScopes: [...grantedScopes] },
      owner,
    );
    yield* gateway.linkIdentity(
      {
        connectionId: "slack-1",
        externalActorId: user,
        code,
        idempotencyKey: "link-" + user,
        replyAddress: {
          kind: "slack",
          connectionId: "slack-1",
          teamId: "T1",
          channelId: "D1",
          rootTs: "1",
        },
      },
      slackContext,
    );
  });

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
          {
            kind: "question",
            since,
            question: {
              requestId: RuntimeRequestId.make("request:question"),
              threadId: ThreadId.make("thread:live"),
            },
          },
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
    "keeps a launched thread's approval through a failed read and sends its card once",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(goatInput("do: start the build", "c1"), rpcContext);
        yield* runtime.drain;
        const task = yield* onlyTask;
        yield* launch(task, "live", "bound");
        // A launched thread that was deleted asks nothing and does not hold the pass.
        yield* launch(task, "deleted", "bound");
        harness.world.runs.set("thread:live", []);
        harness.world.runtimeRequests.set("thread:live", [request("approval", "command")]);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        const seen = (yield* onlyTask).observed?.needsYou;
        assert.strictEqual(seen?.length, 1);
        assert.strictEqual(yield* cards, 1);

        harness.world.recordFailures.add("thread:live");
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, seen);

        harness.world.recordFailures.delete("thread:live");
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, seen);
        assert.strictEqual(yield* cards, 1);
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

        yield* gateway.ingest(slackInput("deny A1", "Ev2"), slackContext);
        yield* runtime.drain;
        const [answered] = responses(harness);
        assert.strictEqual(answered?.threadId, ThreadId.make("thread:deploy"));
        assert.strictEqual(answered?.decision, "decline");

        harness.world.runtimeRequests.set("thread:deploy", [request("again", "command")]);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        yield* identities.unlink({ connectionId: "slack-1", externalActorId: "U1" });
        yield* gateway.ingest(slackInput("approve A2", "Ev3"), slackContext);
        yield* runtime.drain;
        assert.strictEqual(responses(harness).length, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "refuses a launched thread's approval from a lower ceiling, a read-only link and a stranger",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        yield* linkSlackPerson("U2", "approval-required", [
          "orchestration:read",
          "orchestration:operate",
        ]);
        yield* linkSlackPerson("U3", "auto-accept-edits", ["orchestration:read"]);
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(slackInput("do: deploy staging", "Ev1"), slackContext);
        yield* runtime.drain;
        const task = yield* onlyTask;
        yield* launch(task, "deploy", "bound");
        harness.world.runs.set("thread:deploy", []);
        harness.world.runtimeRequests.set("thread:deploy", [request("run", "command")]);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;

        const root = "1760000000.000100";
        yield* gateway.ingest(slackInput("approve A1", "Ev2", root, "U2"), slackContext);
        yield* gateway.ingest(slackInput("approve A1", "Ev3", root, "U3"), slackContext);
        yield* gateway.ingest(slackInput("approve A1", "Ev4", root, "U9"), slackContext);
        yield* runtime.drain;
        assert.strictEqual(responses(harness).length, 0);

        yield* gateway.ingest(slackInput("approve A1", "Ev5", root, "U1"), slackContext);
        yield* runtime.drain;
        const [answered] = responses(harness);
        assert.strictEqual(answered?.threadId, ThreadId.make("thread:deploy"));
        assert.strictEqual(answered?.decision, "accept");
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("GOAT Bot hears about a launched thread's approvals after its task ended", () => {
  /** One request, its worker run finished, with a launched coding thread that has ended too. */
  const finishedWithLaunch = (harness: ReturnType<typeof makeHarness>) =>
    Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: write the release notes", "late1"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* launch(task, "late", "completed");
      harness.world.runs.set("thread:late", []);
      harness.world.setStatus(task.worker!.threadId, 1, "completed", "Started the notes thread.");
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "completed");
      return { runtime, reports };
    });

  it.effect("shows an approval the launched thread asks for after the task finished", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { runtime, reports } = yield* finishedWithLaunch(harness);
      const cardsBefore = yield* cards;
      harness.world.runtimeRequests.set("thread:late", [request("write", "file-change")]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const task = yield* onlyTask;
      assert.strictEqual(task.status, "completed");
      assert.deepStrictEqual(task.observed?.needsYou, [
        {
          kind: "approval",
          since,
          approval: {
            requestId: RuntimeRequestId.make("request:write"),
            threadId: ThreadId.make("thread:late"),
          },
        },
      ]);
      assert.strictEqual(yield* cards, cardsBefore + 1);
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.strictEqual(yield* ledger.countWaitingTasks(ownerId), 1);
      // Another pass with nothing new writes nothing.
      const version = task.version;
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* onlyTask).version, version);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("tells the chat once when the approval is declined in the launched thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { runtime, reports } = yield* finishedWithLaunch(harness);
      harness.world.runtimeRequests.set("thread:late", [request("write", "file-change")]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      harness.world.runtimeRequests.set("thread:late", [
        {
          ...request("write", "file-change"),
          status: "resolved",
          decision: "decline",
          respondedBy: { type: "user" },
        },
      ]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const told = (yield* botMessages).messages.filter((message) =>
        message.text.includes("Denied in the coding thread"),
      );
      assert.strictEqual(told.length, 1);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not tell the chat twice about an approval it answered itself", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { runtime, reports } = yield* finishedWithLaunch(harness);
      harness.world.runtimeRequests.set("thread:late", [request("write", "file-change")]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("deny A1", "late-deny"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(responses(harness)[0]?.decision, "decline");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.isTrue(texts.some((text) => text.startsWith("Denied.")));
      assert.isFalse(texts.some((text) => text.includes("Denied in the coding thread")));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "tells the chat once when a running task's launched thread declines an approval",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(goatInput("do: start the build", "run-decline"), rpcContext);
        yield* runtime.drain;
        const task = yield* onlyTask;
        yield* launch(task, "live", "bound");
        harness.world.runs.set("thread:live", []);
        harness.world.runtimeRequests.set("thread:live", [request("write", "file-change")]);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        harness.world.runtimeRequests.set("thread:live", [
          {
            ...request("write", "file-change"),
            status: "resolved",
            decision: "decline",
            respondedBy: { type: "user" },
          },
        ]);
        // The thread's turn ended with the decision, so its child work is no longer live.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_runtime_state SET value_json = json_set(value_json, '$.state', 'completed') WHERE key >= 'child-work:' AND key < 'child-work;'`;
        yield* reports.reconcile(runtime.ownerToken);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        const told = (yield* botMessages).messages.filter((message) =>
          message.text.includes("Denied in the coding thread"),
        );
        assert.strictEqual(told.length, 1);
        assert.strictEqual((yield* onlyTask).status, "running");
        assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("GOAT Bot keeps a launched thread's approval until the thread says what happened", () => {
  /** A running task whose launched thread showed an approval, then ended its turn. */
  const shownThenEnded = (harness: ReturnType<typeof makeHarness>, key: string) =>
    Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: start the build", key), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* launch(task, "live", "bound");
      harness.world.runs.set("thread:live", []);
      harness.world.runtimeRequests.set("thread:live", [request("write", "file-change")]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_runtime_state SET value_json = json_set(value_json, '$.state', 'completed') WHERE key >= 'child-work:' AND key < 'child-work;'`;
      return { runtime, reports, shown: (yield* onlyTask).observed?.needsYou };
    });

  const told = (text: string) =>
    Effect.map(
      botMessages,
      (records) => records.messages.filter((message) => message.text.includes(text)).length,
    );

  it.effect("keeps the approval through a failed read and reports the decision after", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { runtime, reports, shown } = yield* shownThenEnded(harness, "kept-read");
      harness.world.recordFailures.add("thread:live");
      yield* reports.reconcile(runtime.ownerToken);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, shown);
      harness.world.recordFailures.delete("thread:live");
      yield* reports.reconcile(runtime.ownerToken);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, shown);
      harness.world.runtimeRequests.set("thread:live", [
        { ...request("write", "file-change"), status: "resolved", decision: "accept" },
      ]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.strictEqual(yield* told("Approved in the coding thread"), 1);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("says once that an approval expired before anyone answered it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { runtime, reports } = yield* shownThenEnded(harness, "expired");
      harness.world.runtimeRequests.set("thread:live", [
        { ...request("write", "file-change"), status: "expired" },
      ]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.strictEqual(yield* told("expired before anyone answered it"), 1);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lets the task finish while an ended thread's approval still waits", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { runtime, reports, shown } = yield* shownThenEnded(harness, "finish-waiting");
      const task = yield* onlyTask;
      harness.world.setStatus(task.worker!.threadId, 1, "completed", "Started the build.");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const finished = yield* onlyTask;
      assert.strictEqual(finished.status, "completed");
      assert.deepStrictEqual(finished.observed?.needsYou, shown);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("records the worker run as waiting while an ended thread's approval waits", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const startedAt = DateTime.makeUnsafe("2026-10-12T00:00:00.000Z");
      yield* TestClock.setTime(DateTime.toEpochMillis(startedAt));
      const { runtime, reports } = yield* shownThenEnded(harness, "kept-waiting");
      const task = yield* onlyTask;
      harness.world.activityAt.set(task.worker!.threadId, startedAt);
      yield* TestClock.adjust(Duration.millis(ChannelWorkerReports.STALLED_AFTER_MS + 1));
      yield* reports.reconcile(runtime.ownerToken);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const [run] = yield* ledger.listWorkerRuns([task.taskId]);
      assert.strictEqual(run?.status, "waiting");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("answers a launched thread single-choice question from the bot chat", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const sql = yield* SqlClient.SqlClient;
      yield* gateway.ingest(goatInput("do: start the build", "nq1"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* launch(task, "live", "bound");
      harness.world.runs.set("thread:live", []);
      const pending = request("pick", "user_input");
      harness.world.runtimeRequests.set("thread:live", [pending]);
      harness.world.userInputQuestions.set(pending.id, [
        {
          id: "cache",
          header: "Cache",
          question: "Which cache should the build use?",
          options: [
            { label: "Keep it", description: "Reuse the cache" },
            { label: "Clear it", description: "Start fresh" },
          ],
        },
      ]);
      yield* reports.reconcile(runtime.ownerToken);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, [
        {
          kind: "question",
          since,
          question: {
            requestId: pending.id,
            threadId: ThreadId.make("thread:live"),
          },
        },
      ]);
      yield* runtime.drain;
      const cards = (yield* botMessages).messages.filter(
        (message) => message.channel?.kind === "question",
      );
      assert.strictEqual(cards.length, 1);
      assert.strictEqual(cards[0]?.channel?.questionId, ChannelQuestionId.make(pending.id));
      assert.strictEqual(cards[0]?.channel?.taskId, task.taskId);
      assert.deepStrictEqual(cards[0]?.channel?.options, ["Keep it", "Clear it"]);
      assert.include(cards[0]?.text ?? "", "Which cache should the build use?");

      yield* gateway.ingest({ ...goatInput("Keep it", "nq2"), taskId: task.taskId }, rpcContext);
      yield* runtime.drain;
      const [answered] = responses(harness);
      assert.strictEqual(answered?.threadId, ThreadId.make("thread:live"));
      assert.strictEqual(answered?.requestId, pending.id);
      assert.deepStrictEqual(answered?.answers, { cache: "Keep it" });
      assert.strictEqual(answered?.decision, undefined);
      assert.strictEqual(answered?.respondedBy?.type, "client");
      assert.strictEqual(
        answered?.respondedBy && "label" in answered.respondedBy
          ? answered.respondedBy.label
          : undefined,
        "GOAT Bot",
      );
      const followups = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM channel_task_events WHERE task_id = ${task.taskId} AND type = 'task.followup.received'`;
      assert.strictEqual(followups[0]?.count, 0);
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.ok(texts.some((text) => text.includes("Sent your answer to ")));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a completed launch's pending question until the request resolves", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: start the build", "done-q"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* launch(task, "live", "completed");
      harness.world.runs.set("thread:live", []);
      const pending = request("pick", "user_input");
      harness.world.runtimeRequests.set("thread:live", [pending]);
      harness.world.userInputQuestions.set(pending.id, [
        {
          id: "file",
          header: "File",
          question: "Which file?",
          options: [
            { label: "c.txt", description: "C" },
            { label: "d.txt", description: "D" },
          ],
        },
      ]);
      yield* reports.reconcile(runtime.ownerToken);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, [
        {
          kind: "question",
          since,
          question: {
            requestId: pending.id,
            threadId: ThreadId.make("thread:live"),
          },
        },
      ]);
      yield* runtime.drain;
      const cards = (yield* botMessages).messages.filter(
        (message) => message.channel?.questionId === ChannelQuestionId.make(pending.id),
      );
      assert.strictEqual(cards.length, 1);
      assert.deepStrictEqual(cards[0]?.channel?.options, ["c.txt", "d.txt"]);
      yield* gateway.ingest({ ...goatInput("d.txt", "done-a"), taskId: task.taskId }, rpcContext);
      yield* runtime.drain;
      const [answered] = responses(harness);
      assert.deepStrictEqual(answered?.answers, { file: "d.txt" });
      yield* reports.reconcile(runtime.ownerToken);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("answers a turn's launched question from the bot chat as the question alone", () => {
    const harness = makeHarness({
      botWorkspace: true,
      channelsLayer: receptionDecisionChannels,
      settingsLayer: ServerSettings.layerTest({
        textGenerationModelSelection: modelSelection,
        defaultRuntimeMode: "full-access",
        goatBotModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6-luna",
        },
      }).pipe(Layer.orDie),
    });
    harness.script.current = (input: ChannelReceptionInput) => {
      const text = input.inputText ?? "";
      if (input.mode === "input" && text.startsWith("look:")) {
        const instruction = text.slice("look:".length).trim();
        return Effect.succeed({
          replyText: "On it.",
          action: { type: "run_turn" as const, title: instruction, instruction },
        });
      }
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const sql = yield* SqlClient.SqlClient;
      yield* gateway.ingest(goatInput("look: which file should I change?", "turn-q"), rpcContext);
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      const task = yield* onlyTask;
      assert.strictEqual(task.kind, "turn");
      yield* launch(task, "live", "bound");
      harness.world.runs.set("thread:live", []);
      const pending = request("pick", "user_input");
      harness.world.runtimeRequests.set("thread:live", [pending]);
      harness.world.userInputQuestions.set(pending.id, [
        {
          id: "file",
          header: "File",
          question: "Which file?",
          options: [
            { label: "c.txt", description: "C" },
            { label: "d.txt", description: "D" },
          ],
        },
      ]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const cards = (yield* botMessages).messages.filter(
        (message) => message.channel?.kind === "question",
      );
      assert.strictEqual(cards.length, 1);
      assert.strictEqual(cards[0]?.text, "Which file?");
      assert.strictEqual(cards[0]?.channel?.questionId, ChannelQuestionId.make(pending.id));
      assert.strictEqual(cards[0]?.channel?.taskId, task.taskId);
      assert.deepStrictEqual(cards[0]?.channel?.options, ["c.txt", "d.txt"]);
      yield* gateway.ingest({ ...goatInput("d.txt", "turn-a"), taskId: task.taskId }, rpcContext);
      yield* runtime.drain;
      const [answered] = responses(harness);
      assert.deepStrictEqual(answered?.answers, { file: "d.txt" });
      assert.strictEqual(answered?.decision, undefined);
      const followups = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM channel_task_events WHERE task_id = ${task.taskId} AND type = 'task.followup.received'`;
      assert.strictEqual(followups[0]?.count, 0);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("tells Slack to open the work thread instead of sending a native-question card", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(slackInput("do: start the build", "sq1"), slackContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* launch(task, "live", "bound");
      harness.world.runs.set("thread:live", []);
      const pending = request("slack", "user_input");
      harness.world.runtimeRequests.set("thread:live", [pending]);
      harness.world.userInputQuestions.set(pending.id, [
        {
          id: "file",
          header: "File",
          question: "Which file?",
          options: [
            { label: "c.txt", description: "C" },
            { label: "d.txt", description: "D" },
          ],
        },
      ]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const asking = harness.slackSent.filter((send) =>
        send.message.text.includes("is asking something in its coding thread"),
      );
      assert.strictEqual(asking.length, 1);
      assert.strictEqual(
        asking[0]?.message.text,
        task.title + " is asking something in its coding thread. Open the work thread to answer.",
      );
      assert.strictEqual(asking[0]?.message.options, undefined);
      assert.strictEqual(asking[0]?.message.questionId, undefined);
      assert.strictEqual(asking[0]?.message.taskId, undefined);
      assert.strictEqual(
        harness.slackSent.some(
          (send) => send.message.questionId === ChannelQuestionId.make(pending.id),
        ),
        false,
      );
      yield* gateway.ingest(slackInput("c.txt", "sq2"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(responses(harness).length, 0);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("sends one untagged line when a launched thread asks more than one question", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: start the build", "mq1"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* launch(task, "live", "bound");
      harness.world.runs.set("thread:live", []);
      const pending = request("many", "user_input");
      harness.world.runtimeRequests.set("thread:live", [pending]);
      harness.world.userInputQuestions.set(pending.id, [
        {
          id: "one",
          header: "One",
          question: "First?",
          options: [{ label: "A", description: "A" }],
        },
        {
          id: "two",
          header: "Two",
          question: "Second?",
          options: [{ label: "B", description: "B" }],
        },
      ]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const lines = (yield* botMessages).messages.filter((message) =>
        message.text.includes("is asking something in its coding thread"),
      );
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0]?.channel?.taskId, undefined);
      assert.strictEqual(
        lines[0]?.text,
        task.title + " is asking something in its coding thread. Open the work thread to answer.",
      );
      assert.strictEqual(
        (yield* botMessages).messages.filter(
          (message) => message.channel?.questionId === ChannelQuestionId.make(pending.id),
        ).length,
        0,
      );
    }).pipe(Effect.provide(harness.layer));
  });
});
