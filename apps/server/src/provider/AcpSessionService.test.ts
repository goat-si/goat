import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId, ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import * as AcpRegistryRuntimeCoordinator from "@goat/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as AcpSessionService from "./AcpSessionService.ts";

it.effect("marks imported sessions and refuses to delete their native session", () =>
  Effect.gen(function* () {
    const deleted = yield* Ref.make(false);
    const instanceId = ProviderInstanceId.make("acp-fixture");
    const projectId = ProjectId.make("project-fixture");
    const instance = {
      driverKind: ProviderDriverKind.make("acpRegistry"),
      snapshot: { getSnapshot: Effect.succeed({ nativeSessions: { canDelete: true } }) },
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
            nextCursor: null,
            canLoad: true,
            canResume: true,
            canDelete: true,
          }),
        deleteSession: () => Ref.set(deleted, true),
      },
    } as unknown as ProviderInstance;
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Fixture",
            workspaceRoot: "/fixture",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(instance),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed({} as never),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
      Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
        withSessionMutation: (effect) => effect,
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* AcpSessionService.AcpSessionService;
      const listed = yield* service.list({ instanceId, projectId });
      expect(listed.sessions[0]?.importedThreadId).not.toBeNull();
      const failure = yield* Effect.flip(
        service.delete({ instanceId, projectId, sessionId: "native-1" }),
      );
      expect(failure.reason).toBe("session_delete_failed");
      expect(yield* Ref.get(deleted)).toBe(false);
    }).pipe(Effect.provide(AcpSessionService.layer.pipe(Layer.provide(dependencies))));
  }),
);
