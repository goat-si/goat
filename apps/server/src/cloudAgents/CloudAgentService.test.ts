import * as ServerSettings from "../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
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
import { McpSchema, McpServer } from "effect/ai";
import { TestClock } from "effect/testing";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadLaunchMcp from "../mcp/ThreadLaunchMcpService.ts";
import * as HomeRequests from "../provider/CodexHomeRequests.ts";
import * as Routing from "../provider/ProviderDiagnosisRouting.ts";
import * as HostSync from "../provider/ProviderHostSync.ts";
import * as Onboarding from "../provider/ProviderOnboarding.ts";
import { ProviderToolkit } from "../mcp/toolkits/provider/tools.ts";
import * as ProviderHandlers from "../mcp/toolkits/provider/handlers.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Project from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SshDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as CloudAgents from "./CloudAgentService.ts";

const SECRET = "sk-live-0123456789abcdefSECRET";
const projectId = ProjectId.make("project:goat");
const agent = "bc-1a2b3c4d-5e6f-7a8b-9c0d-112233445566";

const scope = (
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

interface World {
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
}

const makeWorld = (): World => ({
  readyDrivers: new Set(["cursorCloud"]),
  hosts: [],
  matrixFailure: undefined,
  matrixCalls: [],
  hostReads: [],
  hostWrites: [],
  launches: [],
  dispatched: [],
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
const storeCloudThread = (input: {
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

const layerFor = (world: World, profile?: string) => {
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
      snapshot: Effect.succeed({
        projects: [
          {
            id: projectId,
            deletedAt: null,
            repositoryIdentity: {
              canonicalKey: "github.com/goat-si/goat",
              locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
              owner: "goat-si",
              name: "goat",
            },
          },
        ],
      } as never),
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

const run = <A, E>(
  world: World,
  body: Effect.Effect<A, E, CloudAgents.CloudAgentService | ProjectionStore.ProjectionStoreV2>,
) => body.pipe(Effect.provide(layerFor(world)));

const full = Effect.succeed({ runtimeMode: "full-access", interactionMode: "default" } as const);

it.effect("probes holders once a minute, falls back for old runtimes, and drops gone hosts", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    world.hosts.push("new", "old", "down");
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const first = yield* service.holders(scope("full-access"), { provider: "cursorCloud" });
        assert.deepEqual(
          first.holders.map((holder) => [holder.host, holder.ready, holder.runtime]),
          [
            [null, true, "current"],
            ["down", false, "unreachable"],
            ["new", true, "current"],
            ["old", true, "update_required"],
          ],
        );
        assert.equal(first.holders[0]?.accountLabel, "Jun");
        assert.equal(first.holders[2]?.activeRuns, 3);
        assert.equal(
          world.matrixCalls.every((call) => call.localOnly === true && call.cloud === true),
          true,
        );
        assert.equal(
          world.hostReads
            .filter((read) => read.tool === "goat_provider_host_matrix")
            .every((read) => read.arguments.localOnly === true && read.arguments.cloud === true),
          true,
        );
        assert.deepEqual(
          world.hostReads.filter((read) => read.host === "old").map((read) => read.tool),
          ["goat_provider_host_matrix", "goat_cloud_holders", "goat_provider_diagnose"],
        );
        const reads = world.hostReads.length;
        yield* service.holders(scope("full-access"), { provider: "cursorCloud" });
        // Only the unreachable host is asked again within the minute.
        assert.deepEqual(world.hostReads.slice(reads), [
          {
            host: "down",
            tool: "goat_provider_host_matrix",
            arguments: { localOnly: true, cloud: true },
          },
        ]);
        yield* TestClock.adjust("61 seconds");
        yield* service.holders(scope("full-access"), { provider: "cursorCloud", refresh: true });
        world.hosts.splice(0, world.hosts.length);
        const alone = yield* service.holders(scope("full-access"), { provider: "cursorCloud" });
        assert.deepEqual(
          alone.holders.map((holder) => holder.host),
          [null],
        );
      }),
    );
  }),
);

it.effect("routes through the matrix cloud column and falls back when a host omits it", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    world.readyDrivers.clear();
    world.hosts.push("new", "aged");
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const table = yield* service.holders(scope("full-access"), { provider: "cursorCloud" });
        assert.deepEqual(
          table.holders.map((holder) => [
            holder.host,
            holder.ready,
            holder.runtime,
            holder.activeRuns,
          ]),
          [
            [null, false, "current", undefined],
            ["aged", true, "current", 0],
            ["new", true, "current", 3],
          ],
        );
        assert.equal(
          world.matrixCalls.every((call) => call.localOnly === true && call.cloud === true),
          true,
        );
        assert.deepEqual(
          world.hostReads.filter((read) => read.host === "aged").map((read) => read.tool),
          ["goat_provider_host_matrix", "goat_cloud_holders"],
        );
        assert.deepEqual(
          world.hostReads.filter((read) => read.host === "new").map((read) => read.tool),
          ["goat_provider_host_matrix"],
        );
        const dry = yield* service.launch(
          scope("full-access"),
          { provider: "cursorCloud", repo: "goat-si/goat", prompt: "Fix the flake", dryRun: true },
          full,
        );
        assert.equal(dry.holder.host, "aged");
        assert.equal(world.launches.length, 0);
      }),
    );
  }),
);

