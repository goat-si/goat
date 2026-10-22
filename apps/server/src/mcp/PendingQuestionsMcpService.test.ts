import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  OrchestratorMcpPendingRequestRespondInput,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2UserInputQuestion,
  type UserInputRespondedBy,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResults from "../threadResults/ThreadResultService.ts";
import * as HostThreads from "./HostThreadsMcpService.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as PendingQuestions from "./PendingQuestionsMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import { OrchestratorQuestionAlreadyAnsweredError } from "../orchestration-v2/Orchestrator.ts";

const decodeRespondInput = Schema.decodeUnknownSync(OrchestratorMcpPendingRequestRespondInput);
const callerId = ThreadId.make("caller");
const targetId = ThreadId.make("asking");
const requestId = RuntimeRequestId.make("question");
const now = DateTime.makeUnsafe("2026-10-12T00:00:00Z");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("origin"),
  requestNamespace: "caller",
  issuedAt: 0,
  thread: {
    threadId: callerId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
};
const outside: McpInvocationScope = {
  ...scope,
  thread: undefined,
  client: { sessionId: "client", label: "SSH", access: "full-access" },
};
const approver: McpInvocationScope = {
  ...outside,
  client: { sessionId: "approver", label: "Grok Bot", access: "full-access", approvals: true },
};
const reason = "The existing API meets the requirement.";
const foreign: UserInputRespondedBy = {
  type: "agent",
  threadId: ThreadId.make("remote-caller"),
  environmentId: EnvironmentId.make("remote-origin"),
  title: "Coordinator",
  reason,
};
const answers = { q: "  exact label\n" };
const respondInput = { threadId: targetId, requestId, reason, answers };
const questionProjection = (
  id = targetId,
  rid = requestId,
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion> = [
    { id: "q", header: "Choice", question: "Use the existing API?", options: [] },
  ],
): OrchestrationV2ThreadProjection => {
  const projection = idleThreadProjection(liveThreadShell(id));
  const request: OrchestrationV2RuntimeRequest = {
    id: rid,
    nodeId: NodeId.make(`node:${rid}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: now,
    resolvedAt: null,
  };
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`item:${rid}`),
    type: "user_input_request",
    threadId: id,
    runId: RunId.make("asking-run"),
    nodeId: request.nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "waiting",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    requestId: rid,
    questions,
  };
  return { ...projection, runtimeRequests: [request], turnItems: [item] };
};
const approvalProjection = (): OrchestrationV2ThreadProjection => {
  const projection = questionProjection();
  const request = projection.runtimeRequests[0]!;
  const item = projection.turnItems[0]!;
  return {
    ...projection,
    runtimeRequests: [{ ...request, kind: "command" }],
    turnItems: [
      {
        ...item,
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt: "hostname",
      } as OrchestrationV2TurnItem,
    ],
  };
};
const decideInput = { threadId: targetId, requestId, reason, decision: "accept" as const };
const remoteQuestion = (env = "remote", rid = "question") => ({
  host: null,
  environmentId: env,
  threadId: "asking",
  title: "Asking",
  requestId: rid,
  questions: [],
  humanRequired: false,
});

const runService = <A, E>(
  options: {
    readonly records?: ReadonlyArray<OrchestrationV2ThreadProjection>;
    readonly candidates?: ReadonlyArray<{ threadId: ThreadId; requestId: RuntimeRequestId }>;
    readonly hosts?: ReadonlyArray<string>;
    readonly caller?: ReturnType<typeof liveThreadShell>;
    readonly queryFails?: boolean;
    readonly hostCall?: (
      call: SshRemoteDispatch.SshHostToolCall,
    ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
    readonly beforeAuthorize?: () => void;
  },
  body: (service: PendingQuestions.PendingQuestionsMcpService["Service"]) => Effect.Effect<A, E>,
) => {
  const calls: Array<SshRemoteDispatch.SshHostToolCall> = [];
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const queries: Array<
    Parameters<
      ThreadManagement.ThreadManagementService["Service"]["getLaunchedPendingQuestions"]
    >[0]
  > = [];
  const reads: Array<{
    threadId: ThreadId;
    filter: Parameters<ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"]>[2];
  }> = [];
  const records = new Map(
    (options.records ?? [questionProjection()]).map((projection) => [
      projection.thread.id,
      projection,
    ]),
  );
  const caller = options.caller ?? liveThreadShell(callerId);
  let connectedReads = 0;
  const threadLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(id === callerId ? caller : liveThreadShell(id)),
    getThreadRecords: (id, _fields, filter) =>
      Effect.sync(() => {
        reads.push({ threadId: id, filter });
        return records.get(id)!;
      }),
    getProjectThreadRecords: (input) =>
      Effect.succeed(
        records.get(input.threadId) ?? idleThreadProjection(liveThreadShell(input.threadId)),
      ),
    getLaunchedPendingQuestions: (input) =>
      Effect.suspend(() => {
        queries.push(input);
        return options.queryFails
          ? Effect.fail(new Error("storage failed") as never)
          : Effect.succeed(options.candidates ?? []);
      }),
    dispatch: (command) =>
      Effect.gen(function* () {
        commands.push(command);
        if (command.type === "runtime-request.respond") {
          const projection = records.get(command.threadId)!;
          const request = projection.runtimeRequests.find(
            (request) => request.id === command.requestId,
          )!;
          if (request.status !== "pending")
            return yield* new OrchestratorQuestionAlreadyAnsweredError({
              commandId: command.commandId,
              requestId: command.requestId,
              respondedBy: request.respondedBy,
              resolvedAt: request.resolvedAt,
            });
          records.set(command.threadId, {
            ...projection,
            runtimeRequests: projection.runtimeRequests.map((request) =>
              request.id === command.requestId
                ? {
                    ...request,
                    status: "resolved",
                    resolvedAt: now,
                    respondedBy: command.respondedBy,
                    answers: command.answers,
                  }
                : request,
            ),
          });
        }
        return { sequence: 7, storedEvents: [] };
      }),
  });
  const transport = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
    connectedHosts: Effect.sync(() => {
      connectedReads += 1;
      return options.hosts ?? [];
    }),
    callHostTool: (call, authorize) =>
      Effect.gen(function* () {
        options.beforeAuthorize?.();
        yield* authorize;
        calls.push(call);
        return yield* options.hostCall?.(call) ?? Effect.succeed({ sequence: 7 });
      }),
  });
  const hostLayer = HostThreads.layer.pipe(
    Layer.provide(layerNoFleetSync),
    Layer.provide(Layer.mock(ThreadResults.ThreadResultService)({})),
    Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
    Layer.provide(
      Layer.mock(LaunchWatchService.LaunchWatchService)({ find: () => Effect.succeed(null) }).pipe(
        Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({})),
      ),
    ),
    Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
    Layer.provide(transport),
    Layer.provide(threadLayer),
  );
  const layer = PendingQuestions.layer.pipe(
    Layer.provide(hostLayer),
    Layer.provide(transport),
    Layer.provide(threadLayer),
    Layer.provide(NodeCrypto.layer),
  );
  return Effect.gen(function* () {
    const service = yield* PendingQuestions.PendingQuestionsMcpService;
    const result = yield* body(service).pipe(Effect.result);
    return { result, calls, commands, queries, connectedReads, records, reads };
  }).pipe(Effect.provide(layer));
};

describe("PendingQuestionsMcpService", () => {
  it.effect("returns fast hosts at the fan-out deadline without interrupting a slow launch", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<void>();
      const slow = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Deferred.succeed(finished, undefined)),
        Effect.as({ questions: [], truncated: false, unavailableHosts: [] }),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      );
      const fiber = yield* runService(
        {
          candidates: [{ threadId: targetId, requestId }],
          hosts: ["fast", "slow"],
          hostCall: (call) =>
            call.host === "slow"
              ? slow
              : Effect.succeed({
                  questions: [remoteQuestion()],
                  truncated: false,
                  unavailableHosts: [],
                }),
        },
        (service) => service.list(scope, { scope: "launched" }),
      ).pipe(
        Effect.tap(() => Deferred.succeed(returned, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(14_999);
      expect(yield* Deferred.isDone(returned)).toBe(false);
      yield* TestClock.adjust(1);
      const returnedOnTime = yield* Deferred.isDone(returned);
      const wasInterrupted = yield* Deferred.isDone(interrupted);
      // Release even on the old implementation so a failing regression cannot hang.
      yield* Deferred.succeed(release, undefined);
      const { result } = yield* Fiber.join(fiber);
      if (!wasInterrupted) yield* Deferred.await(finished);
      expect(returnedOnTime).toBe(true);
      expect(wasInterrupted).toBe(false);
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect("questions" in result.success).toBe(true);
      if (!("questions" in result.success)) return;
      expect(result.success.questions.map((question) => question.host)).toEqual([null, "fast"]);
      expect(result.success.unavailableHosts).toEqual([
        {
          host: "slow",
          code: "host_unavailable",
          message: expect.stringContaining("host:slow"),
        },
      ]);
      expect(result.success.unavailableHosts?.[0]?.message).toContain("waits longer");
    }),
  );

  it.effect("keeps default local list restricted to pending user_input", () =>
    Effect.gen(function* () {
      const projection = questionProjection(callerId);
      const base = projection.runtimeRequests[0]!;
      const { result, calls } = yield* runService(
        {
          records: [
            {
              ...projection,
              runtimeRequests: [
                base,
                ...(["resolved", "expired", "cancelled"] as const).map((status) => ({
                  ...base,
                  id: RuntimeRequestId.make(status),
                  status,
                })),
                { ...base, id: RuntimeRequestId.make("approval"), kind: "command" },
              ],
            },
          ],
        },
        (service) => service.list(scope, {}),
      );
      expect(result).toMatchObject({ success: { requestIds: [requestId] } });
      expect(calls).toEqual([]);
    }),
  );
  it.effect("reads resolved local questions without inventing a responder", () =>
    Effect.gen(function* () {
      const projection = questionProjection();
      const { result } = yield* runService(
        {
          records: [
            {
              ...projection,
              runtimeRequests: [
                { ...projection.runtimeRequests[0]!, status: "resolved", resolvedAt: now },
              ],
            },
          ],
        },
        (service) => service.read(scope, { threadId: targetId, requestId }),
      );
      expect(result).toMatchObject({
        success: { status: "resolved", resolvedAt: "2026-10-12T00:00:00.000Z" },
      });
      if (result._tag === "Success") expect(result.success.respondedBy).toBeUndefined();
    }),
  );
  it.effect("routes remote list and read without host and tags decoded results", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runService(
        {
          hostCall: (call) =>
            Effect.succeed(
              call.tool === "goat_pending_request_list"
                ? { requestIds: [requestId] }
                : { requestId, questions: [] },
            ),
        },
        (service) =>
          Effect.all([
            service.list(scope, { host: "box", threadId: targetId, scope: "thread" }),
            service.read(scope, { host: "box", threadId: targetId, requestId }),
          ]),
      );
      expect(result).toMatchObject({
        success: [
          { host: "box", requestIds: [requestId] },
          { host: "box", requestId, questions: [] },
        ],
      });
      expect(calls.map((call) => [call.tool, call.arguments, call.writes])).toEqual([
        ["goat_pending_request_list", { threadId: targetId }, false],
        ["goat_pending_request_read", { threadId: targetId, requestId }, false],
      ]);
    }),
  );
  it.effect("requires threadId for single-thread remote pending tools", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runService({}, (service) =>
        Effect.all([
          service.list(scope, { host: "box" }).pipe(Effect.result),
          service.read(scope, { host: "box", requestId }).pipe(Effect.result),
          service.respond(scope, { host: "box", requestId, reason, answers }).pipe(Effect.result),
        ]),
      );
      expect(result).toMatchObject({
        success: [
          { failure: { code: "target_required" } },
          { failure: { code: "target_required" } },
          { failure: { code: "target_required" } },
        ],
      });
      expect(calls).toEqual([]);
    }),
  );
  it.effect("answers locally with authenticated agent provenance and unchanged answer bytes", () =>
    Effect.gen(function* () {
      const { result, commands, records } = yield* runService({}, (service) =>
        service.respond(scope, respondInput),
      );
      expect(result).toMatchObject({ success: { sequence: 7 } });
      expect(commands[0]).toMatchObject({
        type: "runtime-request.respond",
        answers,
        respondedBy: {
          type: "agent",
          threadId: callerId,
          environmentId: null,
          title: callerId,
          reason,
        },
      });
      expect(records.get(targetId)?.runtimeRequests[0]?.respondedBy).toMatchObject({
        type: "agent",
      });
    }),
  );
  it.effect.each([undefined, false, true])(
    "stores and reads agent relay provenance (%s)",
    (relayedFromUser) =>
      Effect.gen(function* () {
        const input = {
          ...respondInput,
          ...(relayedFromUser === undefined ? {} : { relayedFromUser }),
        };
        const { result, commands, records } = yield* runService({}, (service) =>
          Effect.gen(function* () {
            yield* service.respond(scope, input);
            return yield* service.read(scope, { threadId: targetId, requestId });
          }),
        );
        const expected = {
          type: "agent",
          threadId: callerId,
          environmentId: null,
          title: callerId,
          reason,
          ...(relayedFromUser === undefined ? {} : { relayedFromUser }),
        };
        expect(commands[0]).toMatchObject({ respondedBy: expected });
        expect(records.get(targetId)?.runtimeRequests[0]?.respondedBy).toEqual(expected);
        expect(result).toMatchObject({ success: { status: "resolved", respondedBy: expected } });
        if (result._tag === "Success") expect(result.success.respondedBy).toEqual(expected);
      }),
  );
  it.effect("preserves the relay claim across host transport and remote reads", () =>
    Effect.gen(function* () {
      const sent = yield* runService({}, (service) =>
        service.respond(scope, { ...respondInput, host: "box", relayedFromUser: true }),
      );
      expect(sent.result._tag).toBe("Success");
      expect(sent.calls).toHaveLength(1);
      const transported = decodeRespondInput(sent.calls[0]!.arguments);
      const destination = { ...outside, environmentId: EnvironmentId.make("destination") };
      const received = yield* runService({}, (service) =>
        Effect.gen(function* () {
          yield* service.respond(destination, transported);
          return yield* service.read(destination, { threadId: targetId, requestId });
        }),
      );
      const expected = {
        type: "agent",
        threadId: callerId,
        environmentId: scope.environmentId,
        title: callerId,
        reason,
        relayedFromUser: true,
      };
      expect(received.commands[0]).toMatchObject({ respondedBy: expected });
      expect(received.records.get(targetId)?.runtimeRequests[0]?.respondedBy).toEqual(expected);
      expect(received.result).toMatchObject({ success: { respondedBy: expected } });
      if (received.result._tag !== "Success") return;
      const remoteRead = received.result.success;
      const readBack = yield* runService(
        { hostCall: () => Effect.succeed(remoteRead) },
        (service) => service.read(scope, { host: "box", threadId: targetId, requestId }),
      );
      expect(readBack.result).toMatchObject({
        success: { host: "box", status: "resolved", respondedBy: expected },
      });
    }),
  );
  it.effect.each([
    { name: "missing answers", answers: undefined },
    { name: "empty answers", answers: {} },
    { name: "a header instead of an id", answers: { Choice: "Yes" } },
    { name: "an extra question id", answers: { q: "Yes", extra: "No" } },
  ])("explains the expected question ids for $name without dispatching", ({ answers }) =>
    Effect.gen(function* () {
      const run = yield* runService({}, (service) =>
        service.respond(scope, {
          threadId: targetId,
          requestId,
          reason,
          ...(answers === undefined ? {} : { answers }),
        }),
      );
      expect(run.result).toMatchObject({
        failure: {
          code: "invalid_request",
          message: expect.stringContaining("Expected question ids: q."),
        },
      });
      expect(run.commands).toEqual([]);
    }),
  );
  it.effect.each([
    { name: "an unknown option", answer: "Maybe", multiSelect: false },
    { name: "multiple choices for single select", answer: ["Yes", "No"], multiSelect: false },
    { name: "an empty selection", answer: [], multiSelect: true },
    { name: "an unknown multi select option", answer: ["Yes", "Maybe"], multiSelect: true },
  ])(
    "lists allowed choices for $name when custom answers are forbidden",
    ({ answer, multiSelect }) =>
      Effect.gen(function* () {
        const records = [
          questionProjection(targetId, requestId, [
            {
              id: "q",
              header: "Choice",
              question: "Proceed?",
              multiSelect,
              allowCustomAnswer: false,
              options: [
                { label: "Yes", description: "Proceed", value: "yes-id" },
                { label: "No", description: "Stop" },
              ],
            },
          ]),
        ];
        const run = yield* runService({ records }, (service) =>
          service.respond(scope, { ...respondInput, answers: { q: answer } }),
        );
        expect(run.result).toMatchObject({
          failure: {
            code: "invalid_request",
            message: expect.stringContaining('Allowed options: "yes-id", "No".'),
          },
        });
        expect(run.commands).toEqual([]);
      }),
  );
  it.effect.each([
    { answer: "Yes", multiSelect: false, allowCustomAnswer: false },
    { answer: "yes-id", multiSelect: false, allowCustomAnswer: false },
    { answer: ["yes-id", "No"], multiSelect: true, allowCustomAnswer: false },
    { answer: "  custom text\n", multiSelect: false, allowCustomAnswer: true },
    { answer: ["Yes", "custom"], multiSelect: true, allowCustomAnswer: undefined },
  ])(
    "preserves valid answers ($answer, custom=$allowCustomAnswer)",
    ({ answer, multiSelect, allowCustomAnswer }) =>
      Effect.gen(function* () {
        const records = [
          questionProjection(targetId, requestId, [
            {
              id: "q",
              header: "Choice",
              question: "Proceed?",
              multiSelect,
              ...(allowCustomAnswer === undefined ? {} : { allowCustomAnswer }),
              options: [
                { label: "Yes", description: "Proceed", value: "yes-id" },
                { label: "No", description: "Stop" },
              ],
            },
            {
              id: "optional",
              header: "Notes",
              question: "Anything else?",
              required: false,
              options: [],
            },
          ]),
        ];
        const run = yield* runService({ records }, (service) =>
          service.respond(scope, { ...respondInput, answers: { q: answer } }),
        );
        expect(run.result).toMatchObject({ success: { sequence: 7 } });
        expect(run.commands).toHaveLength(1);
        expect(run.commands[0]).toMatchObject({ answers: { q: answer } });
      }),
  );
  it.effect("rejects forged provenance from a thread caller", () =>
    Effect.gen(function* () {
      for (const host of [undefined, "box"]) {
        const { result, commands, calls } = yield* runService({}, (service) =>
          service.respond(scope, {
            ...respondInput,
            ...(host === undefined ? {} : { host }),
            respondedBy: { ...foreign, relayedFromUser: true },
            relayedFromUser: true,
          }),
        );
        expect(result).toMatchObject({ failure: { code: "invalid_request" } });
        expect(commands).toEqual([]);
        expect(calls).toEqual([]);
      }
    }),
  );
  it.effect("accepts transported foreign provenance only from an outside caller", () =>
    Effect.gen(function* () {
      const { result, commands } = yield* runService({}, (service) =>
        service.respond(outside, { ...respondInput, respondedBy: foreign }),
      );
      expect(result._tag).toBe("Success");
      expect(commands[0]).toMatchObject({ respondedBy: foreign });
      const invalidOrigins: UserInputRespondedBy[] = [
        { type: "user" },
        { type: "client", reason },
        { ...foreign, environmentId: null },
        { ...foreign, environmentId: scope.environmentId },
        { ...foreign, reason: "different" },
      ];
      for (const respondedBy of invalidOrigins) {
        const attempt = yield* runService({}, (service) =>
          service.respond(outside, { ...respondInput, respondedBy }),
        );
        expect(attempt.result).toMatchObject({ failure: { code: "invalid_request" } });
        expect(attempt.commands).toEqual([]);
      }
    }),
  );
  it.effect(
    "records threadless local origin as client and forwards threadless remote origin without provenance",
    () =>
      Effect.gen(function* () {
        const local = yield* runService({}, (service) => service.respond(outside, respondInput));
        expect(local.commands[0]).toMatchObject({ respondedBy: { type: "client", reason } });
        const remote = yield* runService({}, (service) =>
          service.respond(outside, { ...respondInput, host: "box" }),
        );
        expect(remote.calls[0]?.arguments).toEqual(respondInput);
        const transported = yield* runService({}, (service) =>
          service.respond(outside, { ...respondInput, host: "box", respondedBy: foreign }),
        );
        expect(transported.calls[0]?.arguments).toEqual(respondInput);
        expect(remote.calls[0]?.writes).toBe(true);
        expect(remote.result).toMatchObject({ success: { host: "box", sequence: 7 } });
      }),
  );
  it.effect("transports authenticated agent provenance with this environment and no host", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runService({}, (service) =>
        service.respond(scope, { ...respondInput, host: "box" }),
      );
      expect(calls[0]?.arguments).toEqual({
        ...respondInput,
        respondedBy: {
          type: "agent",
          threadId: callerId,
          environmentId: scope.environmentId,
          title: callerId,
          reason,
        },
      });
      expect(result).toMatchObject({ success: { sequence: 7, host: "box" } });
      expect(calls).toHaveLength(1);
    }),
  );
  it.effect("refuses remote respond in plan mode and after a mid-call mode change", () =>
    Effect.gen(function* () {
      for (const midCall of [false, true]) {
        const caller = liveThreadShell(callerId, { interactionMode: midCall ? "default" : "plan" });
        const { result, calls } = yield* runService(
          {
            caller,
            beforeAuthorize: () => {
              if (midCall) Object.assign(caller, { interactionMode: "plan" });
            },
          },
          (service) => service.respond(scope, { ...respondInput, host: "box" }),
        );
        expect(result).toMatchObject({
          failure: {
            code: "interaction_mode_escalation_denied",
            message: expect.stringContaining("forward it to the user"),
          },
        });
        expect(calls).toEqual([]);
      }
    }),
  );
  it.effect("keeps ceiling refusals and appends forward-to-human guidance once", () =>
    Effect.gen(function* () {
      const suffix =
        " This question needs a person: forward it to the user in your own thread, or let them answer it in the asking thread.";
      for (const message of ["Ceiling exceeded.", "Ceiling exceeded." + suffix]) {
        const { result, calls } = yield* runService(
          {
            hostCall: () =>
              Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "remote_refused",
                  remoteCode: "runtime_mode_escalation_denied",
                  message,
                }),
              ),
          },
          (service) => service.respond(scope, { ...respondInput, host: "box" }),
        );
        expect(result).toMatchObject({
          failure: {
            code: "runtime_mode_escalation_denied",
            message: "Ceiling exceeded." + suffix,
          },
        });
        expect(calls).toHaveLength(1);
      }
    }),
  );
  it.effect.each([
    {
      message: "goat_pending_request_respond does not take respondedBy, so nothing ran",
      mapped: true,
    },
    { message: "goat_pending_request_respond does not take reason, so nothing ran", mapped: true },
    { message: "goat_pending_request_respond does not take respondedBy", mapped: false },
    { message: "goat_pending_request_respond does not take reason", mapped: false },
    {
      message: "goat_pending_request_respond does not take answers, so nothing ran",
      mapped: false,
    },
  ])("maps only strict provenance refusals from old remotes: $message", ({ message, mapped }) =>
    Effect.gen(function* () {
      const { result, calls } = yield* runService(
        {
          hostCall: () =>
            Effect.fail(
              new SshRemoteDispatch.SshRemoteDispatchError({
                reason: "remote_refused",
                remoteCode: mapped ? "orchestration_error" : "invalid_request",
                message,
              }),
            ),
        },
        (service) => service.respond(scope, { ...respondInput, host: "box" }),
      );
      expect(result).toMatchObject({
        failure: {
          code: "invalid_request",
          message: mapped
            ? "GOAT on box is too old to record who answered; update GOAT there to answer its questions from here, or let the user answer in that thread."
            : message,
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.arguments).toMatchObject({ reason, respondedBy: { type: "agent", reason } });
    }),
  );
  it.effect("maps typed already-answered failures and never dispatches approval responses", () =>
    Effect.gen(function* () {
      const projection = questionProjection();
      const answered = yield* runService(
        {
          records: [
            {
              ...projection,
              runtimeRequests: [
                {
                  ...projection.runtimeRequests[0]!,
                  status: "resolved",
                  resolvedAt: now,
                  respondedBy: { type: "user" },
                },
              ],
            },
          ],
        },
        (service) => service.respond(scope, respondInput),
      );
      expect(answered.result).toMatchObject({
        failure: {
          code: "invalid_request",
          message: expect.stringContaining("already answered by"),
        },
      });
      const approval = yield* runService(
        {
          records: [
            {
              ...projection,
              runtimeRequests: [{ ...projection.runtimeRequests[0]!, kind: "command" }],
            },
          ],
        },
        (service) => service.respond(scope, respondInput),
      );
      expect(approval.result).toMatchObject({ failure: { code: "invalid_request" } });
      expect(approval.commands).toEqual([]);
    }),
  );
  it.effect("lets only an approve-scoped client see and decide approvals", () =>
    Effect.gen(function* () {
      const records = [approvalProjection()];
      const listed = yield* runService({ records }, (service) =>
        service.list(approver, { threadId: targetId }),
      );
      expect(listed.result).toMatchObject({
        success: { requestIds: [], approvalRequestIds: [requestId] },
      });
      const hidden = yield* runService({ records }, (service) =>
        service.list(outside, { threadId: targetId }),
      );
      expect(hidden.result._tag).toBe("Success");
      if (hidden.result._tag === "Success")
        expect(hidden.result.success).not.toHaveProperty("approvalRequestIds");

      const read = yield* runService({ records }, (service) =>
        service.read(approver, { threadId: targetId, requestId }),
      );
      expect(read.result).toMatchObject({
        success: { questions: [], approval: { kind: "command", prompt: "hostname" } },
      });
      const unread = yield* runService({ records }, (service) =>
        service.read(outside, { threadId: targetId, requestId }),
      );
      expect(unread.result).toMatchObject({ failure: { code: "invalid_request" } });

      const decided = yield* runService({ records }, (service) =>
        service.respond(approver, decideInput),
      );
      expect(decided.result).toMatchObject({ success: { sequence: 7 } });
      expect(decided.commands).toHaveLength(1);
      expect(decided.commands[0]).toMatchObject({
        type: "runtime-request.respond",
        decision: "accept",
        respondedBy: { type: "client", label: "Grok Bot", reason },
      });
      expect(decided.commands[0]).not.toHaveProperty("answers");

      for (const caller of [outside, scope]) {
        const refused = yield* runService({ records }, (service) =>
          service.respond(caller, decideInput),
        );
        expect(refused.result).toMatchObject({
          failure: {
            code: "capability_denied",
            message: expect.stringContaining("orchestration:approve"),
          },
        });
        expect(refused.commands).toEqual([]);
      }
      const both = yield* runService({ records }, (service) =>
        service.respond(approver, { ...decideInput, answers }),
      );
      expect(both.result).toMatchObject({
        failure: {
          code: "invalid_request",
          message: expect.stringContaining("omit the other field"),
        },
      });
      const answeredApproval = yield* runService({ records }, (service) =>
        service.respond(approver, respondInput),
      );
      expect(answeredApproval.result).toMatchObject({ failure: { code: "invalid_request" } });
      const decidedQuestion = yield* runService({}, (service) =>
        service.respond(approver, decideInput),
      );
      expect(decidedQuestion.result).toMatchObject({ failure: { code: "invalid_request" } });
      expect([both, answeredApproval, decidedQuestion].flatMap((run) => run.commands)).toEqual([]);
    }),
  );
  it.effect("asks hosts for an approval session and relays the deciding client", () =>
    Effect.gen(function* () {
      const remote = yield* runService({}, (service) =>
        service.respond(approver, { ...decideInput, host: "box" }),
      );
      expect(remote.result).toMatchObject({ success: { host: "box", sequence: 7 } });
      expect(remote.calls[0]).toMatchObject({
        approvals: true,
        writes: true,
        arguments: {
          ...decideInput,
          respondedBy: { type: "client", label: "Grok Bot", reason },
        },
      });
      const listed = yield* runService(
        { hostCall: () => Effect.succeed({ requestIds: [] }) },
        (service) => service.list(approver, { host: "box", threadId: targetId }),
      );
      expect(listed.calls[0]?.approvals).toBe(true);
      const plain = yield* runService(
        { hostCall: () => Effect.succeed({ requestIds: [] }) },
        (service) => service.list(outside, { host: "box", threadId: targetId }),
      );
      expect(plain.calls[0]).not.toHaveProperty("approvals");

      const relayed = { type: "client" as const, label: "Grok Bot", reason };
      const received = yield* runService({ records: [approvalProjection()] }, (service) =>
        service.respond(approver, { ...decideInput, respondedBy: relayed }),
      );
      expect(received.commands[0]).toMatchObject({ respondedBy: relayed });
    }),
  );
  it.effect("preserves host failures and rejects malformed results", () =>
    Effect.gen(function* () {
      for (const [error, code] of [
        [
          new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unknown",
            message: "Unknown",
          }),
          "invalid_request",
        ],
        [
          new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "Offline",
          }),
          "host_unavailable",
        ],
        [
          new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "caller_changed",
            message: "Changed",
          }),
          "runtime_mode_escalation_denied",
        ],
        [
          new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            remoteCode: "unknown",
            message: "Refused",
          }),
          "orchestration_error",
        ],
      ] as const) {
        const { result } = yield* runService({ hostCall: () => Effect.fail(error) }, (service) =>
          service.read(scope, { host: "box", threadId: targetId, requestId }),
        );
        expect(result).toMatchObject({ failure: { code } });
      }
      const malformed = yield* runService(
        { hostCall: () => Effect.succeed({ sequence: 1 }) },
        (service) => service.read(scope, { host: "box", threadId: targetId, requestId }),
      );
      expect(malformed.result).toMatchObject({ failure: { code: "orchestration_error" } });
    }),
  );
  it.effect("queries local launched questions and fans out once with identity-based dedup", () =>
    Effect.gen(function* () {
      const { result, calls, queries, reads } = yield* runService(
        {
          candidates: [{ threadId: targetId, requestId }],
          hosts: ["b", "a"],
          hostCall: (call) =>
            call.host === "gone"
              ? Effect.fail(
                  new SshRemoteDispatch.SshRemoteDispatchError({
                    reason: "host_unavailable",
                    message: "gone",
                  }),
                )
              : Effect.succeed({
                  questions: [remoteQuestion()],
                  truncated: false,
                  unavailableHosts: [],
                }),
        },
        (service) => service.list(scope, { scope: "launched", hosts: ["a", "gone"] }),
      );
      expect(queries).toEqual([
        { launcherThreadId: callerId, launcherEnvironmentId: null, limit: 101 },
      ]);
      expect(reads).toEqual([
        {
          threadId: targetId,
          filter: {
            turnItemTypes: ["user_input_request"],
            runtimeRequestIds: [requestId],
          },
        },
      ]);
      expect(calls.map((call) => call.host)).toEqual(["a", "b", "gone"]);
      for (const call of calls)
        expect(call.arguments).toEqual({
          scope: "launched",
          launcherThreadId: callerId,
          launcherEnvironmentId: scope.environmentId,
        });
      expect(result).toMatchObject({
        success: {
          truncated: false,
          questions: [
            { host: null, environmentId: "origin" },
            { host: "a", environmentId: "remote" },
          ],
          unavailableHosts: [{ host: "gone", code: "host_unavailable" }],
        },
      });
    }),
  );
  it.effect.each([16, 20])("caps merged connected and explicit hosts at 16 (total=%s)", (total) =>
    Effect.gen(function* () {
      const aliases = Array.from(
        { length: total },
        (_, i) => `host-${i.toString().padStart(2, "0")}`,
      );
      const { result, calls } = yield* runService(
        {
          candidates: [{ threadId: targetId, requestId }],
          hosts: aliases.slice(0, -2).toReversed(),
          hostCall: () => Effect.succeed({ questions: [], truncated: false, unavailableHosts: [] }),
        },
        (service) =>
          service.list(scope, { scope: "launched", hosts: [aliases[0]!, ...aliases.slice(-2)] }),
      );
      expect(calls.map((call) => call.host)).toEqual(aliases.slice(0, 16));
      expect(result).toMatchObject({
        success: {
          questions: [{ host: null, requestId }],
          unavailableHosts: aliases.slice(16).map((host) => ({
            host,
            code: "invalid_request",
            message:
              "Skipped this host because launched question discovery is limited to 16 hosts per call; query it directly with host and threadId.",
          })),
        },
      });
    }),
  );
  it.effect("caps local and merged pages and propagates remote truncation", () =>
    Effect.gen(function* () {
      const records = Array.from({ length: 101 }, (_, i) =>
        questionProjection(targetId, RuntimeRequestId.make(`q${i.toString().padStart(3, "0")}`)),
      );
      // Each candidate shares a thread, with all its requests in one projection.
      const projection = {
        ...records[0]!,
        runtimeRequests: records.flatMap((r) => r.runtimeRequests),
        turnItems: records.flatMap((r) => r.turnItems),
      };
      const local = yield* runService(
        {
          records: [projection],
          candidates: records.map((r) => ({
            threadId: targetId,
            requestId: r.runtimeRequests[0]!.id,
          })),
        },
        (service) => service.list(scope, { scope: "launched" }),
      );
      expect(local.result).toMatchObject({ success: { truncated: true } });
      if (local.result._tag === "Success" && "questions" in local.result.success)
        expect(local.result.success.questions).toHaveLength(100);
      const merged = yield* runService(
        {
          candidates: [{ threadId: targetId, requestId }],
          hosts: ["box"],
          hostCall: () =>
            Effect.succeed({
              questions: Array.from({ length: 100 }, (_, i) => remoteQuestion("remote", `r${i}`)),
              truncated: true,
              unavailableHosts: [],
            }),
        },
        (service) => service.list(scope, { scope: "launched" }),
      );
      if (merged.result._tag === "Success" && "questions" in merged.result.success) {
        expect(merged.result.success.questions).toHaveLength(100);
        expect(merged.result.success.truncated).toBe(true);
      } else throw new Error("Expected launched page");
    }),
  );
  it.effect("filters foreign launchers locally without recursive fan-out", () =>
    Effect.gen(function* () {
      const { result, calls, queries, connectedReads } = yield* runService(
        { candidates: [{ threadId: targetId, requestId }], hosts: ["must-not-read"] },
        (service) =>
          service.list(outside, {
            scope: "launched",
            launcherThreadId: callerId,
            launcherEnvironmentId: EnvironmentId.make("foreign"),
          }),
      );
      expect(result).toMatchObject({
        success: {
          questions: [{ host: null, environmentId: "origin" }],
          truncated: false,
          unavailableHosts: [],
        },
      });
      expect(queries[0]?.launcherEnvironmentId).toBe("foreign");
      expect(calls).toEqual([]);
      expect(connectedReads).toBe(0);
    }),
  );
  it.effect("rejects invalid scope and foreign filter combinations before fan-out", () =>
    Effect.gen(function* () {
      const cases: Array<
        Parameters<PendingQuestions.PendingQuestionsMcpService["Service"]["list"]>[1]
      > = [
        { hosts: ["box"] },
        { launcherThreadId: callerId },
        { scope: "launched", threadId: targetId },
        { scope: "launched", host: "box" },
        { scope: "launched", launcherThreadId: callerId },
        { scope: "launched", launcherEnvironmentId: EnvironmentId.make("foreign") },
        {
          scope: "launched",
          launcherThreadId: callerId,
          launcherEnvironmentId: scope.environmentId,
        },
        {
          scope: "launched",
          launcherThreadId: callerId,
          launcherEnvironmentId: EnvironmentId.make("foreign"),
          hosts: [],
        },
      ];
      for (const input of cases) {
        const { result, calls, queries } = yield* runService({}, (service) =>
          service.list(outside, input),
        );
        expect(result).toMatchObject({ failure: { code: "invalid_request" } });
        expect(calls).toEqual([]);
        expect(queries).toEqual([]);
      }
      const thread = yield* runService({}, (service) =>
        service.list(scope, {
          scope: "launched",
          launcherThreadId: callerId,
          launcherEnvironmentId: EnvironmentId.make("foreign"),
        }),
      );
      expect(thread.result).toMatchObject({ failure: { code: "invalid_request" } });
      const missing = yield* runService({}, (service) =>
        service.list(outside, { scope: "launched" }),
      );
      expect(missing.result).toMatchObject({ failure: { code: "target_required" } });
    }),
  );
  it.effect("marks above-ceiling local and remote plan questions humanRequired", () =>
    Effect.gen(function* () {
      const { result } = yield* runService(
        {
          caller: liveThreadShell(callerId, { runtimeMode: "auto", interactionMode: "plan" }),
          candidates: [{ threadId: targetId, requestId }],
          hosts: ["box"],
          hostCall: () =>
            Effect.succeed({
              questions: [remoteQuestion()],
              truncated: false,
              unavailableHosts: [],
            }),
        },
        (service) => service.list(scope, { scope: "launched" }),
      );
      if (result._tag !== "Success" || !("questions" in result.success))
        throw new Error("Expected page");
      expect(result.success.questions.map((q) => q.humanRequired)).toEqual([true, true]);
    }),
  );
  it.effect("reports unsupported and recursive launched pages as unavailable", () =>
    Effect.gen(function* () {
      for (const page of [
        { requestIds: [] },
        {
          questions: [{ ...remoteQuestion(), host: "nested" }],
          truncated: false,
          unavailableHosts: [],
        },
        {
          questions: [],
          truncated: false,
          unavailableHosts: [{ host: "nested", code: "host_unavailable", message: "bad" }],
        },
      ]) {
        const { result } = yield* runService(
          { hosts: ["box"], hostCall: () => Effect.succeed(page) },
          (service) => service.list(scope, { scope: "launched" }),
        );
        expect(result).toMatchObject({
          success: {
            questions: [],
            unavailableHosts: [{ host: "box", code: "orchestration_error" }],
          },
        });
      }
      const failed = yield* runService({ queryFails: true, hosts: ["box"] }, (service) =>
        service.list(scope, { scope: "launched" }),
      );
      expect(failed.result).toMatchObject({ failure: { code: "orchestration_error" } });
      expect(failed.calls).toEqual([]);
    }),
  );
  it.effect("bounds launched host concurrency and retains partial success", () =>
    Effect.gen(function* () {
      const active = yield* Ref.make(0);
      const maximum = yield* Ref.make(0);
      const started = yield* Ref.make(0);
      const firstFour = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* runService(
        {
          hosts: ["a", "b", "c", "d", "e", "gone"],
          hostCall: (call) =>
            Effect.gen(function* () {
              const current = yield* Ref.updateAndGet(active, (n) => n + 1);
              yield* Ref.update(maximum, (n) => Math.max(n, current));
              if ((yield* Ref.updateAndGet(started, (n) => n + 1)) === 4)
                yield* Deferred.succeed(firstFour, undefined);
              yield* Deferred.await(release);
              yield* Ref.update(active, (n) => n - 1);
              if (call.host === "gone")
                return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "host_unavailable",
                  message: "gone",
                });
              return {
                questions: [remoteQuestion(call.host)],
                truncated: false,
                unavailableHosts: [],
              };
            }),
        },
        (service) => service.list(scope, { scope: "launched" }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(firstFour);
      expect(yield* Ref.get(started)).toBe(4);
      yield* Deferred.succeed(release, undefined);
      const { result } = yield* Fiber.join(fiber);
      expect(yield* Ref.get(maximum)).toBe(4);
      if (result._tag !== "Success" || !("questions" in result.success))
        throw new Error("Expected page");
      expect(result.success.questions).toHaveLength(5);
      expect(result.success.unavailableHosts).toMatchObject([{ host: "gone" }]);
    }),
  );
});
