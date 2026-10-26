/**
 * The cloud agent service over fake holders, projects and launches, for its tests.
 *
 * @module CloudAgentService.testkit
 */
import * as ServerSettings from "../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  EventId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CloudTask,
  OrchestratorMcpFailure,
  ProjectId,
  type ProviderDiagnosis,
  ProviderDriverKind,
  ProviderHostSyncError,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as ThreadLaunchMcp from "../mcp/ThreadLaunchMcpService.ts";
import * as HostSync from "../provider/ProviderHostSync.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Project from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SshDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import * as CloudAgents from "./CloudAgentService.ts";

export const SECRET = "sk-live-0123456789abcdefSECRET";
export const projectId = ProjectId.make("project:goat");
const GOAT_IDENTITY = {
  canonicalKey: "github.com/goat-si/goat",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
  owner: "goat-si",
  name: "goat",
} as const;
export const agent = "bc-1a2b3c4d-5e6f-7a8b-9c0d-112233445566";

export const scope = (
  access: "read-only" | "approval-required" | "full-access",
): Invocation.McpInvocationScope => ({
  environmentId: EnvironmentId.make("macmini"),
  requestNamespace: `test:${access}`,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: access, label: "Grok Bot", access },
});

const ready = (driver: string): ProviderDiagnosis => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  configured: true,
  ready: true,
  checks: [{ id: "auth", status: "pass", summary: "Signed in." }],
});
const cloudCell = (driver: string, ready: boolean, activeRuns = 0) =>
  ready
    ? {
        ready: true,
        instanceId: ProviderInstanceId.make(driver),
        ...(driver === "cursorCloud" ? { accountLabel: "Jun" } : {}),
        activeRuns,
      }
    : { ready: false, reason: "Not signed in." };

const localCloud = (readyDrivers: ReadonlySet<string>) => ({
  claudeCloud: cloudCell("claudeCloud", readyDrivers.has("claudeCloud")),
  cursorCloud: cloudCell("cursorCloud", readyDrivers.has("cursorCloud")),
  devinCloud: cloudCell("devinCloud", readyDrivers.has("devinCloud")),
});

export interface World {
  readonly readyDrivers: Set<string>;
  readonly hosts: Array<string>;
  matrixFailure: "settings" | "auth" | undefined;
  readonly matrixCalls: Array<{
    readonly localOnly: boolean | undefined;
    readonly cloud: boolean | undefined;
  }>;
  readonly hostReads: Array<{
    host: string;
    tool: string;
    arguments: Record<string, unknown>;
  }>;
  readonly hostWrites: Array<{ host: string; tool: string; arguments: Record<string, unknown> }>;
  readonly launches: Array<{
    input: Record<string, unknown>;
    cloudRun: ThreadLaunchMcp.CloudRunLaunch | undefined;
  }>;
  readonly dispatched: Array<unknown>;
  /** The snapshot's identity cache is cold or expired; only an awaited lookup knows the origin. */
  coldIdentity: boolean;
  readonly identityLookups: Array<string>;
  /** The branch checked out in the project folder. */
  checkedOut: string;
}

export const makeWorld = (): World => ({
  readyDrivers: new Set(["cursorCloud"]),
  hosts: [],
  matrixFailure: undefined,
  matrixCalls: [],
  hostReads: [],
  hostWrites: [],
  launches: [],
  dispatched: [],
  coldIdentity: false,
  identityLookups: [],
  checkedOut: "main",
});

const appThread = (threadId: ThreadId, title: string, externalLauncher?: string) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    return {
      createdBy: "agent",
      creationSource: "mcp",
      id: threadId,
      projectId,
      title,
      providerInstanceId: ProviderInstanceId.make("cursorCloud"),
      modelSelection: { instanceId: ProviderInstanceId.make("cursorCloud"), model: "default" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      ...(externalLauncher === undefined ? {} : { externalLauncher }),
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    } satisfies OrchestrationV2AppThread;
  });