it.effect(
  "reports this environment not ready when its matrix fails, and an unreadable host as unreachable",
  () =>
    Effect.gen(function* () {
      const denied = makeWorld();
      denied.matrixFailure = "auth";
      yield* run(
        denied,
        Effect.gen(function* () {
          const service = yield* CloudAgents.CloudAgentService;
          const error = yield* service
            .holders(scope("full-access"), { local: true })
            .pipe(Effect.flip);
          assert.equal(error.code, "capability_denied");
        }),
      );
      const broken = makeWorld();
      broken.matrixFailure = "settings";
      broken.hosts.push("garbled");
      yield* run(
        broken,
        Effect.gen(function* () {
          const service = yield* CloudAgents.CloudAgentService;
          const holders = yield* service.holders(scope("full-access"), {});
          assert.deepEqual(
            holders.holders.map((holder) => [
              holder.host,
              holder.ready,
              holder.runtime,
              holder.reason,
            ]),
            [
              [null, false, "current", "Could not read this environment's provider settings."],
              [null, false, "current", "Could not read this environment's provider settings."],
              [null, false, "current", "Could not read this environment's provider settings."],
              [
                "garbled",
                false,
                "unreachable",
                "GOAT on garbled could not read its provider list.",
              ],
              [
                "garbled",
                false,
                "unreachable",
                "GOAT on garbled could not read its provider list.",
              ],
              [
                "garbled",
                false,
                "unreachable",
                "GOAT on garbled could not read its provider list.",
              ],
            ],
          );
          assert.deepEqual(broken.hostReads, [
            {
              host: "garbled",
              tool: "goat_provider_host_matrix",
              arguments: { localOnly: true, cloud: true },
            },
          ]);
        }),
      );
    }),
);

it.effect("launches on the chosen holder: dry run, a preferred host, and this environment", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    world.hosts.push("new", "old");
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const input = {
          provider: "cursorCloud",
          repo: "goat-si/goat",
          prompt: "Fix the flake",
        } as const;
        const dry = yield* service.launch(scope("full-access"), { ...input, dryRun: true }, full);
        assert.deepEqual([dry.dryRun, dry.holder.host], [true, null]);
        assert.equal(world.launches.length, 0);
        const refused = yield* service
          .launch(scope("full-access"), { ...input, holder: "old" }, full)
          .pipe(Effect.flip);
        assert.match(refused.message, /^Update GOAT on old/u);
        const remote = yield* service.launch(
          scope("full-access"),
          { ...input, holder: "new" },
          full,
        );
        assert.equal(remote.holder.host, "new");
        assert.deepEqual(world.hostWrites, [
          { host: "new", tool: "goat_cloud_launch", arguments: { ...input, holder: "local" } },
        ]);
        const local = yield* service.launch(scope("full-access"), input, full);
        assert.equal(local.holder.host, null);
        assert.deepEqual(world.launches[0]?.input, {
          projectId,
          title: "Cursor Cloud: Fix the flake",
          modelSelection: { instanceId: "cursorCloud", model: "composer-2" },
          workspaceStrategy: { type: "root" },
          message: "Fix the flake",
          standingInstructions: false,
        });
        const outdated = yield* service
          .launch(scope("full-access"), { ...input, provider: "claudeCloud" }, full)
          .pipe(Effect.flip);
        assert.match(outdated.message, /exist on old, but GOAT there is too old/u);
        world.hosts.splice(0, world.hosts.length);
        const noLogin = yield* service
          .launch(scope("full-access"), { ...input, provider: "claudeCloud" }, full)
          .pipe(Effect.flip);
        assert.match(noLogin.message, /No connected host holds a Claude Cloud login/u);
      }),
    );
  }),
);

