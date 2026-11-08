import { assert, describe, it } from "@effect/vitest";
import {
  ChannelChildWorkId,
  ChannelWorkerObservation,
  type ChannelTaskNeedsYou,
  NodeId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ChildStore from "./channelChildWorkStore.ts";
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
        yield* gateway.ingest(slackInput("approve", "Ev2", root, "U2"), slackContext);
        yield* gateway.ingest(slackInput("approve", "Ev3", root, "U3"), slackContext);
        yield* gateway.ingest(slackInput("approve", "Ev4", root, "U9"), slackContext);
        yield* runtime.drain;
        assert.strictEqual(responses(harness).length, 0);

        yield* gateway.ingest(slackInput("approve", "Ev5", root, "U1"), slackContext);
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
      yield* gateway.ingest(goatInput("deny", "late-deny"), rpcContext);
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
});

const encodeObservation = Schema.encodeSync(Schema.fromJsonString(ChannelWorkerObservation));
const sshHost = "mac-studio";
const sshThread = ThreadId.make("thread:remote");
const sshApprovalId = RuntimeRequestId.make("approval:ssh");

const sshObservation = {
  pullRequests: [],
  needsYou: [
    {
      kind: "approval" as const,
      since,
      approval: { requestId: sshApprovalId, threadId: sshThread },
    },
  ],
};

const admitSsh = Effect.fn(function* (
  task: { readonly taskId: string; readonly generation: number },
  id: string,
  state: "bound" | "completed",
) {
  const admitted = yield* (yield* ChildStore.ChannelChildWorkStore).admitReserved(
    {
      ownerId,
      taskId: task.taskId as never,
      childWorkId: ChannelChildWorkId.make(id),
      generation: task.generation,
      callerThreadId: ThreadId.make("thread:caller"),
      requestKey: id,
      promptDigest: "digest",
      surface: "ssh_thread_launch",
      destination: { correlationId: "corr:" + id, host: sshHost },
      state,
      createdAt: since,
      updatedAt: since,
    },
    100,
  );
  assert.strictEqual(admitted._tag, "admitted");
});

const insertThreadDispatch = (id: string, observation: typeof sshObservation | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO remote_dispatches (
      correlation_id, kind, origin_thread_id, host, remote_thread_id, launched_run_id, read_key,
      delivery, reports_supported, state, observation, created_at, updated_at
    ) VALUES (
      ${"corr:" + id}, 'thread', ${"thread:origin"}, ${sshHost}, ${sshThread},
      ${"run:remote"}, ${"read-key-" + id}, 'wake', 1, 'running',
      ${observation === null ? null : encodeObservation(observation)}, ${since}, ${since}
    )`;
  });

const stampedSshApproval = {
  kind: "approval" as const,
  since,
  approval: { requestId: sshApprovalId, threadId: sshThread, host: sshHost },
};

describe("GOAT Bot reads an approval from a thread launched on another machine", () => {
  it.effect("shows an approval an ssh-launched thread asks for after the task finished", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: write the release notes", "ssh-late"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* admitSsh(task, "late", "completed");
      yield* insertThreadDispatch("late", sshObservation);
      harness.world.setStatus(task.worker!.threadId, 1, "completed", "Started the notes thread.");
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "completed");
      const cardsBefore = yield* cards;
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const finished = yield* onlyTask;
      assert.strictEqual(finished.status, "completed");
      assert.deepStrictEqual(finished.observed?.needsYou, [stampedSshApproval]);
      assert.strictEqual(yield* cards, cardsBefore + 1);
      const version = finished.version;
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* onlyTask).version, version);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("says once that the approval on that machine is no longer waiting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: write the release notes", "ssh-gone"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* admitSsh(task, "gone", "completed");
      yield* insertThreadDispatch("gone", sshObservation);
      harness.world.setStatus(task.worker!.threadId, 1, "completed", "Started the notes thread.");
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE remote_dispatches SET observation = ${encodeObservation({
        pullRequests: [],
        needsYou: [],
      })} WHERE correlation_id = ${"corr:gone"}`;
      yield* reports.reconcile(runtime.ownerToken);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const told = (yield* botMessages).messages.filter((message) =>
        message.text.includes("no longer waiting"),
      );
      assert.strictEqual(told.length, 1);
      assert.strictEqual(
        told[0]?.text,
        "The approval on mac-studio is no longer waiting in the coding thread. write the release notes continues if it was approved.",
      );
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a shown ssh approval when the dispatch has no observation", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: write the release notes", "ssh-keep"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* admitSsh(task, "keep", "completed");
      yield* insertThreadDispatch("keep", sshObservation);
      harness.world.setStatus(task.worker!.threadId, 1, "completed", "Started the notes thread.");
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const shown = (yield* onlyTask).observed?.needsYou;
      assert.deepStrictEqual(shown, [stampedSshApproval]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE remote_dispatches SET observation = NULL WHERE correlation_id = ${"corr:keep"}`;
      yield* reports.reconcile(runtime.ownerToken);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, shown);
      yield* sql`UPDATE remote_dispatches SET reports_supported = 0, observation = ${encodeObservation(
        {
          pullRequests: [],
          needsYou: [],
        },
      )} WHERE correlation_id = ${"corr:keep"}`;
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, shown);
      const told = (yield* botMessages).messages.filter((message) =>
        message.text.includes("no longer waiting"),
      );
      assert.strictEqual(told.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("shows an approval an ssh-launched thread asks for while the task is running", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: write the release notes", "ssh-run"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* admitSsh(task, "run", "bound");
      yield* insertThreadDispatch("run", sshObservation);
      const cardsBefore = yield* cards;
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const running = yield* onlyTask;
      assert.strictEqual(running.status, "running");
      assert.deepStrictEqual(running.observed?.needsYou, [stampedSshApproval]);
      assert.strictEqual(yield* cards, cardsBefore + 1);
    }).pipe(Effect.provide(harness.layer));
  });
});
