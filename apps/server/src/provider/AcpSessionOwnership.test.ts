import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as AcpRegistryRuntimeCoordinator from "@goat/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as AcpSessionService from "./AcpSessionService.ts";

it.effect("lists and imports a native session already owned by another thread", () => {
  const instanceId = ProviderInstanceId.make("acp-fixture");
  const projectId = ProjectId.make("project-fixture");
  const ownerId = ThreadId.make("existing-owner");
  const instance = {
    driverKind: ProviderDriverKind.make("acpRegistry"),
    snapshot: {
      getSnapshot: Effect.succeed({ nativeSessions: { canLoad: true, canDelete: true } }),
    },
    acpSessionManagement: {
      listSessions: () =>
        Effect.succeed({
          sessions: [
            {
              sessionId: "native-1",
              cwd: "/fixture",
              additionalDirectories: [],
              title: null,
              updatedAt: null,
              importedThreadId: null,
            },
          ],
          rawCursor: null,
          droppedSessions: false,
          directoriesCut: false,
          overflow: false,
          cursorDropped: false,
          canLoad: true,
          canResume: false,
          canDelete: true,
        }),
      deleteSession: () => Effect.void,
    },
  } as unknown as ProviderInstance;
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    SqlitePersistence.layerMemory,
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: projectId,
          title: "Fixture",
          workspaceRoot: "/fixture",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          deletedAt: null,
        }),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(instance),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(id === ownerId ? ({ projectId, latestRunId: null } as never) : null),
    }),
    Layer.mock(AgentSessionImporter.AgentSessionImporter)({
      importNativeHistory: () => Effect.die("unexpected history import"),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: () => Effect.die("unexpected duplicate thread"),
    }),
    Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({ enqueueCommand: (effect) => effect }),
    Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
      withSessionMutation: (effect) => effect,
    }),
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('existing-owner', 'project-fixture', 'Existing', 'acpRegistry', 'full-access', 'default', '2026-01-01', '2026-01-01', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver, provider_instance_id)
      VALUES ('provider-1', 'existing-owner', 'acpRegistry', 'idle', '2026-01-01', '{"nativeThreadRef":{"nativeId":"native-1"}}', 'acpRegistry', 'acp-fixture')`;
    const service = yield* AcpSessionService.AcpSessionService;
    const listed = yield* service.list({ instanceId, projectId });
    expect(listed.sessions[0]?.importedThreadId).toBe(ownerId);
    expect(yield* service.import({ instanceId, projectId, sessionId: "native-1" })).toEqual({
      threadId: ownerId,
      imported: false,
    });
    const refusedDelete = yield* Effect.result(
      service.delete({ instanceId, projectId, sessionId: "native-1" }),
    );
    expect(Result.isFailure(refusedDelete)).toBe(true);
    if (Result.isFailure(refusedDelete))
      expect(refusedDelete.failure.reason).toBe("session_delete_failed");

    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET provider_instance_id = 'other'`;
    expect(
      (yield* service.list({ instanceId, projectId })).sessions[0]?.importedThreadId,
    ).toBeNull();
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET provider_instance_id = 'acp-fixture', driver = 'other'`;
    expect(
      (yield* service.list({ instanceId, projectId })).sessions[0]?.importedThreadId,
    ).toBeNull();
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET driver = 'acpRegistry', payload_json = '{"nativeThreadRef":{"nativeId":17}}'`;
    expect(
      (yield* service.list({ instanceId, projectId })).sessions[0]?.importedThreadId,
    ).toBeNull();
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{}'`;
    expect(
      (yield* service.list({ instanceId, projectId })).sessions[0]?.importedThreadId,
    ).toBeNull();
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{"nativeThreadRef":{"nativeId":"native-1"}}'`;
    yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-01-01'`;
    expect(
      (yield* service.list({ instanceId, projectId })).sessions[0]?.importedThreadId,
    ).toBeNull();
    yield* sql`DROP TABLE orchestration_v2_projection_provider_threads`;
    const failure = yield* Effect.result(
      service.import({ instanceId, projectId, sessionId: "native-1" }),
    );
    expect(Result.isFailure(failure)).toBe(true);
    if (Result.isFailure(failure)) expect(failure.failure.reason).toBe("session_import_failed");
  }).pipe(Effect.provide(AcpSessionService.layer.pipe(Layer.provideMerge(dependencies))));
});