it.effect("registers outside runs: validated, deduplicated, followed or link-only", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const base = { repo: "goat-si/goat", launchedBy: "Grok Bot" } as const;
        const bad = yield* service
          .register(
            scope("full-access"),
            { ...base, provider: "cursorCloud", url: "https://169.254.169.254/agents/bc-12345678" },
            full,
          )
          .pipe(Effect.flip);
        assert.equal(bad.code, "invalid_request");
        assert.equal(world.launches.length, 0);

        const followed = yield* service.register(
          scope("full-access"),
          { ...base, provider: "cursorCloud", externalId: agent, notifyWebhook: true },
          full,
        );
        assert.deepEqual([followed.created, followed.tracking], [true, "polled"]);
        assert.equal(followed.url, `https://cursor.com/agents/${agent}`);
        const launch = world.launches[0]!;
        assert.equal(launch.input.notifyWebhook, true);
        assert.equal(launch.cloudRun?.externalLauncher, "Grok Bot");
        assert.equal(launch.cloudRun?.importedNativeThread?.cloudTask?.attach, "registered");

        const again = yield* service.register(
          scope("full-access"),
          { ...base, provider: "cursorCloud", url: `https://cursor.com/agents/${agent}` },
          full,
        );
        assert.deepEqual([again.created, again.threadId], [false, followed.threadId]);
        assert.equal(world.launches.length, 1);

        const devin = yield* service.register(
          scope("full-access"),
          { ...base, provider: "devinCloud", externalId: "abc123def456" },
          full,
        );
        assert.equal(devin.tracking, "link-only");
        assert.isUndefined(world.launches[1]?.input.message);

        const claude = yield* service.register(
          scope("full-access"),
          { ...base, provider: "claudeCloud", externalId: "session_ABCdef123" },
          full,
        );
        assert.equal(claude.tracking, "link-only");
        assert.match(claude.note ?? "", /Not signed in/u);

        const listed = yield* service.list({});
        assert.deepEqual(
          listed.runs
            .map((entry) => [entry.provider, entry.tracking, entry.launchedBy, entry.registered])
            .toSorted(),
          [
            ["claudeCloud", "link-only", "Grok Bot", true],
            ["cursorCloud", "polled", "Grok Bot", true],
            ["devinCloud", "link-only", "Grok Bot", true],
          ],
        );
        assert.notInclude(JSON.stringify([followed, again, devin, claude, listed]), SECRET);

        // The caller's modes dropped while it waited: nothing starts.
        const downgraded = yield* service
          .register(
            scope("full-access"),
            { ...base, provider: "cursorCloud", externalId: "bc-0a1b2c3d4e5f6a7b" },
            Effect.fail(
              new OrchestratorMcpFailure({ code: "capability_denied", message: "Now plan mode." }),
            ),
          )
          .pipe(Effect.flip);
        assert.equal(downgraded.code, "capability_denied");
        assert.equal(world.launches.length, 3);
      }),
    );
  }),
);

