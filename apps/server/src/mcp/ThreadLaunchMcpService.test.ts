import * as Sqlite from "../persistence/Sqlite.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type Project,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2CloudSourceRestriction,
} from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ThreadLaunchMcp from "./ThreadLaunchMcpService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelChildWork from "../channels/ChannelChildWork.ts";
import * as ChannelChildWorkStore from "../channels/channelChildWorkStore.ts";
import * as ChannelLedger from "../channels/ChannelLedger.ts";
import { taskEventIdFor } from "../channels/channelIds.ts";
import { seedChannelWorker } from "../channels/testkit/channelChildWorkFixture.ts";
import * as CloudSource from "../orchestration-v2/CloudTaskSourceService.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Reports from "../remoteReports/RemoteReportService.ts";
import * as Watches from "./LaunchWatchService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { newLaunchWatch } from "./launchWatch.ts";
import { goatclawRoleTemplate } from "../goatclaw/RoleTemplates.ts";
import { fakeCloudCapabilities } from "../orchestration-v2/testkit/FakeCloudAdapter.ts";

const projectId = ProjectId.make("project:cloud-launch");
const instanceId = ProviderInstanceId.make("fakeCloud");
const modelSelection = { instanceId, model: "fake" };
const callerId = ThreadId.make("thread:cloud-caller");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("env:cloud-launch"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "cloud-launch-ci",
  client: undefined,
  thread: { threadId: callerId, providerSessionId: "ps:caller", providerInstanceId: instanceId },
};
const caller = {
  id: callerId,
  projectId,
  modelSelection,
  providerInstanceId: instanceId,
  title: "Parent",
  activeRunId: "run:parent",
  runtimeMode: "full-access",
  interactionMode: "default",
  archivedAt: null,
  deletedAt: null,
} as OrchestrationV2ThreadShell;

/**
 * Builds the service as production builds it (the channel layer is fed in above its
 * construction, so a construction-time capture of ChannelChildWork would see nothing), then
 * seeds a channel task whose bound worker is the fixture's calling thread. Calls provided
 * with callContext resolve the channel layer per call.
 */
const withChannelAdmission = (
  f: ReturnType<typeof fixture>,
  threads: Partial<ThreadManagement.ThreadManagementService["Service"]> = {},
) =>
  Effect.gen(function* () {
    const buildScope = yield* Effect.scope;
    const serviceContext = yield* Layer.buildWithScope(f.layer, buildScope);
    const channelStack = ChannelChildWork.layer.pipe(
      Layer.provideMerge(ChannelChildWorkStore.layer),
      Layer.provideMerge(ChannelLedger.layer),
      Layer.provideMerge(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(caller),
          ...threads,
        }),
      ),
      Layer.provideMerge(Sqlite.layerMemory),
    );
    const channelContext = yield* Layer.buildWithScope(channelStack, buildScope);
    const taskId = yield* seedChannelWorker(callerId).pipe(Effect.provide(channelContext));
    const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService.pipe(
      Effect.provide(serviceContext),
    );
    const callContext = Context.merge(serviceContext, channelContext);
    return {
      service,
      launch: (
        message: string,
        extra: { readonly notifyTarget?: { readonly name: string } } = {},
      ) =>
        service
          .launch(
            scope,
            { title: "Cloud", message, standingInstructions: false, ...extra },
            { runtimeMode: "full-access", interactionMode: "default" },
          )
          .pipe(Effect.provide(callContext)),
      states: () =>
        ChannelChildWorkStore.ChannelChildWorkStore.pipe(
          Effect.flatMap((store) => store.listForTask(taskId)),
          Effect.map((records) => records.map((record) => record.state)),
          Effect.provide(channelContext),
        ),
      /** One pass of the owning task's child-work stop. */
      stop: () =>
        ChannelChildWork.ChannelChildWork.pipe(
          Effect.flatMap((childWork) =>
            childWork.cancelForTask({
              taskId,
              generation: 1,
              stopEventId: taskEventIdFor(taskId, 99),
              attempt: 0,
              reason: "Stopped.",
            }),
          ),
          Effect.provide(channelContext),
        ),
    };
  });