/** Stands in for the orchestrator: records the thread and its cloud task as the launch would. */
export const storeCloudThread = (input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly driver: string;
  readonly nativeId: string;
  readonly cloudTask: OrchestrationV2CloudTask;
  readonly externalLauncher?: string;
  readonly active: boolean;
}) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make(`event:${input.threadId}:thread`),
      type: "thread.created",
      threadId: input.threadId,
      occurredAt: now,
      payload: yield* appThread(input.threadId, input.title, input.externalLauncher),
    });
    yield* store.apply({
      id: EventId.make(`event:${input.threadId}:provider`),
      type: "provider-thread.updated",
      threadId: input.threadId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make(`pt:${input.threadId}`),
        driver: ProviderDriverKind.make(input.driver),
        providerInstanceId: ProviderInstanceId.make(input.driver),
        providerSessionId: null,
        appThreadId: input.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: ProviderDriverKind.make(input.driver),
          nativeId: input.nativeId,
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: input.active ? "active" : "not_loaded",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        cloudTask: input.cloudTask,
        createdAt: now,
        updatedAt: now,
      },
    } as never);
  });

export const layerFor = (world: World, profile?: string) => {
  const store = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
  const deps = Layer.mergeAll(
    Layer.mock(HostSync.ProviderHostSync)({
      matrix: (input) => {
        world.matrixCalls.push({ localOnly: input.localOnly, cloud: input.cloud });
        if (world.matrixFailure === "auth")
          return Effect.fail(
            new EnvironmentAuthorizationError({
              message: "Installing a provider needs a person's approval.",
              requiredScope: "providers:manage",
            }),
          );
        if (world.matrixFailure === "settings")
          return Effect.fail(
            new ProviderHostSyncError({ code: "unavailable", detail: "The matrix is down." }),
          );
        return Effect.succeed({
          rows: [
            {
              host: null,
              status: "ok" as const,
              providers: [],
              cloud: localCloud(world.readyDrivers),
            },
          ],
        });
      },
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([
        {
          instanceId: ProviderInstanceId.make("cursorCloud"),
          auth: { status: "authenticated", label: "Jun", profileId: SECRET, workspaceId: SECRET },
          models: [{ slug: "composer-2", isDefault: true }],
        },
      ] as never),
    }),
    Layer.mock(HostThreads.HostThreadsMcpService)({
      readOnHost: (_scope, input, decode) =>
        Effect.gen(function* () {
          world.hostReads.push({
            host: input.host,
            tool: input.tool,
            arguments: { ...input.arguments },
          });
          if (input.host === "down")
            return yield* new OrchestratorMcpFailure({
              code: "host_unavailable",
              message: "down timed out",
            });
          if (input.host === "garbled")
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "GOAT on garbled could not read its provider list.",
            });
          if (input.host === "old" && input.tool === "goat_provider_host_matrix")
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "GOAT on old does not have goat_provider_host_matrix; it runs 0.1.0.",
            });
          if (input.host === "old" && input.tool === "goat_cloud_holders")
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "GOAT on old does not have goat_cloud_holders; it runs 0.1.0.",
            });
          const raw =
            input.tool === "goat_provider_host_matrix"
              ? input.host === "aged"
                ? { rows: [{ host: null, status: "ok", providers: [] }] }
                : {
                    rows: [
                      {
                        host: null,
                        status: "ok",
                        providers: [],
                        cloud: {
                          claudeCloud: { ready: false, reason: "Not signed in." },
                          cursorCloud: {
                            ready: true,
                            instanceId: "cursorCloud",
                            activeRuns: 3,
                          },
                          devinCloud: { ready: false, reason: "Not signed in." },
                        },
                      },
                    ],
                  }
              : input.tool === "goat_cloud_holders"
                ? {
                    holders: [
                      {
                        provider: "cursorCloud",
                        host: null,
                        ready: true,
                        runtime: "current",
                        activeRuns: input.host === "aged" ? 0 : 3,
                      },
                    ],
                  }
                : { checkedBy: "server", diagnoses: [ready(String(input.arguments.driver))] };
          const decoded = yield* decode(raw).pipe(Effect.orDie);
          return { ...decoded, host: input.host };
        }),
      writeOnHost: (_scope, input, decode) =>
        Effect.gen(function* () {
          world.hostWrites.push({
            host: input.host,
            tool: input.tool,
            arguments: { ...input.arguments },
          });
          const decoded = yield* decode({
            holder: { provider: "cursorCloud", host: null, ready: true, runtime: "current" },
            dryRun: false,
            threadId: "thread:remote",
          }).pipe(Effect.orDie);
          return { ...decoded, host: input.host };
        }),
    }),
    Layer.mock(SshDispatch.SshRemoteDispatch)({
      connectedHosts: Effect.sync(() => [...world.hosts]),
    }),
    Layer.mock(Project.ProjectService)({
      snapshot: Effect.sync(
        () =>
          ({
            projects: [
              {
                id: projectId,
                workspaceRoot: "/fixture/goat",
                deletedAt: null,
                repositoryIdentity: world.coldIdentity ? null : GOAT_IDENTITY,
              },
            ],
          }) as never,
      ),
      awaitRepositoryIdentity: (workspaceRoot) =>
        Effect.sync(() => {
          world.identityLookups.push(workspaceRoot);
          return GOAT_IDENTITY;
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => {
          world.dispatched.push(command);
          return {} as never;
        }),
    }),
  );
  const launches = Layer.effect(
    ThreadLaunchMcp.ThreadLaunchMcpService,
    Effect.gen(function* () {
      const context = yield* Effect.context<ProjectionStore.ProjectionStoreV2>();
      return ThreadLaunchMcp.ThreadLaunchMcpService.of({
        launch: (_scope, input, _modes, cloudRun) =>
          Effect.gen(function* () {
            world.launches.push({ input: { ...input }, cloudRun });
            const threadId =
              cloudRun?.threadId ?? ThreadId.make(`thread:launch:${world.launches.length}`);
            const imported = cloudRun?.importedNativeThread;
            if (imported?.cloudTask !== undefined) {
              const following = input.message !== undefined;
              yield* storeCloudThread({
                threadId,
                title: input.title,
                driver: imported.ref.driver,
                nativeId: imported.ref.nativeId,
                cloudTask: following
                  ? { ...imported.cloudTask, acceptedAppRunId: "run:attach" as never }
                  : imported.cloudTask,
                ...(cloudRun?.externalLauncher === undefined
                  ? {}
                  : { externalLauncher: cloudRun.externalLauncher }),
                active: following,
              });
            }
            return { threadId, projectId } as never;
          }).pipe(Effect.provideContext(context), Effect.orDie),
      });
    }),
  );
  return CloudAgents.layer.pipe(
    Layer.provide(
      DecisionInbox.layer.pipe(
        Layer.provide(Profiles.layer),
        Layer.provide(Layer.mock(PendingQuestions.PendingQuestionsMcpService)({})),
      ),
    ),
    Layer.provide(Layer.mock(Handoffs.Handoffs)({})),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        statusDetailsLocal: () =>
          Effect.sync(() => ({ isRepo: true, branch: world.checkedOut }) as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("macmini")),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        goatclaw: { enabled: profile !== undefined, defaultProfile: profile ?? "worker" },
      }),
    ),
    Layer.provide(launches),
    Layer.provide(deps),
    Layer.provideMerge(store),
    Layer.provide(NodeServices.layer),
  );
};

export const run = <A, E>(
  world: World,
  body: Effect.Effect<
    A,
    E,
    CloudAgents.CloudAgentService | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
  >,
) => body.pipe(Effect.provide(layerFor(world)));

export const full = Effect.succeed({
  runtimeMode: "full-access",
  interactionMode: "default",
} as const);
