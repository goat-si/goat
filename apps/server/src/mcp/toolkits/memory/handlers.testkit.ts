import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
// eslint-disable-next-line goat/no-raw-mcp-registration -- Test harness calls only toolkits registered through McpHttpServer.toolkitRegistration.
import { McpSchema, McpServer } from "effect/ai";
import { listedToolName, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import { ToolDispatch } from "../../ToolDispatch.ts";
import { dispatchEnvelope } from "../agentSurface/dispatchEnvelope.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import profileMigration from "../../../persistence/Migrations/098_PermissionProfiles.ts";
import migration from "../../../persistence/Migrations/077_Memory.ts";
import searchMigration from "../../../persistence/Migrations/079_MemorySearchCounters.ts";
import hubMigration from "../../../persistence/Migrations/078_MemoryHubSync.ts";
import lineageMigration from "../../../persistence/Migrations/081_MemoryImportLineage.ts";
import checkpointMigration from "../../../persistence/Migrations/082_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../../../persistence/Migrations/094_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../../../persistence/Migrations/083_MemoryReportLifecycle.ts";
import usageMigration from "../../../persistence/Migrations/084_MemoryUsageCounters.ts";
import revertMigration from "../../../persistence/Migrations/085_MemoryRevertResults.ts";
import readyMigration from "../../../persistence/Migrations/087_MemoryLastReadySpace.ts";
import administeredMigration from "../../../persistence/Migrations/088_MemoryHubAdministered.ts";
import * as RepositoryResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Store from "../../../memory/MemoryStore.ts";
import * as Quota from "../../../memory/MemoryQuotaService.ts";
import * as Service from "../../../memory/MemoryService.ts";
import * as Sync from "../../../memory/MemorySyncService.ts";
import * as MemorySettings from "../../../memory/MemorySettingsService.ts";
import * as Hub from "../../../memory/MemoryHubService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as Config from "../../../config.ts";
import * as Secrets from "../../../auth/ServerSecretStore.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const space = M.MemorySpaceId.make(id(1));
export const memoryId = M.MemoryId.make(id(2));
const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(M.EnvironmentId.make("fixture-memory-mcp")),
});
const database = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(searchMigration),
    Effect.andThen(lineageMigration),
    Effect.andThen(checkpointMigration),
    Effect.andThen(revisionSizeMigration),
    Effect.andThen(reportMigration),
    Effect.andThen(usageMigration),
    Effect.andThen(revertMigration),
    Effect.andThen(readyMigration),
    Effect.andThen(administeredMigration),
  ),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const storage = Store.layer.pipe(Layer.provideMerge(database));
const makeCore = <E, R>(
  serviceLayer: typeof Service.layer,
  databaseLayer: Layer.Layer<SqlClient.SqlClient, E, R>,
  environmentLayer = identity,
) =>
  serviceLayer.pipe(
    Layer.provide(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read: Effect.succeed({
          provenance: null,
          settings: { mode: "hub" as const, memorySpaceId: space },
          version: 1,
        }),
      }),
    ),
    Layer.provideMerge(
      Quota.layer.pipe(Layer.provideMerge(Store.layer.pipe(Layer.provideMerge(databaseLayer)))),
    ),
    Layer.provide(environmentLayer),
    Layer.provide(
      Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
    ),
  );
export const core = makeCore(Service.layer, database);
const settings = Settings.layerTest({}, "memoryHub");
const admin = Layer.effect(Hub.MemoryHubAdministrator, Hub.makeAdministrator).pipe(
  Layer.provideMerge(storage),
  Layer.provide(identity),
  Layer.provide(
    Secrets.layer.pipe(
      Layer.provide(Config.layerTest(process.cwd(), { prefix: "goat-memory-mcp-test-" })),
      Layer.provide(NodeServices.layer),
    ),
  ),
);
const sync = Layer.unwrap(
  Effect.gen(function* () {
    const administrator = yield* Hub.MemoryHubAdministrator;
    return Layer.mock(Sync.MemorySyncService)({
      syncStatus: (_input, permit) =>
        permit.pipe(Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "hub_disabled" })))),
      updateHubSettings: (input, permit) =>
        administrator.update(
          input,
          permit.pipe(Effect.mapError(() => new M.MemoryHubForbiddenError({}))),
        ),
    });
  }),
).pipe(Layer.provide(admin));