function fixture(
  unpublished = false,
  sourceRestriction: OrchestrationV2CloudSourceRestriction = "published-ref",
  registered?: Layer.Layer<ProviderRegistry.ProviderRegistry>,
  profile?: string,
  callerOverrides: Partial<OrchestrationV2ThreadShell> = {},
  behavior?: {
    readonly failLaunches?: boolean;
    readonly childThreadVisible?: boolean;
    /** The first launch creates its thread, then its first message is refused. */
    readonly createdThenRefused?: { readonly sql: () => SqlClient.SqlClient };
    readonly maxLanes?: number;
    /** Runs after admission, before the launch claims its reservation (needs notifyTarget). */
    readonly onRoute?: () => Effect.Effect<unknown>;
    /** Runs inside the launch, before the thread exists. */
    readonly onLaunch?: () => Effect.Effect<unknown>;
  },
) {
  let refusedOnce = false;
  const launched: ThreadLaunch.ThreadLaunchInput[] = [];
  const attempted: ThreadLaunch.ThreadLaunchInput[] = [];
  const sources: Parameters<CloudSource.CloudTaskSourceService["Service"]["resolve"]>[0][] = [];
  let routes = 0;
  const deps = Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest({
      goatclaw: {
        enabled: profile !== undefined,
        defaultProfile: profile ?? "worker",
        ...(profile === undefined || behavior?.maxLanes === undefined
          ? {}
          : {
              profiles: {
                [profile]: {
                  ...BUILTIN_PERMISSION_PROFILES[profile]!,
                  maxLanes: behavior.maxLanes,
                },
              },
            }),
      },
    }),
    ServerConfig.layerTest("/repo", { prefix: "goat-cloud-launch-ci-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId: ThreadId) =>
        Effect.succeed(
          behavior !== undefined && threadId !== callerId && behavior.childThreadVisible !== true
            ? null
            : ({ ...caller, ...callerOverrides } as OrchestrationV2ThreadShell),
        ),
    }),
    Layer.mock(Adapters.ProviderAdapterRegistryV2)({
      get: () =>
        Effect.succeed({
          instanceId,
          driver: ProviderDriverKind.make("fakeCloud"),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () => Effect.die("Launch admission does not open a provider session."),
          getCapabilities: () => {
            const capabilities = fakeCloudCapabilities();
            return Effect.succeed({
              ...capabilities,
              sessions: { ...capabilities.sessions, sourceRestriction },
            });
          },
        }),
    }),
    Layer.mock(CloudSource.CloudTaskSourceService)({
      resolve: (input) => {
        sources.push(input);
        return unpublished
          ? Effect.fail(new CloudSource.CloudTaskSourceError({ reason: "unpublished" }))
          : Effect.succeed({
              source: {
                repository: "https://github.com/acme/repo",
                branch: "dev",
                sha: "a".repeat(40),
              },
              localChangesExcluded: false,
              launchSource: { cwd: input.cwd, restriction: input.restriction ?? "published-ref" },
            });
      },
    }),
    Layer.mock(Projects.ProjectService)({
      getById: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            workspaceRoot: "/repo",
            defaultModelSelection: modelSelection,
          } as Project),
        ),
    }),
    Layer.mock(Folders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
    Layer.mock(Git.GitVcsDriver)({
      listWorktreePaths: () => Effect.succeed(["/repo", "/repo/worktree"]),
    }),
    Layer.mock(Reports.RemoteReportService)({}),
    Layer.mock(Watches.LaunchWatchService)({
      resolveRoute: () =>
        Effect.sync(() => {
          routes += 1;
          return { notifyWebhook: false, webhookTarget: null };
        }).pipe(Effect.tap(() => behavior?.onRoute?.() ?? Effect.void)),
      register: (input) =>
        Effect.succeed(
          newLaunchWatch({
            ...input,
            host: input.host ?? null,
            incarnation: "cloud-launch-test",
            notifyWebhook: input.notifyWebhook ?? false,
            now: 0,
          }),
        ),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: () => Effect.die("Cloud must bypass local branch collision checks"),
      launch: (input) =>
        Effect.sync(() => {
          attempted.push(input);
        }).pipe(
          Effect.andThen(() => behavior?.onLaunch?.() ?? Effect.void),
          Effect.andThen(
            behavior?.createdThenRefused !== undefined && !refusedOnce
              ? Effect.suspend(() => {
                  refusedOnce = true;
                  const sql = behavior.createdThenRefused!.sql();
                  return sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
                    VALUES (${input.threadId!}, ${projectId}, 'Refused', 'codex', 'full-access', 'default', '2026-10-21', '2026-10-21', '{}')`.pipe(
                    Effect.orDie,
                    Effect.andThen(
                      Effect.fail(
                        new ThreadLaunch.ThreadLaunchError({
                          operation: "dispatch-message",
                          commandId: input.commandId,
                          projectId: input.projectId,
                          cause: "The launcher may no longer start this work.",
                        }),
                      ),
                    ),
                  );
                })
              : behavior?.failLaunches === true
                ? Effect.fail(
                    new ThreadLaunch.ThreadLaunchError({
                      operation:
                        behavior.childThreadVisible === true
                          ? "dispatch-message"
                          : "resolve-project",
                      commandId: input.commandId,
                      projectId: input.projectId,
                      cause: new Error("fixture launch failure"),
                    }),
                  )
                : Effect.sync(() => {
                    launched.push(input);
                    return {
                      threadId: input.threadId,
                      resumed: false,
                      projection: {
                        thread: {
                          id: input.threadId,
                          projectId,
                          title: input.title,
                          modelSelection,
                        },
                        runs: [
                          {
                            id: "run:cloud-launched",
                            userMessageId: input.initialMessage?.messageId,
                            status: "starting",
                          },
                        ],
                      },
                    } as unknown as ThreadLaunch.ThreadLaunchResult;
                  }),
          ),
        ),
    }),
  );
  return {
    layer: ThreadLaunchMcp.layer.pipe(
      Layer.provide(registered === undefined ? deps : Layer.merge(deps, registered)),
      Layer.provideMerge(Sqlite.layerMemory),
    ),
    launched,
    attempted,
    sources,
    routes: () => routes,
  };
}

it.effect(
  "cloud launch resolves the published input before local output worktree validation",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
      yield* service.launch(
        scope,
        {
          title: "Cloud",
          message: "Inspect",
          standingInstructions: false,
          workspaceStrategy: { type: "worktree", baseRef: "dev", branch: "existing-local-branch" },
        },
        { runtimeMode: "full-access", interactionMode: "default" },
      );
      expect(f.sources).toEqual([{ cwd: "/repo", branch: "dev", restriction: "published-ref" }]);
      expect(f.launched).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect.each(["published-ref", "project-folder"] as const)(
  "cloud launch chooses the source folder for %s with an existing output worktree",
  (restriction) => {
    const f = fixture(false, restriction);
    return Effect.gen(function* () {
      const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
      yield* service.launch(
        scope,
        {
          title: "Cloud",
          message: "Inspect",
          standingInstructions: false,
          workspaceStrategy: {
            type: "existing_worktree",
            worktreePath: "/repo/worktree",
            branch: "feature",
          },
        },
        { runtimeMode: "full-access", interactionMode: "default" },
      );
      expect(f.sources).toEqual([
        {
          cwd: restriction === "project-folder" ? "/repo" : "/repo/worktree",
          branch: "feature",
          restriction,
        },
      ]);
      expect(f.launched).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("unpublished cloud input refuses before thread creation or watch route binding", () => {
  const f = fixture(true);
  return Effect.gen(function* () {
    const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
    const error = yield* service
      .launch(
        scope,
        {
          title: "Cloud",
          message: "Inspect",
          standingInstructions: false,
          notifyTarget: { name: "ci-only" },
        },
        { runtimeMode: "full-access", interactionMode: "default" },
      )
      .pipe(Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toBe("Push this branch before starting a cloud task.");
    expect(f.launched).toHaveLength(0);
    expect(f.routes()).toBe(0);
  }).pipe(Effect.provide(f.layer));
});
it.effect("a lapsed caller session is refused with its reason before a thread exists", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
    const error = yield* service
      .launch(
        {
          ...scope,
          grantedScopes: ["orchestration:operate", "memory:read"],
          reauthorize: (required) =>
            Effect.fail(
              new EnvironmentAuthorizationError({
                message: "The MCP session is no longer active.",
                requiredScope: required[0] ?? "memory:read",
              }),
            ),
        },
        { title: "Cloud", message: "Inspect" },
        { runtimeMode: "full-access", interactionMode: "default" },
      )
      .pipe(Effect.flip);
    expect(error.code).toBe("capability_denied");
    expect(error.message).toBe("The MCP session is no longer active.");
    expect(f.launched).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});
it.effect("explicit cloud scratch rejects before a Scratch folder or thread can be created", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
    const error = yield* service
      .launch(
        scope,
        { title: "Cloud", scratch: true, modelSelection },
        { runtimeMode: "full-access", interactionMode: "default" },
      )
      .pipe(Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(f.sources).toHaveLength(0);
    expect(f.launched).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([
    { instanceId, models: [{ slug: "fake" }] },
  ] as unknown as ReadonlyArray<never>),
  refreshInstance: () =>
    Effect.succeed([{ instanceId, models: [{ slug: "fake" }] }] as unknown as ReadonlyArray<never>),
});

it.effect(
  "a requested model or provider this environment lacks is refused before a thread exists",
  () => {
    const f = fixture(false, "published-ref", registry);
    return Effect.gen(function* () {
      const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
      const launch = (selection: { instanceId: ProviderInstanceId; model: string }) =>
        service
          .launch(
            scope,
            { title: "Probe", message: "Hi", modelSelection: selection },
            { runtimeMode: "full-access", interactionMode: "default" },
          )
          .pipe(Effect.flip);
      const model = yield* launch({ instanceId, model: "nonexistent" });
      expect(model.code).toBe("invalid_request");
      expect(model.message).toContain(
        "does not offer model nonexistent, even after refreshing its model list",
      );
      expect(model.message).toContain(
        'goat_call {path:"provider.diagnose", args:{instanceId:"fakeCloud"}}',
      );
      const provider = yield* launch({
        instanceId: ProviderInstanceId.make("gone"),
        model: "fake",
      });
      expect(provider.code).toBe("invalid_request");
      expect(provider.message).toContain("no provider instance gone; it has fakeCloud");
      expect(f.launched).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("a model the provider gained since the last probe is accepted after one refresh", () => {
  // The cached catalog predates the provider's own catalog change, as after `ocx sync`.
  let catalog = [{ instanceId, models: [{ slug: "fake" }] }];
  const refreshes: string[] = [];
  const stale = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.sync(() => catalog as unknown as ReadonlyArray<never>),
    refreshInstance: (id) =>
      Effect.sync(() => {
        refreshes.push(id);
        catalog = [{ instanceId, models: [{ slug: "fake" }, { slug: "added" }] }];
        return catalog as unknown as ReadonlyArray<never>;
      }),
  });
  const f = fixture(false, "published-ref", stale);
  return Effect.gen(function* () {
    const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
    const launch = (model: string) =>
      service.launch(
        scope,
        { title: "Probe", message: "Hi", modelSelection: { instanceId, model } },
        { runtimeMode: "full-access", interactionMode: "default" },
      );
    yield* launch("added");
    expect(refreshes).toEqual([instanceId]);
    expect(f.launched.map((input) => input.modelSelection.model)).toEqual(["added"]);
    // A model the cache already lists launches without another probe.
    yield* launch("fake");
    expect(refreshes).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect.each(["worker", "owner"])(
  "thread launch cannot bypass the cloud capability through profile %s",
  (profile) => {
    const f = fixture(false, "published-ref", undefined, profile);
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${callerId}, ${projectId}, 'Caller', 'codex', 'full-access', 'default', '2026-10-21', '2026-10-21', '{}')`;
      const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
      const launch = service
        .launch(
          scope,
          { title: "Cloud", message: "Inspect", standingInstructions: false },
          { runtimeMode: "full-access", interactionMode: "default" },
        )
        .pipe(Effect.result);
      if (profile === "owner") {
        const unrequested = yield* launch;
        const refusal = unrequested._tag === "Failure" ? unrequested.failure.message : "";
        expect(refusal).toContain("bills a paid account");
        // The advice must name a route this tool's caller can take; this tool takes no decisionId.
        expect(refusal).toContain('goat_call {path:"cloud_agent.launch"}');
        expect(refusal).not.toContain("decisionId");
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('caller-run', ${callerId}, 1, 'codex', 'running', '2026-10-21', '{"userMessageId":"caller-message"}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('caller-message', ${callerId}, 'caller-run', 'user', 0, '2026-10-21', '2026-10-21', '{"createdBy":"user","creationSource":"web"}')`;
      }
      const result = yield* launch;
      if (profile === "worker") {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.code).toBe("capability_denied");
        expect(f.launched).toHaveLength(0);
      } else {
        expect(result._tag).toBe("Success");
        expect(f.launched).toHaveLength(1);
        expect(yield* sql`SELECT profile_id FROM goatclaw_thread_profiles`).toEqual([
          { profile_id: "owner" },
        ]);
      }
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("a goatclaw role launch carries the role's brief and binds the role's profile", () => {
  const f = fixture(false, "published-ref", undefined, "owner");
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${callerId}, ${projectId}, 'Caller', 'codex', 'full-access', 'default', '2026-10-21', '2026-10-21', '{}')`;
    // The fixture's adapter is a cloud one, which goatclaw admits only in a turn a person started.
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
    VALUES ('caller-run', ${callerId}, 1, 'codex', 'running', '2026-10-21', '{"userMessageId":"caller-message"}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
    VALUES ('caller-message', ${callerId}, 'caller-run', 'user', 0, '2026-10-21', '2026-10-21', '{"createdBy":"user","creationSource":"web"}')`;
    const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
    const launch = (message: string | undefined) =>
      service.launch(
        scope,
        {
          title: "Merge queue",
          goatclawRole: "merge-manager",
          standingInstructions: false,
          ...(message === undefined ? {} : { message }),
        },
        { runtimeMode: "full-access", interactionMode: "default" },
      );
    expect((yield* launch(undefined).pipe(Effect.flip)).code).toBe("invalid_request");
    yield* launch("Land #701.");
    const text = f.launched[0]?.initialMessage?.text ?? "";
    expect(text.startsWith(goatclawRoleTemplate("merge-manager").preamble)).toBe(true);
    expect(text.endsWith("Land #701.")).toBe(true);
    expect(yield* sql`SELECT profile_id FROM goatclaw_thread_profiles`).toEqual([
      { profile_id: "merge-manager" },
    ]);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "a role launch whose work the caller's profile cannot do is refused before anything starts",
  () => {
    const f = fixture(false, "published-ref", undefined, "manager");
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${callerId}, ${projectId}, 'Caller', 'codex', 'full-access', 'default', '2026-10-21', '2026-10-21', '{}')`;
      const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
      const error = yield* service
        .launch(
          scope,
          { title: "Merge queue", goatclawRole: "merge-manager", message: "Land #701." },
          { runtimeMode: "full-access", interactionMode: "default" },
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        code: "capability_denied",
        message:
          "A merge-manager launch needs pr.merge, which this caller's profile does not allow.",
      });
      expect(f.launched).toHaveLength(0);
      expect(yield* sql`SELECT id FROM goatclaw_lane_reservations`).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "regression #493: a launch refused after its thread was created holds no lane while that thread does not run",
  () => {
    let sqlRef: SqlClient.SqlClient | undefined;
    const f = fixture(
      false,
      "published-ref",
      undefined,
      "owner",
      {},
      {
        createdThenRefused: { sql: () => sqlRef! },
        maxLanes: 1,
      },
    );
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      sqlRef = sql;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${callerId}, ${projectId}, 'Caller', 'codex', 'full-access', 'default', '2026-10-21', '2026-10-21', '{}')`;
      // The fixture's adapter is a cloud one, which goatclaw admits only in a turn a person started.
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
    VALUES ('caller-run', ${callerId}, 1, 'codex', 'running', '2026-10-21', '{"userMessageId":"caller-message"}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
    VALUES ('caller-message', ${callerId}, 'caller-run', 'user', 0, '2026-10-21', '2026-10-21', '{"createdBy":"user","creationSource":"web"}')`;
      const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
      const launch = (message: string) =>
        service.launch(
          scope,
          { title: "Cloud", message, standingInstructions: false },
          { runtimeMode: "full-access", interactionMode: "default" },
        );
      yield* launch("Refused after its thread exists").pipe(Effect.flip);
      // The refused thread has no run, so the profile's only lane is free for the next launch.
      yield* launch("Inspect");
      expect(f.launched).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("role launches are refused while goatclaw is off", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
    const error = yield* service
      .launch(
        scope,
        { title: "Sweep", goatclawRole: "issue-sweeper", message: "Triage." },
        { runtimeMode: "full-access", interactionMode: "default" },
      )
      .pipe(Effect.flip);
    expect(error.code).toBe("capability_denied");
    expect(f.launched).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "thread launch prefers the caller model over the project and an explicit model over the caller",
  () => {
    const callerModel = { instanceId, model: "caller-model" };
    const explicitModel = { instanceId, model: "explicit-model" };
    const registered = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([
        {
          instanceId,
          models: [{ slug: "fake" }, { slug: "caller-model" }, { slug: "explicit-model" }],
        },
      ] as unknown as ReadonlyArray<never>),
    });
    const f = fixture(false, "published-ref", registered, undefined, {
      modelSelection: callerModel,
    });
    return Effect.gen(function* () {
      const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
      yield* service.launch(
        scope,
        { title: "Inherited", standingInstructions: false },
        { runtimeMode: "full-access", interactionMode: "default" },
      );
      yield* service.launch(
        scope,
        { title: "Explicit", standingInstructions: false, modelSelection: explicitModel },
        { runtimeMode: "full-access", interactionMode: "default" },
      );
      expect(f.launched.map((input) => input.modelSelection)).toEqual([callerModel, explicitModel]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("thread launch forwards the caller runtime ceiling despite a full-access request", () => {
  const f = fixture(false, "published-ref", undefined, "owner", {
    runtimeMode: "approval-required",
  });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${callerId}, ${projectId}, 'Caller', 'codex', 'approval-required', 'default', '2026-10-21', '2026-10-21', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('caller-run', ${callerId}, 1, 'codex', 'running', '2026-10-21', '{"userMessageId":"caller-message"}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('caller-message', ${callerId}, 'caller-run', 'user', 0, '2026-10-21', '2026-10-21', '{"createdBy":"user","creationSource":"web"}')`;
    const service = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
    yield* service.launch(
      scope,
      { title: "Child", standingInstructions: false, runtimeMode: "full-access" },
      { runtimeMode: "full-access", interactionMode: "default" },
    );
    expect(f.launched).toHaveLength(1);
    expect(f.launched[0]?.runtimeMode).toBe("approval-required");
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "a channel-owned caller admits launches against its descendant budget although the service was built without the channel layer",
  () => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const setup = yield* withChannelAdmission(f);
        yield* setup.launch("Inspect one");
        yield* setup.launch("Inspect two");
        yield* setup.launch("Inspect three");
        yield* setup.launch("Inspect four");
        const error = yield* Effect.flip(setup.launch("Inspect five"));
        expect(error).toMatchObject({ code: "capacity_exceeded" });
        expect(f.launched).toHaveLength(4);
      }),
    );
  },
);

it.effect(
  "a launch failure after the thread committed keeps the slot bound instead of double-spending capacity",
  () => {
    const f = fixture(
      false,
      "published-ref",
      undefined,
      undefined,
      {},
      {
        failLaunches: true,
        childThreadVisible: true,
      },
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const setup = yield* withChannelAdmission(f);
        const first = yield* Effect.flip(setup.launch("Inspect one"));
        const second = yield* Effect.flip(setup.launch("Inspect two"));
        const third = yield* Effect.flip(setup.launch("Inspect three"));
        const fourth = yield* Effect.flip(setup.launch("Inspect four"));
        expect(first).toMatchObject({ code: "orchestration_error" });
        expect(second).toMatchObject({ code: "orchestration_error" });
        expect(third).toMatchObject({ code: "orchestration_error" });
        expect(fourth).toMatchObject({ code: "orchestration_error" });
        // All four failures committed their threads, so all four slots stay held.
        const fifth = yield* Effect.flip(setup.launch("Inspect five"));
        expect(fifth).toMatchObject({ code: "capacity_exceeded" });
        expect(f.attempted).toHaveLength(4);
        expect(yield* setup.states()).toEqual(["bound", "bound", "bound", "bound"]);
      }),
    );
  },
);

it.effect("a launch failure before the thread existed releases the reservation", () => {
  const f = fixture(false, "published-ref", undefined, undefined, {}, { failLaunches: true });
  return Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* withChannelAdmission(f);
      for (const label of ["one", "two", "three", "four", "five"]) {
        const failed = yield* Effect.flip(setup.launch("Inspect " + label));
        expect(failed).toMatchObject({ code: "orchestration_error" });
      }
      expect(f.attempted).toHaveLength(5);
      expect(yield* setup.states()).toEqual([
        "released",
        "released",
        "released",
        "released",
        "released",
      ]);
    }),
  );
});

