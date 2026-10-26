import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  EventId,
  ModelSelection,
  NodeId,
  ReviewLedgerEntry,
  type OrchestrationV2TaskRole,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { TestClock } from "effect/testing";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const parentModel = {
  instanceId,
  model: "author-model",
  options: [{ id: "reasoning", value: "high" }],
};
const childModel = { instanceId, model: "reviewer-model" };
const parentId = ThreadId.make("review-metadata-parent");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("review-metadata"),
  requestNamespace: "review-metadata",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  client: undefined,
  thread: { threadId: parentId, providerInstanceId: instanceId, providerSessionId: "session" },
};
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Metadata tests never start providers"),
};
const databaseLayer = SqlitePersistence.layerMemory;
const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "review-role-metadata" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer, runEffectWorker: false },
);

const baseTime = "2026-10-16T00:00:00.000Z";
const nextDay = "2026-10-17T00:00:00.000Z";
const endTime = "2026-10-18T00:00:00.000Z";
const decisions = [
  {
    kind: "decision",
    findingId: "accepted",
    severity: "low",
    cites: "a.ts:10",
    summary: "Fix the edge case",
    decision: "accepted",
    evidence: null,
  },
  {
    kind: "decision",
    findingId: "rebutted-high",
    severity: "high",
    cites: "b.ts:20",
    summary: "Check the guard",
    decision: "rebutted",
    evidence: { kind: "command", ref: "vp test run guard.test.ts", exitCode: 0 },
  },
  {
    kind: "decision",
    findingId: "rebutted-medium",
    severity: "medium",
    cites: null,
    summary: "Already handled",
    decision: "rebutted",
    evidence: null,
  },
] as const;

const makeFixture = (remote = false, role: OrchestrationV2TaskRole = "review") =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(baseTime));
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("parent-create"),
      threadId: parentId,
      projectId: ProjectId.make("review-project"),
      title: "Author",
      modelSelection: parentModel,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("parent-start"),
      threadId: parentId,
      messageId: MessageId.make("parent-prompt"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* store.getThreadRecords(parentId, ["runs"])).runs[0]!;
    const common = {
      commandId: CommandId.make("review-delegate"),
      parentThreadId: parentId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: "Review the diff",
      role,
      modelSelection: childModel,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
    };
    yield* orchestrator.dispatch(
      remote
        ? {
            ...common,
            type: "delegated_task.remote.register",
            driver,
            remote: {
              host: "box",
              threadId: ThreadId.make("remote-review"),
              correlationId: "review-correlation",
            },
          }
        : { ...common, type: "delegated_task.request" },
    );
    const task = (yield* store.getThreadRecords(parentId, ["subagents"])).subagents[0]!;
    return { orchestrator, store, task };
  });

const serviceLayer = ({ orchestrator, store }: Effect.Success<ReturnType<typeof makeFixture>>) => {
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest(),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: orchestrator.dispatch,
      getThreadRecords: (id, fields, filter) =>
        store.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
      getReviewLedgerEntries: (input) => store.getReviewLedgerEntries(input).pipe(Effect.orDie),
      getThreadShell: (id) => store.getThreadShell(id).pipe(Effect.orDie),
      getProjectThreadRecords: (target, fields, filter) =>
        store.getThreadRecords(target.threadId, fields, filter).pipe(Effect.orDie),
      delegatedTaskResultPending: () => Effect.succeed(false),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({}),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
      get: () => Effect.succeed(null),
    }),
    Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({ callHostTool: () => Effect.succeed({}) }),
  );
  return OrchestratorMcpService.layer.pipe(
    Layer.provide(layerNoFleetSync),
    Layer.provide(dependencies),
  );
};

