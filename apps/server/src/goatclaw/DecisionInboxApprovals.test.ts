import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type AuthMcpClientAccess,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as Inbox from "./DecisionInbox.ts";
import * as Profiles from "./PermissionProfiles.ts";

// A provider approval on a full-access thread, projected into the inbox as a human-required item.
const target = ThreadId.make("pending-thread");
const now = DateTime.makeUnsafe("2026-10-23T00:00:00Z");
const approvalProjection = (): OrchestrationV2ThreadProjection => {
  const request: OrchestrationV2RuntimeRequest = {
    id: RuntimeRequestId.make("question"),
    nodeId: NodeId.make("node"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: now,
    resolvedAt: null,
  };
  const item = {
    id: TurnItemId.make("item"),
    type: "approval_request",
    threadId: target,
    runId: RunId.make("run"),
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
    requestId: request.id,
    requestKind: "command",
    prompt: "hostname",
  } as OrchestrationV2TurnItem;
  return {
    ...idleThreadProjection(liveThreadShell(target)),
    runtimeRequests: [request],
    turnItems: [item],
  };
};
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES ('pending-thread', 'project', 'Asking thread', 'codex', 'full-access', 'default', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
    (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
    VALUES ('question', 'pending-thread', 'node', 'command', 'pending', '1970-01-01T00:00:00.000Z', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items
    (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
    VALUES ('item', 'pending-thread', 0, 'approval_request', 'pending', '1970-01-01T00:00:00.000Z', ${JSON.stringify({ requestId: "question", prompt: "hostname" })})`;
});

const person: Inbox.DecisionCaller = {
  kind: "client",
  sessionId: "person",
  environmentId: EnvironmentId.make("test"),
  scopes: ["orchestration:operate"],
};
const outsideClient = (approvals: boolean, access: AuthMcpClientAccess = "full-access") =>
  ({
    kind: "agent",
    scope: {
      environmentId: EnvironmentId.make("test"),
      issuedAt: 0,
      requestNamespace: "outside",
      capabilities: new Set(["orchestration"]),
      thread: undefined,
      client: { sessionId: "bot", label: "Grok Bot", access, ...(approvals ? { approvals } : {}) },
    },
  }) satisfies Inbox.DecisionCaller;
const threadAgent: Inbox.DecisionCaller = {
  kind: "agent",
  scope: {
    ...outsideClient(true).scope,
    thread: {
      threadId: ThreadId.make("caller"),
      providerSessionId: "session",
      providerInstanceId: liveThreadShell(target).modelSelection.instanceId,
    },
  },
};

/** The real pending-request service over a thread store that enforces the dispatch ceiling. */
const fixture = (commands: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>) => {
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
    getProjectThreadRecords: () => Effect.succeed(approvalProjection()),
    getThreadRecords: () => Effect.succeed(approvalProjection()),
    dispatch: (command) =>
      Effect.gen(function* () {
        const limit = yield* DispatchModeLimit;
        if (
          limit !== undefined &&
          exceededDispatchModeLimit(limit, {
            runtimeMode: "full-access",
            interactionMode: "default",
          }) !== undefined
        )
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "The target thread runs above this caller's modes.",
          });
        yield* Ref.update(commands, (all) => [...all, command]);
        return { sequence: 1, storedEvents: [] };
      }),
  });
  const pending = PendingQuestions.layer.pipe(
    Layer.provide(Layer.mock(HostThreads.HostThreadsMcpService)({})),
    Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
    Layer.provide(threads),
    Layer.provide(NodeCrypto.layer),
  );
  return Inbox.layer.pipe(
    Layer.provide(Profiles.layer),
    Layer.provide(threads),
    Layer.provide(pending),
    Layer.provideMerge(
      Settings.layerTest({ goatclaw: { enabled: true, defaultProfile: "worker" } }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(NodeCrypto.layer),
  );
};

const answer = (caller: Inbox.DecisionCaller) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const result = yield* Effect.gen(function* () {
      yield* seed;
      const inbox = yield* Inbox.DecisionInbox;
      const item = (yield* inbox.list(person, {})).items[0]!;
      expect(item).toMatchObject({
        humanRequired: true,
        pending: { approval: { kind: "command" } },
      });
      return yield* inbox
        .answer(caller, { id: item.id, decision: "accept", reason: "Checked" })
        .pipe(Effect.result);
    }).pipe(Effect.provide(fixture(commands)));
    return { result, commands: yield* Ref.get(commands) };
  });

it.effect("a person answers a projected approval through the inbox without an approvals flag", () =>
  Effect.gen(function* () {
    const { result, commands } = yield* answer(person);
    expect(result).toMatchObject({ _tag: "Success" });
    expect(commands).toMatchObject([
      { type: "runtime-request.respond", decision: "accept", respondedBy: { type: "client" } },
    ]);
  }),
);

it.effect(
  "an approve-scoped outside client answers the same approval as through goat_pending_request_respond",
  () =>
    Effect.gen(function* () {
      const { result, commands } = yield* answer(outsideClient(true));
      expect(result._tag).toBe("Success");
      expect(commands).toMatchObject([
        { type: "runtime-request.respond", decision: "accept", respondedBy: { type: "client" } },
      ]);
    }),
);

it.effect("refuses an approval above an outside approver's own runtime ceiling", () =>
  Effect.gen(function* () {
    const { result, commands } = yield* answer(outsideClient(true, "auto-accept-edits"));
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "orchestration_error" } });
    expect(commands).toEqual([]);
  }),
);

it.effect("refuses an outside client without approvals and a thread credential", () =>
  Effect.gen(function* () {
    for (const caller of [outsideClient(false), threadAgent]) {
      const { result, commands } = yield* answer(caller);
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "capability_denied" } });
      expect(commands).toEqual([]);
    }
  }),
);
