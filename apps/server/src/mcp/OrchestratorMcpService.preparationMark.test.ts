import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type CommandId,
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { derive } from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { PreparationClaims } from "../orchestration-v2/goat/PreparationClaims.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { layerOrchestratorServiceWith, layerTestClaims } from "./OrchestratorMcpService.testkit.ts";

const parentThreadId = ThreadId.make("thread:mcp-mark-parent");
const parentRunId = RunId.make("run:mcp-mark-parent");
const parentNodeId = NodeId.make("node:mcp-mark-root");
const taskId = NodeId.make("node:mcp-mark-task");
const codexInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: codexInstanceId, model: "gpt-5.4" };

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-mark"),
  requestNamespace: "provider-session:mcp-mark",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:mcp-mark",
    providerInstanceId: codexInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const provider: ServerProvider = {
  instanceId: codexInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const projection = (threadId: ThreadId, subagents: ReadonlyArray<unknown>) =>
  (threadId === parentThreadId
    ? {
        thread: {
          id: parentThreadId,
          projectId: ProjectId.make("project:mcp-mark"),
          title: "MCP parent",
          createdBy: "user",
          creationSource: "web",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        runs: [
          {
            id: parentRunId,
            ordinal: 1,
            status: "running",
            rootNodeId: parentNodeId,
            providerInstanceId: codexInstanceId,
            modelSelection,
          },
        ],
        contextTransfers: [],
        subagents,
      }
    : {
        thread: { id: threadId, title: "Child" },
        runs: [],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
        turnItems: [],
      }) as unknown as OrchestrationV2ThreadProjection;

/**
 * A delegation whose dispatch returns a child run that needs preparing, as a replay of a first call
 * with isolation "worktree" does. The call itself asks for no worktree and found no receipt (a
 * concurrent duplicate of that first call), so only an unconditional mark covers it.
 */
const delegateWithPreparingChild = (record: {
  readonly atDispatch: Ref.Ref<boolean | undefined>;
  readonly atPrepare: Ref.Ref<boolean | undefined>;
}) =>
  Effect.gen(function* () {
    const claims = yield* PreparationClaims;
    const accepted = yield* Ref.make<{ readonly child: ThreadId } | undefined>(undefined);
    const childOf = (commandId: CommandId) => derive.delegatedTaskThread({ commandId });
    const task = (child: ThreadId) => ({
      id: taskId,
      threadId: parentThreadId,
      runId: parentRunId,
      parentNodeId,
      origin: "app_owned",
      createdBy: "agent",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: codexInstanceId,
      providerThreadId: null,
      childThreadId: child,
      nativeTaskRef: null,
      prompt: "Summarize the diff.",
      title: null,
      model: "gpt-5.4",
      status: "running",
      result: null,
      startedAt: null,
      completedAt: null,
    });
    const layerDependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (threadId) =>
          Ref.get(accepted).pipe(
            Effect.map((done) =>
              projection(threadId, done === undefined ? [] : [task(done.child)]),
            ),
          ),
        hasReceipt: () => Effect.succeed(false),
        isProviderInstanceEnabledForProject: () => Effect.succeed(true),
        assertProviderInstanceEnabled: () => Effect.void,
        dispatch: (command) =>
          Effect.gen(function* () {
            const child = childOf(command.commandId);
            yield* Ref.set(record.atDispatch, yield* claims.isPending(child));
            yield* Ref.set(accepted, { child });
            return {
              sequence: 2,
              storedEvents: [
                {
                  sequence: 1,
                  commandId: null,
                  event: { type: "subagent.updated", payload: task(child) },
                },
                {
                  sequence: 2,
                  commandId: null,
                  event: {
                    type: "run.created",
                    threadId: child,
                    payload: {
                      id: RunId.make("run:mcp-mark-child"),
                      workspacePreparation: { type: "worktree", baseRef: "first-call-base" },
                    },
                  },
                },
              ],
            } as never;
          }),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
        refreshInstance: () => Effect.succeed([provider]),
      }),
      Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          list: () => Effect.succeed([codexInstanceId]),
          get: (instanceId) =>
            Effect.succeed({
              instanceId,
              getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
        }),
      ),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ServerSettings.layerTest(),
    );
    return yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const result = yield* service.delegateTask(scope, {
        task: "Summarize the diff.",
        target: { driverKind: ProviderDriverKind.make("codex") },
        mode: "async",
        clientRequestId: "delegate-mark-1",
      });
      assert.equal(result.status, "running");
      const done = yield* Ref.get(accepted);
      assert.isDefined(done);
      return done!.child;
    }).pipe(
      Effect.provide(
        layerOrchestratorServiceWith((launchClaims) => ({
          prepareRun: (input) =>
            launchClaims
              .isPending(input.threadId)
              .pipe(Effect.flatMap((marked) => Ref.set(record.atPrepare, marked))),
        })).pipe(
          Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
          Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
          Layer.provide(layerDependencies),
        ),
      ),
    );
  });

it.effect(
  "a delegation whose dispatch returns a child run to prepare marks the child although its own call asked for no worktree",
  () =>
    Effect.gen(function* () {
      const atDispatch = yield* Ref.make<boolean | undefined>(undefined);
      const atPrepare = yield* Ref.make<boolean | undefined>(undefined);
      yield* delegateWithPreparingChild({ atDispatch, atPrepare });
      assert.isTrue(yield* Ref.get(atPrepare));
    }).pipe(Effect.provide(layerTestClaims)),
);

it.effect(
  "a delegation holds its child's mark from before its dispatch and releases it when it returns",
  () =>
    Effect.gen(function* () {
      const claims = yield* PreparationClaims;
      const atDispatch = yield* Ref.make<boolean | undefined>(undefined);
      const atPrepare = yield* Ref.make<boolean | undefined>(undefined);
      const child = yield* delegateWithPreparingChild({ atDispatch, atPrepare });
      assert.isTrue(yield* Ref.get(atDispatch));
      assert.isFalse(yield* claims.isPending(child));
    }).pipe(Effect.provide(layerTestClaims)),
);