it.effect.each([false, true])(
  "records three decisions and task_status exposes durable history, remote=%s",
  (remote) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(remote);
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const input = {
          taskId: fixture.task.id,
          entries: decisions,
          clientRequestId: "review-round-1",
        };
        const recorded = yield* service.recordReviewFindings(scope, input);
        assert.lengthOf(recorded.reviewLedger, 3);
        assert.lengthOf(recorded.findings, 3);
        if (remote) {
          yield* fixture.orchestrator.dispatch({
            type: "delegated_task.remote.progress",
            commandId: CommandId.make("remote-progress-after-record"),
            parentThreadId: parentId,
            taskId: fixture.task.id,
            correlationId: "review-correlation",
            remoteThreadId: fixture.task.remote!.threadId,
            summary: "Review complete soon",
          });
          assert.deepEqual(
            (yield* service.taskStatus(scope, fixture.task.id)).reviewLedger,
            recorded.reviewLedger,
          );
        }
        assert.equal(recorded.reviewLedger[0]!.recordedByRunId, fixture.task.runId);
        assert.deepEqual(
          (yield* service.recordReviewFindings(scope, input)).reviewLedger,
          recorded.reviewLedger,
        );
        assert.deepEqual(
          (yield* service.taskStatus(scope, fixture.task.id)).reviewLedger,
          recorded.reviewLedger,
        );
        const updated = yield* service.recordReviewFindings(scope, {
          taskId: fixture.task.id,
          entries: [{ ...decisions[2], decision: "accepted" }],
        });
        assert.lengthOf(updated.reviewLedger, 4);
        assert.equal(
          updated.findings.find((finding) => finding.decision.findingId === "rebutted-medium")!
            .decision.decision,
          "accepted",
        );
        if (remote) {
          yield* fixture.orchestrator.dispatch({
            type: "delegated_task.remote.result",
            commandId: CommandId.make("remote-result-after-record"),
            parentThreadId: parentId,
            taskId: fixture.task.id,
            correlationId: "review-correlation",
            status: "completed",
            summary: "Review completed",
          });
          assert.deepEqual(
            (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents[0]!
              .reviewLedger,
            updated.reviewLedger,
          );
        }
        // Nested recordedAt remains an ISO string across JSON persistence/replay.
        const ledgerJson = Schema.fromJsonString(Schema.Array(ReviewLedgerEntry));
        const encodedLedger = yield* Schema.encodeEffect(ledgerJson)(updated.reviewLedger);
        assert.deepEqual(
          yield* Schema.decodeUnknownEffect(ledgerJson)(encodedLedger),
          updated.reviewLedger,
        );
      }).pipe(Effect.provide(serviceLayer(fixture)));
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "refuses unsupported decisions atomically and derives outcomes from the latest decision",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        for (const severity of ["critical", "high"] as const) {
          const refusal = yield* service
            .recordReviewFindings(scope, {
              taskId: fixture.task.id,
              entries: [decisions[0], { ...decisions[1], severity, evidence: null }],
            })
            .pipe(Effect.flip);
          assert.equal(refusal.code, "invalid_request");
          assert.include(refusal.message, "requires evidence");
        }
        assert.isUndefined(
          (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents[0]!
            .reviewLedger,
        );
        const missing = yield* service
          .recordReviewFindings(scope, {
            taskId: fixture.task.id,
            entries: [
              {
                kind: "outcome",
                findingId: "unknown",
                link: { kind: "test", ref: "failing.test.ts" },
              },
            ],
          })
          .pipe(Effect.flip);
        assert.include(missing.message, "existing decision");
        yield* service.recordReviewFindings(scope, { taskId: fixture.task.id, entries: decisions });
        const outcome = yield* service.recordReviewFindings(scope, {
          taskId: fixture.task.id,
          entries: [
            {
              kind: "outcome",
              findingId: "rebutted-high",
              link: { kind: "test", ref: "failing.test.ts" },
            },
            { ...decisions[0], decision: "rebutted" },
            { kind: "outcome", findingId: "accepted", link: { kind: "revert", ref: "abc123" } },
            { kind: "outcome", findingId: "rebutted-medium", link: { kind: "issue", ref: "#300" } },
            { ...decisions[2], decision: "accepted" },
            {
              kind: "outcome",
              findingId: "rebutted-medium",
              link: { kind: "commit", ref: "def456" },
            },
          ],
        });
        assert.deepInclude(
          outcome.findings.find((finding) => finding.decision.findingId === "rebutted-high")!
            .latestOutcome,
          { outcome: "later_confirmed" },
        );
        assert.deepInclude(
          outcome.findings.find((finding) => finding.decision.findingId === "accepted")!
            .latestOutcome,
          { outcome: "later_confirmed" },
        );
        assert.deepInclude(
          outcome.findings.find((finding) => finding.decision.findingId === "rebutted-medium")!
            .latestOutcome,
          { outcome: "unneeded" },
        );
      }).pipe(Effect.provide(serviceLayer(fixture)));
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["general", "implementation", "research", "test", "design"] as const)(
  "refuses a %s task and names the role='review' argument for goat_task_create",
  (role) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(false, role);
      const refusal = yield* fixture.orchestrator
        .dispatch({
          type: "delegated_task.review-ledger.append",
          commandId: CommandId.make("not-review"),
          parentThreadId: parentId,
          taskId: fixture.task.id,
          entries: decisions,
        })
        .pipe(Effect.flip);
      assert.equal(refusal._tag, "OrchestratorReviewLedgerError");
      assert.include(refusal.message, "goat_task_create");
      assert.include(refusal.message, "role='review'");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "exports [from,to) pages with reviewer and author model snapshots and later outcomes",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        yield* service.recordReviewFindings(scope, { taskId: fixture.task.id, entries: decisions });
        yield* TestClock.setTime(Date.parse(nextDay));
        yield* service.recordReviewFindings(scope, {
          taskId: fixture.task.id,
          entries: [
            {
              kind: "outcome",
              findingId: "rebutted-high",
              link: { kind: "test", ref: "later-failure.test.ts" },
            },
          ],
        });
        const range = { from: baseTime, to: nextDay, limit: 2 };
        const first = yield* service.exportReviewFindings(scope, range);
        assert.isDefined(first.nextCursor);
        const second = yield* service.exportReviewFindings(scope, {
          ...range,
          cursor: first.nextCursor!,
        });
        assert.isUndefined(second.nextCursor);
        const decodeLine = Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              taskId: NodeId,
              threadId: ThreadId,
              role: Schema.Literal("review"),
              reviewerModel: ModelSelection,
              authorModel: ModelSelection,
              recordedAt: Schema.String,
              kind: Schema.Literal("decision"),
              latestOutcome: Schema.NullOr(ReviewLedgerEntry),
            }),
          ),
        );
        const lines = yield* Effect.forEach(
          (first.jsonl + second.jsonl).trim().split("\n"),
          (line) => decodeLine(line),
        );
        assert.lengthOf(lines, 3);
        for (const line of lines) {
          assert.equal(line.taskId, fixture.task.id);
          assert.equal(line.threadId, parentId);
          assert.deepEqual(line.reviewerModel, childModel);
          assert.deepEqual(line.authorModel, parentModel);
          assert.equal(line.recordedAt, baseTime);
        }
        assert.isTrue(
          lines.some(
            (line) =>
              line.latestOutcome?.kind === "outcome" &&
              line.latestOutcome.outcome === "later_confirmed",
          ),
        );
        const later = yield* service.exportReviewFindings(scope, { from: nextDay, to: endTime });
        assert.lengthOf(later.jsonl.trim().split("\n"), 1);
        const invalid = yield* service
          .exportReviewFindings(scope, { ...range, to: endTime, cursor: first.nextCursor! })
          .pipe(Effect.flip);
        assert.equal(invalid.code, "invalid_request");
        const denied = yield* service
          .exportReviewFindings({ ...scope, capabilities: new Set() }, range)
          .pipe(Effect.flip);
        assert.equal(denied.code, "capability_denied");
      }).pipe(Effect.provide(serviceLayer(fixture)));
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a fresh follow-up task does not inherit its predecessor's ledger", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    yield* fixture.orchestrator.dispatch({
      type: "delegated_task.review-ledger.append",
      commandId: CommandId.make("record-before-followup"),
      parentThreadId: parentId,
      taskId: fixture.task.id,
      entries: decisions,
    });
    const now = DateTime.makeUnsafe(baseTime);
    const child = yield* fixture.store.getThreadRecords(fixture.task.childThreadId!, ["runs"]);
    yield* fixture.store.apply({
      id: EventId.make("completed-child"),
      type: "run.updated",
      threadId: child.thread.id,
      occurredAt: now,
      payload: { ...child.runs[0]!, status: "completed", completedAt: now },
    });
    const task = (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents[0]!;
    yield* fixture.store.apply({
      id: EventId.make("published-task"),
      type: "subagent.updated",
      threadId: parentId,
      occurredAt: now,
      payload: { ...task, status: "completed", result: "Published review", completedAt: now },
    });
    const owner = (yield* fixture.store.getThreadRecords(parentId, ["runs"])).runs[0]!;
    const followupAuthor = { instanceId, model: "followup-author-model" };
    yield* fixture.store.apply({
      id: EventId.make("followup-owner-model"),
      type: "run.updated",
      threadId: parentId,
      occurredAt: now,
      payload: { ...owner, modelSelection: followupAuthor },
    });
    yield* fixture.orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("followup"),
      threadId: child.thread.id,
      messageId: MessageId.make("followup"),
      senderThreadId: parentId,
      text: "Follow up",
      attachments: [],
      modelSelection: childModel,
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "mcp",
    });
    const tasks = (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents;
    assert.lengthOf(tasks, 2);
    assert.lengthOf(tasks.find((candidate) => candidate.id === task.id)!.reviewLedger!, 3);
    assert.isUndefined(tasks.find((candidate) => candidate.id !== task.id)!.reviewLedger);
    assert.deepEqual(
      tasks.find((candidate) => candidate.id !== task.id)!.parentModelSelection,
      followupAuthor,
    );
    assert.deepEqual(
      tasks.find((candidate) => candidate.id === task.id)!.parentModelSelection,
      parentModel,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])("refuses missing and provider-native tasks, native=%s", (native) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    if (native)
      yield* fixture.store.apply({
        id: EventId.make("native-review"),
        type: "subagent.updated",
        threadId: parentId,
        occurredAt: DateTime.makeUnsafe(baseTime),
        payload: { ...fixture.task, origin: "provider_native" },
      });
    const refused = yield* fixture.orchestrator
      .dispatch({
        type: "delegated_task.review-ledger.append",
        commandId: CommandId.make("unowned-review"),
        parentThreadId: parentId,
        taskId: native ? fixture.task.id : NodeId.make("other-parent-task"),
        entries: decisions,
      })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorReviewLedgerError");
    assert.include(refused.message, "app-owned task of the parent");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "exports outcomes only within each decision's lifetime and clears the current outcome on a new decision",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const initial = yield* service.recordReviewFindings(scope, {
          taskId: fixture.task.id,
          entries: [
            decisions[1],
            {
              kind: "outcome",
              findingId: decisions[1].findingId,
              link: { kind: "test", ref: "old-failure" },
            },
            decisions[0],
            { ...decisions[1], decision: "accepted" },
          ],
        });
        assert.isNull(
          initial.findings.find((finding) => finding.decision.findingId === decisions[1].findingId)!
            .latestOutcome,
        );
        const updated = yield* service.recordReviewFindings(scope, {
          taskId: fixture.task.id,
          entries: [
            {
              kind: "outcome",
              findingId: decisions[1].findingId,
              link: { kind: "revert", ref: "unneeded" },
            },
            decisions[1],
            {
              kind: "outcome",
              findingId: decisions[1].findingId,
              link: { kind: "test", ref: "new-failure" },
            },
          ],
        });
        const exported = yield* service.exportReviewFindings(scope, {
          from: baseTime,
          to: nextDay,
        });
        const decodeLine = Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              kind: Schema.String,
              entryId: Schema.String,
              latestOutcome: Schema.optional(Schema.NullOr(ReviewLedgerEntry)),
            }),
          ),
        );
        const entries = yield* Effect.forEach(exported.jsonl.trim().split("\n"), (line) =>
          decodeLine(line),
        );
        const outcomes = new Map(
          entries
            .filter((entry) => entry.kind === "decision")
            .map((entry) => [entry.entryId, entry.latestOutcome]),
        );
        assert.deepEqual(outcomes.get(updated.reviewLedger[0]!.entryId), updated.reviewLedger[1]);
        assert.isNull(outcomes.get(updated.reviewLedger[2]!.entryId));
        assert.deepEqual(outcomes.get(updated.reviewLedger[3]!.entryId), updated.reviewLedger[4]);
        assert.deepEqual(outcomes.get(updated.reviewLedger[5]!.entryId), updated.reviewLedger[6]);
        assert.deepEqual(
          updated.findings.find((finding) => finding.decision.findingId === decisions[1].findingId)!
            .latestOutcome,
          updated.reviewLedger[6],
        );
      }).pipe(Effect.provide(serviceLayer(fixture)));
    }).pipe(Effect.provide(layerTest)),
);
