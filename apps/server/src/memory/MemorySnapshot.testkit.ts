import * as Settings from "../serverSettings.ts";
import * as M from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Repository from "../project/RepositoryIdentityResolver.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Snapshot from "./MemorySnapshot.ts";

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const space = M.MemorySpaceId.make(id(1));
export const environmentId = M.EnvironmentId.make("fixture");
export const threadId = M.ThreadId.make("thread");
export const runId = M.RunId.make("run");
export const projectId = M.ProjectId.make("project");
export const input = (n: number, scope: M.MemoryScope = { kind: "user" }): M.MemoryUpsertInput => ({
  memorySpaceId: space,
  memoryId: M.MemoryId.make(id(n)),
  operationId: M.MemoryOperationId.make(id(n + 10000)),
  expectedHeads: [],
  scope,
  assertionKind: "inference",
  payload: { text: "synthetic & <memory> " + n, evidence: [], derivedFromMemoryRevisions: [] },
  baseBoundary: null,
});
export const fixture = (
  options: {
    repository?: M.RepositoryIdentity;
    foreignRevisionSpace?: M.MemorySpaceId;
    message?: string;
    beforeAdmission?: Effect.Effect<void>;
    onReadiness?: () => void;
  } = {},
) => {
  let pageReads = 0;
  const pageScopes: M.MemoryScope["kind"][] = [];
  let hubVersion = 1;
  let policy: Snapshot.MemorySnapshotPolicy = {
    grant: "read",
    policyEpoch: 1,
    finalAuthority: Effect.sync(() => policy.grant !== "none" && policy.policyEpoch === 1),
  };
  let active = true;
  let currentRunId = runId;
  let ready = true;
  let messageText = options.message;
  let messageRole: "user" | "assistant" | "system" = "user";
  // The projection boundary supplies only the shell fields read by this service.
  const shell = {
    id: threadId,
    projectId,
    activeRunId: runId,
    activityRunStatus: "running",
  } as M.OrchestrationV2ThreadShell;
  const database = Layer.effectDiscard(runMigrations()).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const store = Store.layer.pipe(Layer.provideMerge(database));
  const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  });
  const serviceBase = Service.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read: Effect.sync(() => ({
          provenance: null,
          settings: { mode: "hub" as const, memorySpaceId: space },
          version: hubVersion,
        })),
      }),
    ),
    Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(store))),
    Layer.provideMerge(identity),
    Layer.provide(
      Layer.mock(Repository.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(options.repository ?? null),
      }),
    ),
  );
  const service = Layer.effect(
    Service.MemoryService,
    Effect.gen(function* () {
      const original = yield* Service.MemoryService;
      return Service.MemoryService.of({
        ...original,
        readContextRevisions: (space, ids, permit) =>
          original
            .readContextRevisions(space, ids, permit)
            .pipe(
              Effect.map((page) =>
                options.foreignRevisionSpace
                  ? { ...page, memorySpaceId: options.foreignRevisionSpace }
                  : page,
              ),
            ),
        readContextCandidates: (input, permit) =>
          Effect.sync(() => {
            pageReads++;
            pageScopes.push(input.scope?.kind ?? "user");
          }).pipe(Effect.andThen(original.readContextCandidates(input, permit))),
      });
    }),
  ).pipe(Layer.provideMerge(serviceBase));
  const beforeAdmission = options.beforeAdmission;
  const snapshotLayer = beforeAdmission
    ? Snapshot.layer.pipe(
        Layer.provide(
          Layer.effect(
            Store.MemoryStore,
            Effect.gen(function* () {
              const original = yield* Store.MemoryStore;
              return Store.MemoryStore.of({
                ...original,
                transact: (effect, transactionOptions) =>
                  transactionOptions?.finalGuard
                    ? beforeAdmission.pipe(
                        Effect.andThen(original.transact(effect, transactionOptions)),
                      )
                    : original.transact(effect, transactionOptions),
              });
            }),
          ),
        ),
      )
    : Snapshot.layer;
  const live = snapshotLayer.pipe(
    Layer.provideMerge(service),
    Layer.provide(
      Layer.mock(Projection.ProjectionStoreV2)({
        getRunMessage: () =>
          Effect.succeed(
            messageText !== undefined
              ? ({ role: messageRole, text: messageText } as M.OrchestrationV2ConversationMessage)
              : undefined,
          ),
        getThreadShell: (requested) =>
          Effect.sync(() =>
            active ? { ...shell, id: requested, activeRunId: currentRunId } : null,
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(Sync.MemorySyncService)({
        readLocalReadiness: () =>
          Effect.sync(() => {
            options.onReadiness?.();
            return {
              memorySpaceId: space,
              bootstrap: ready ? ("ready" as const) : ("staging" as const),
            };
          }),
      }),
    ),
  );
  return {
    live,
    pageReads: () => pageReads,
    pageScopes,
    setHubVersion: (version: number) => {
      hubVersion = version;
    },
    setMessage: (text: string, role: "user" | "assistant" | "system" = "user") => {
      messageText = text;
      messageRole = role;
    },
    policy: () => policy,
    currentPolicy: Effect.sync(() => policy),
    setPolicy: (value: Snapshot.MemorySnapshotPolicy) => {
      const epoch = value.policyEpoch;
      policy = {
        ...value,
        finalAuthority:
          value.finalAuthority ??
          Effect.sync(() => policy.grant !== "none" && policy.policyEpoch === epoch),
      };
    },
    end: () => {
      active = false;
    },
    changeRun: () => {
      currentRunId = M.RunId.make("replacement-run");
    },
    unready: () => {
      ready = false;
    },
  };
};
export const project = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'synthetic','/synthetic','[]','2026-10-15','2026-10-15')`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${threadId},${projectId},'current','codex','default','default','2026-01-01','2026-01-01','{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES (${runId},${threadId},1,'codex','running','2026-01-01','{}')`;
});
