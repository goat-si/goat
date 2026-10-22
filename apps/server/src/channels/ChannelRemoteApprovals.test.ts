import { assert, describe, it } from "@effect/vitest";
import {
  ChannelWorkerObservation,
  EnvironmentId,
  NodeId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ChannelReceptionInput,
  type ChannelTask,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type RuntimeMode,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  makeHarness,
  onlyTask,
  owner,
  ownerId,
  resultsTo,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const since = "2026-10-12T00:01:00.000Z";
const encodeObservation = Schema.encodeSync(Schema.fromJsonString(ChannelWorkerObservation));

const approval = (id: string): OrchestrationV2RuntimeRequest =>
  ({
    id: RuntimeRequestId.make("approval:" + id),
    nodeId: NodeId.make("node:" + id),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: DateTime.makeUnsafe(since),
    resolvedAt: null,
  }) as OrchestrationV2RuntimeRequest;

const questionCards = Effect.map(botMessages, (records) =>
  records.messages.filter((message) => message.channel?.kind === "question"),
);

const responses = (harness: ReturnType<typeof makeHarness>) =>
  harness.world.commands.flatMap((command) =>
    command.type === "runtime-request.respond" ? [command] : [],
  );

interface RecordedCall {
  readonly tool: string;
  readonly ceiling: RuntimeMode;
  readonly host: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly writes: boolean;
  readonly approvals: boolean;
}

const recordingSsh = (calls: RecordedCall[], refuseApprovals: { current: boolean }) =>
  Layer.succeed(SshRemoteDispatch.SshRemoteDispatch, {
    listHosts: () => Effect.succeed([]),
    callHostTool: (
      call: SshRemoteDispatch.SshHostToolCall,
      authorize: Effect.Effect<RuntimeMode, never>,
    ) =>
      Effect.gen(function* () {
        const ceiling = yield* authorize;
        calls.push({
          tool: call.tool,
          ceiling,
          host: call.host,
          arguments: call.arguments,
          writes: call.writes,
          approvals: call.approvals === true,
        });
        if (refuseApprovals.current && call.approvals === true) {
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            message:
              call.host +
              " could not issue a GOAT session that may answer approvals: the remote is older.",
          });
        }
        return {};
      }),
  } as unknown as SshRemoteDispatch.SshRemoteDispatch["Service"]);

const linkSlack = (
  user: string,
  runtimeModeCeiling: RuntimeMode,
  grantedScopes?: ReadonlyArray<"orchestration:read" | "orchestration:operate" | "settings:write">,
) =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const { code } = yield* identities.createLink(
      {
        connectionId: "slack-1",
        runtimeModeCeiling,
        ...(grantedScopes === undefined ? {} : { grantedScopes: [...grantedScopes] }),
      },
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
          channelId: "C1",
          rootTs: "1.000",
        },
      },
      slackContext,
    );
  });

const remoteSubagent = (correlationId: string): OrchestrationV2Subagent =>
  ({
    childThreadId: null,
    status: "running",
    origin: "app_owned",
    remote: {
      host: "mac-studio",
      threadId: ThreadId.make("thread:remote-child"),
      correlationId,
    },
  }) as OrchestrationV2Subagent;