it.effect("forgets only registered runs, by deleting their thread", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    yield* run(
      world,
      Effect.gen(function* () {
        const service = yield* CloudAgents.CloudAgentService;
        const registered = yield* service.register(
          scope("full-access"),
          {
            provider: "devinCloud",
            externalId: "abc123def456",
            repo: "goat-si/goat",
            launchedBy: "GOAT Bot",
          },
          full,
        );
        const own = ThreadId.make("thread:goat-launched");
        yield* storeCloudThread({
          threadId: own,
          title: "Launched here",
          driver: "cursorCloud",
          nativeId: agent,
          cloudTask: {
            taskId: "run-1",
            status: "running",
            tracking: "live",
            source: { repository: "https://github.com/goat-si/goat", branch: "dev" },
            localChangesExcluded: true,
            updatedAt: "2026-10-20T00:00:00.000Z",
          },
          active: true,
        });
        const refused = yield* service.forget({ threadId: own }).pipe(Effect.flip);
        assert.equal(refused.code, "invalid_request");
        assert.deepEqual(yield* service.forget({ threadId: registered.threadId }), {
          threadId: registered.threadId,
          forgotten: true,
        });
        assert.deepEqual(
          world.dispatched.map((command) => (command as { type: string; threadId: string }).type),
          ["thread.delete"],
        );
        assert.deepEqual(yield* service.forget({ threadId: ThreadId.make("thread:none") }), {
          threadId: ThreadId.make("thread:none"),
          forgotten: false,
        });
      }),
    );
  }),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "cloud-agents", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cloud-agents", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("MCP writes need a full-access caller; reads and dry runs answer without secrets", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const registered = McpHttpServer.toolkitRegistration(
      ProviderToolkit,
      ProviderHandlers.layer,
    ).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(liveThreadsLayer),
      Layer.provide(Layer.mock(HomeRequests.CodexHomeRequests)({})),
      Layer.provide(Layer.mock(Routing.ProviderDiagnosisRouting)({})),
      Layer.provide(Layer.mock(HostSync.ProviderHostSync)({})),
      Layer.provide(Layer.mock(Onboarding.ProviderOnboarding)({})),
      Layer.provide(layerFor(world)),
    );
    const call = (
      access: "read-only" | "approval-required" | "full-access",
      name: string,
      args: object,
    ) =>
      McpServer.McpServer.pipe(
        Effect.flatMap((server) => server.callTool({ name, arguments: args })),
        Effect.provideService(Invocation.McpInvocationContext, scope(access)),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
    yield* Effect.gen(function* () {
      const writes = [
        ["goat_cloud_launch", { provider: "cursorCloud", repo: "goat-si/goat", prompt: "x" }],
        [
          "goat_cloud_run_register",
          {
            provider: "devinCloud",
            externalId: "abc123def456",
            repo: "goat-si/goat",
            launchedBy: "Bot",
          },
        ],
        ["goat_cloud_run_forget", { threadId: "thread:any" }],
      ] as const;
      for (const access of ["read-only", "approval-required"] as const) {
        for (const [name, args] of writes) {
          const result = yield* call(access, name, args);
          assert.isTrue(result.isError, `${access} ${name}`);
          assert.include(JSON.stringify(result.content), "capability_denied");
        }
      }
      assert.equal(world.launches.length, 0);
      const outputs = [
        yield* call("read-only", "goat_cloud_holders", { local: true }),
        yield* call("read-only", "goat_cloud_run_list", {}),
        yield* call("full-access", "goat_cloud_launch", {
          provider: "cursorCloud",
          repo: "goat-si/goat",
          prompt: "x",
          dryRun: true,
        }),
      ];
      for (const output of outputs) assert.isFalse(output.isError);
      const text = JSON.stringify(outputs);
      assert.notInclude(text, SECRET);
      assert.notMatch(
        text,
        /sk-[A-Za-z0-9-]{16,}|ghp_[A-Za-z0-9]{20,}|"(?:apiKey|token|password)"/u,
      );
    }).pipe(Effect.provide(registered));
  }),
);

it.effect.each(["worker", "manager", "owner"])(
  "cloud launch checks profile %s before choosing or launching a holder",
  (profile) => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const service = yield* CloudAgents.CloudAgentService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO decision_items (id, title, context, options_json, required_profile, status, answer, answered_by, created_at, updated_at)
        VALUES ('go', 'Launch?', '', '[]', 'owner', 'answered', 'approve', 'client:phone', '2026-10-21', '2026-10-21')`;
      const input = {
        provider: "cursorCloud",
        repo: "goat-si/goat",
        prompt: "Inspect",
        holder: "local",
      } as const;
      if (profile === "owner") {
        const unapproved = yield* service
          .launch(scope("full-access"), input, full)
          .pipe(Effect.flip);
        assert.include(unapproved.message, "bills a paid account");
        assert.equal(world.launches.length, 0);
      }
      const result = yield* service
        .launch(scope("full-access"), { ...input, decisionId: "go" }, full)
        .pipe(Effect.result);
      if (profile === "owner") {
        assert.equal(result._tag, "Success");
        assert.equal(world.launches.length, 1);
      } else {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.code, "capability_denied");
        assert.equal(world.launches.length, 0);
        assert.equal(world.hostWrites.length, 0);
      }
    }).pipe(Effect.provide(layerFor(world, profile)));
  },
);

it.effect(
  "refuses an enabled remote cloud holder before forwarding outside the lane ledger",
  () => {
    const world = makeWorld();
    world.hosts.push("new");
    return Effect.gen(function* () {
      const service = yield* CloudAgents.CloudAgentService;
      const error = yield* service
        .launch(
          scope("full-access"),
          { provider: "cursorCloud", repo: "goat-si/goat", prompt: "Inspect", holder: "new" },
          full,
        )
        .pipe(Effect.flip);
      assert.equal(error.code, "capability_denied");
      assert.equal(world.hostWrites.length, 0);
      assert.equal(world.launches.length, 0);
    }).pipe(Effect.provide(layerFor(world, "owner")));
  },
);