const makeLayer = <E, R, E2, R2>(
  serviceCore: Layer.Layer<Layer.Success<typeof core>, E, R>,
  profiles: Layer.Layer<Profiles.PermissionProfiles, E2, R2>,
) =>
  Layer.mergeAll(
    McpHttpServer.layerMemoryToolkit,
    McpHttpServer.layerMemoryAdministrationToolkit,
  ).pipe(
    Layer.provideMerge(profiles),
    Layer.provideMerge(serviceCore),
    Layer.provideMerge(
      MemorySettings.layer.pipe(Layer.provideMerge(sync), Layer.provideMerge(settings)),
    ),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provide(NodeServices.layer),
  );
export const layer = makeLayer(core, McpToolAccessTestkit.layerPermissionProfilesOff);
const profileCore = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* profileMigration;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (application_event_version INTEGER, aggregate_kind TEXT, stream_id TEXT, event_type TEXT, payload_json TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, runtime_mode TEXT NOT NULL, deleted_at TEXT
    )`;
  }),
).pipe(Layer.provideMerge(core));
export const layerWithProfiles = makeLayer(
  profileCore,
  Profiles.layer.pipe(
    Layer.provide(profileCore),
    Layer.provideMerge(Settings.layerTest({ goatclaw: { enabled: true } })),
  ),
);
const threadScope = (profileId: string) => ({
  ...scope(),
  client: undefined,
  thread: {
    threadId: M.ThreadId.make(`memory-${profileId}`),
    providerSessionId: "synthetic",
    providerInstanceId: M.ProviderInstanceId.make("codex"),
  },
});
export const bindProfile = (profileId: string) =>
  Effect.gen(function* () {
    const caller = threadScope(profileId);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, runtime_mode)
      VALUES (${caller.thread.threadId}, 'full-access')`;
    const profiles = yield* Profiles.PermissionProfiles;
    yield* profiles.bind(caller.thread.threadId, profileId, "synthetic");
    return caller;
  });

/** Session admission and memory calls must share the environment identity and event database. */
export const layerForThreadEnvironment = <E, R>(
  environmentId: M.EnvironmentId,
  databaseLayer: Layer.Layer<SqlClient.SqlClient, E, R>,
) =>
  McpHttpServer.layerMemoryToolkit.pipe(
    Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
    Layer.provideMerge(
      makeCore(
        Service.layer,
        databaseLayer,
        Layer.succeed(Environment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(Sync.MemorySyncService)({
        syncStatus: (_input, permit) =>
          permit.pipe(Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "hub_disabled" })))),
      }),
    ),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provide(NodeServices.layer),
  );
export const layerWithSourceReadAuthority = (
  authority: Service.MemorySourceReadAuthority["readSource"],
) =>
  makeLayer(
    makeCore(Service.layerWithSourceReadAuthority(authority), database),
    McpToolAccessTestkit.layerPermissionProfilesOff,
  );
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "memory-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "memory-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
export const scope = (
  scopes: ReadonlyArray<M.AuthEnvironmentScope> = ["memory:read", "memory:write"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: M.EnvironmentId.make("fixture-memory-mcp"),
  requestNamespace: "fixture",
  thread: undefined,
  client: { sessionId: "fixture-client", label: "Synthetic", access: "auto" },
  capabilities: new Set(["memory"]),
  grantedScopes: scopes,
  reauthorize: (required) =>
    required.every((scope) => scopes.includes(scope))
      ? Effect.void
      : Effect.fail(
          new M.EnvironmentAuthorizationError({
            message: "Scope denied.",
            requiredScope: required[0] ?? "memory:read",
          }),
        ),
  issuedAt: 0,
});
export const upsert = (n = 3): M.MemoryUpsertInput => ({
  memorySpaceId: space,
  memoryId,
  operationId: M.MemoryOperationId.make(id(n)),
  expectedHeads: [],
  scope: { kind: "user" },
  assertionKind: "inference",
  payload: { text: "synthetic memory", evidence: [], derivedFromMemoryRevisions: [] },
  baseBoundary: null,
});
const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
/** Tests name memory tools by their grant names (MEMORY_MCP_TOOLS); /mcp lists them as goat_memory_*. */
const listedName = (name: string) => {
  const entry = resolveAgentSurfaceEntry(name);
  return entry === undefined ? name : listedToolName(entry);
};
export const call = (name: string, input: object, invocation = scope()) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({ name: listedName(name), arguments: input });
    const body = yield* json(
      result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    );
    return { result, body };
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

/** The envelope goat_call answers with, built by its own dispatch over this server's tools. */
export const callThroughGoatCall = (name: string, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const dispatch = ToolDispatch.of({
      call: (tool, args) => server.callTool({ name: listedName(tool), arguments: args }),
      served: () => undefined,
    });
    return yield* dispatchEnvelope(dispatch, listedName(name), input, "read");
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope()),
    Effect.provideService(McpSchema.McpServerClient, client),
  );