it.effect(
  "regression #1387: a task stop before the launch claims its slot launches nothing",
  () => {
    let beforeClaim: Effect.Effect<unknown> = Effect.void;
    const f = fixture(
      false,
      "published-ref",
      undefined,
      undefined,
      {},
      {
        onRoute: () => beforeClaim,
      },
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const setup = yield* withChannelAdmission(f);
        beforeClaim = setup.stop().pipe(Effect.orDie);
        const error = yield* Effect.flip(setup.launch("Inspect", { notifyTarget: { name: "ci" } }));
        expect(error).toMatchObject({ code: "orchestration_error" });
        expect(f.attempted).toHaveLength(0);
        expect(yield* setup.states()).toEqual(["released"]);
      }),
    );
  },
);

it.effect(
  "regression #1387: a task stop during the launch waits for the thread, then stops it",
  () => {
    let duringLaunch: Effect.Effect<unknown> = Effect.void;
    const outcomes: Array<string> = [];
    const stopped: Array<string> = [];
    const f = fixture(
      false,
      "published-ref",
      undefined,
      undefined,
      {},
      {
        onLaunch: () => duringLaunch,
      },
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const setup = yield* withChannelAdmission(f, {
          // The child thread exists only once the launch has created it.
          dispatch: ((command: { readonly threadId: string }) =>
            f.launched.length === 0
              ? Effect.fail({ _tag: "ProjectionStoreThreadNotFoundError" })
              : Effect.sync(() => {
                  stopped.push(command.threadId);
                  return { sequence: 0, storedEvents: [] };
                })) as never,
        });
        duringLaunch = setup.stop().pipe(
          Effect.tap((outcome) => Effect.sync(() => outcomes.push(outcome))),
          Effect.orDie,
        );
        const launched = yield* setup.launch("Inspect");
        // The stop raced the thread's creation, so it neither settled the record nor freed its slot.
        expect(outcomes).toEqual(["retry"]);
        expect(yield* setup.states()).toEqual(["bound"]);
        expect(yield* setup.stop()).toBe("settled");
        expect(stopped).toEqual([launched.threadId]);
        expect(yield* setup.states()).toEqual(["cancelled"]);
      }),
    );
  },
);