const storeObservation = (correlationId: string, observation: ChannelWorkerObservation) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO remote_dispatches (
      correlation_id, kind, origin_thread_id, host, remote_thread_id, launched_run_id, read_key,
      delivery, reports_supported, state, task_id, parent_run_id, observation, created_at, updated_at
    ) VALUES (
      ${correlationId}, 'task', ${"thread:origin"}, ${"mac-studio"}, ${"thread:remote-child"},
      ${"run:remote"}, ${"read-key"}, 'wake', 1, 'running', ${"task:remote"}, ${"run:parent"},
      ${encodeObservation(observation)}, ${since}, ${since}
    )`;
  });

/** A remote GOAT that can launch one worker and report its observation. */
class RemoteMachine {
  readonly calls: RecordedCall[] = [];
  readonly threadId = ThreadId.make("thread:remote");
  readonly runId = RunId.make("run:remote");
  observation: ChannelWorkerObservation = { pullRequests: [], needsYou: [] };
  waitIdle = Deferred.makeUnsafe<void>();
  private gate = Deferred.makeUnsafe<void>();

  setObservation(observation: ChannelWorkerObservation) {
    this.observation = observation;
    const previous = this.gate;
    this.gate = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
  }

  readonly layer: Layer.Layer<SshRemoteDispatch.SshRemoteDispatch> = Layer.succeed(
    SshRemoteDispatch.SshRemoteDispatch,
    {
      listHosts: () => Effect.succeed([{ alias: "mac-studio", source: "ssh-config" as const }]),
      launchThread: <E, R>(
        _input: SshRemoteDispatch.SshLaunchInput,
        beforeLaunch: Effect.Effect<void, E, R>,
      ) => {
        const machine = this;
        return Effect.gen(function* () {
          yield* beforeLaunch;
          return {
            host: "mac-studio",
            cwd: "/tmp/remote",
            projectId: "remote-project",
            projectCreated: false,
            threadId: machine.threadId,
            reportsSupported: true,
            runId: machine.runId,
            workspaceStrategy: { type: "root" },
            runtimeMode: "full-access",
            remoteServerKind: "managed",
            notes: [],
          };
        });
      },
      callHostTool: (
        call: SshRemoteDispatch.SshHostToolCall,
        authorize: Effect.Effect<RuntimeMode, never>,
      ) => {
        const machine = this;
        return Effect.gen(function* () {
          const ceiling = yield* authorize;
          machine.calls.push({
            tool: call.tool,
            ceiling,
            host: call.host,
            arguments: call.arguments,
            writes: call.writes,
            approvals: call.approvals === true,
          });
          switch (call.tool) {
            case "goat_project_list":
              return {
                projects: [
                  {
                    id: ProjectId.make("remote-project"),
                    title: "remote",
                    workspaceRoot: "/tmp/remote",
                    defaultModelSelection: null,
                  },
                ],
                nextCursor: null,
              };
            case "goat_environment_read":
              return { environmentId: EnvironmentId.make("environment:mac-studio") };
            case "goat_origin_reports_wait":
              return yield* machine.wait(call.arguments);
            default:
              return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                reason: "remote_refused",
                message: call.tool + " is not on this GOAT.",
              });
          }
        });
      },
    } as unknown as SshRemoteDispatch.SshRemoteDispatch["Service"],
  );

  private snapshot() {
    return {
      threadId: this.threadId,
      reports: [],
      hasMore: false,
      timedOut: false,
      latestRunId: this.runId,
      observedRun: {
        runId: this.runId,
        status: "running",
        summary: null,
        pendingRequestIds: [],
        observation: this.observation,
      },
    };
  }

  private wait(args: Readonly<Record<string, unknown>>) {
    const machine = this;
    const known = args.knownRun as {
      readonly runId?: string;
      readonly status?: string;
      readonly observation?: unknown;
    } | null;
    const current = machine.snapshot();
    const changed =
      known == null ||
      known.runId !== current.observedRun.runId ||
      known.status !== current.observedRun.status ||
      JSON.stringify(known.observation) !== JSON.stringify(current.observedRun.observation);
    if (changed || args.timeoutMs === 0) return Effect.succeed(current);
    const gate = machine.gate;
    const idle = machine.waitIdle;
    machine.waitIdle = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      yield* Deferred.succeed(idle, undefined);
      yield* Effect.raceFirst(
        Deferred.await(gate),
        Effect.sleep(Duration.millis(args.timeoutMs as number)),
      );
      return machine.snapshot();
    });
  }
}

const remoteScript = (input: ChannelReceptionInput) => {
  const text = input.inputText ?? "";
  const match = /^do@([^:]+):\s*(.+)$/u.exec(text);
  if (input.mode === "input" && match !== null) {
    return Effect.succeed({
      replyText: "On it.",
      action: {
        type: "create_task" as const,
        title: match[2]!,
        instruction: match[2]!,
        host: match[1]!,
      },
    });
  }
  return defaultScript(input);
};

const settle = (rounds = 40) =>
  Effect.gen(function* () {
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    for (let round = 0; round < rounds; round += 1) {
      yield* runtime.drain;
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(100));
    }
  });

const until = (label: string, check: (task: ChannelTask) => boolean) =>
  Effect.gen(function* () {
    for (let round = 0; round < 80; round += 1) {
      yield* settle(1);
      const task = yield* onlyTask;
      if (check(task)) return task;
    }
    const task = yield* onlyTask;
    return yield* Effect.die(
      new Error(
        "timed out waiting for " +
          label +
          ": " +
          JSON.stringify({
            status: task.status,
            summary: task.resultSummary,
            questions: task.openQuestions.map((question) => question.text),
            observed: task.observed,
          }),
      ),
    );
  });

const approvalNeed = (
  requestId: string,
  threadId: ThreadId,
): ChannelWorkerObservation["needsYou"][number] => ({
  kind: "approval",
  since,
  approval: { requestId: RuntimeRequestId.make(requestId), threadId },
});

describe("approvals held on another machine", () => {
  it.effect("stamps the worker's host and sends one card per new remote approval", () => {
    const machine = new RemoteMachine();
    const harness = makeHarness({ sshRemote: machine.layer });
    harness.script.current = remoteScript;
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const child = ThreadId.make("thread:remote-child");
      machine.setObservation({
        pullRequests: [],
        needsYou: [approvalNeed("approval:rm", child)],
      });
      yield* gateway.ingest(goatInput("do@mac-studio: watch the deploy", "remote-1"), rpcContext);
      const observed = yield* until(
        "stamped",
        (task) => task.observed?.needsYou[0]?.approval?.host === "mac-studio",
      );
      assert.deepStrictEqual(observed.observed?.needsYou[0]?.approval, {
        requestId: RuntimeRequestId.make("approval:rm"),
        threadId: child,
        host: "mac-studio",
      });
      yield* runtime.drain;
      assert.strictEqual((yield* questionCards).length, 1);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const state = JSON.parse((yield* ledger.getRemoteWorker(observed.taskId)) ?? "{}") as {
        knownRun?: { observation?: ChannelWorkerObservation };
      };
      assert.strictEqual(state.knownRun?.observation?.needsYou[0]?.approval?.host, undefined);

      yield* settle(3);
      assert.strictEqual((yield* questionCards).length, 1);

      machine.setObservation({
        pullRequests: [],
        needsYou: [approvalNeed("approval:rm", child), approvalNeed("approval:next", child)],
      });
      yield* until("second", (task) => (task.observed?.needsYou.length ?? 0) === 2);
      yield* runtime.drain;
      assert.strictEqual((yield* questionCards).length, 2);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect("shows a stored remote subagent approval and answers it on that machine", () => {
    const calls: RecordedCall[] = [];
    const harness = makeHarness({ sshRemote: recordingSsh(calls, { current: false }) });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlack("U1", "approval-required");
      yield* linkSlack("U2", "full-access");
      yield* linkSlack("U3", "approval-required", ["orchestration:read"]);
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(slackInput("do: ship the patch", "s1", "1.000", "U1"), slackContext);
      yield* runtime.drain;
      const worker = (yield* onlyTask).worker!.threadId;
      const correlationId = "corr-remote-1";
      harness.world.subagents.set(worker, [remoteSubagent(correlationId)]);
      const child = ThreadId.make("thread:remote-child");
      yield* storeObservation(correlationId, {
        pullRequests: [],
        needsYou: [approvalNeed("approval:remote", child)],
      });
      calls.length = 0;
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual(calls.length, 0);
      yield* runtime.drain;
      assert.strictEqual(yield* ledger.countWaitingTasks(ownerId), 1);
      const task = yield* onlyTask;
      assert.deepStrictEqual(task.observed?.needsYou[0]?.approval, {
        requestId: RuntimeRequestId.make("approval:remote"),
        threadId: child,
        host: "mac-studio",
      });
      assert.strictEqual(resultsTo(harness.slackSent, "question").length, 1);

      yield* gateway.ingest(slackInput("Approve A1", "s2", "1.000", "U3"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(calls.length, 0);
      assert.strictEqual(harness.slackSent.at(-1)?.message.text, CHANNEL_COPY.approvalNotAllowed);

      yield* gateway.ingest(slackInput("Approve A1", "s3", "1.000", "U2"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0], {
        tool: "goat_pending_request_respond",
        ceiling: "full-access",
        host: "mac-studio",
        arguments: {
          threadId: child,
          requestId: "approval:remote",
          decision: "accept",
          reason: "Approved by Owner from GOAT Bot (slack).",
        },
        writes: true,
        approvals: true,
      });
      assert.strictEqual(
        harness.slackSent.at(-1)?.message.text,
        "Approved. ship the patch continues.",
      );
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect("tells the person when the remote cannot grant approvals", () => {
    const calls: RecordedCall[] = [];
    const refuse = { current: true };
    const harness = makeHarness({ sshRemote: recordingSsh(calls, refuse) });
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: ship the patch", "g1"), rpcContext);
      yield* runtime.drain;
      const worker = (yield* onlyTask).worker!.threadId;
      harness.world.subagents.set(worker, [remoteSubagent("corr-refused")]);
      yield* storeObservation("corr-refused", {
        pullRequests: [],
        needsYou: [approvalNeed("approval:remote", ThreadId.make("thread:remote-child"))],
      });
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("Approve A1", "g2"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.approvals, true);
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.ok(texts.includes(CHANNEL_COPY.approvalRemoteRefused));
      assert.strictEqual(responses(harness).length, 0);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect("still answers an approval on this machine without calling another", () => {
    const calls: RecordedCall[] = [];
    const harness = makeHarness({ sshRemote: recordingSsh(calls, { current: false }) });
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
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("Approve A1", "a2"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(calls.length, 0);
      const [answered] = responses(harness);
      assert.strictEqual(answered?.type, "runtime-request.respond");
      assert.strictEqual(answered?.threadId, worker);
      assert.strictEqual(answered?.requestId, request.id);
      assert.strictEqual(answered?.decision, "accept");
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.ok(texts.includes("Approved. clean the build cache continues."));
    }).pipe(Effect.provide(harness.layer));
  });
});
