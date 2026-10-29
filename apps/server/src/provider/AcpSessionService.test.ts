import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@goat/contracts";
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

it.effect("preserves incomplete listings, imports once, and protects imported sessions", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("acp-fixture");
    const projectId = ProjectId.make("project-fixture");
    const expectedThreadId = ThreadId.make(
      "thread:provider:acpRegistry:provider-instance:acp-fixture:native-thread:native-1",
    );
    const imported = yield* Ref.make<ThreadId | null>(null);
    const deleted = yield* Ref.make<ReadonlyArray<string>>([]);
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]);
    const mutationActive = yield* Ref.make(false);
    const mutations = yield* Ref.make(0);
    const requireMutation = Ref.get(mutationActive).pipe(
      Effect.flatMap((active) =>
        active ? Effect.void : Effect.die("ACP mutation escaped the coordinator"),
      ),
    );
    const instance = {
      driverKind: ProviderDriverKind.make("acpRegistry"),
      snapshot: {
        getSnapshot: requireMutation.pipe(
          Effect.as({ nativeSessions: { canLoad: true, canDelete: true } }),
        ),
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
            nextCursor: null,
            truncated: true,
            canLoad: true,
            canResume: false,
            canDelete: true,
          }),
        deleteSession: ({ sessionId }: { sessionId: string }) =>
          requireMutation.pipe(Effect.andThen(Ref.update(deleted, (ids) => [...ids, sessionId]))),
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
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (id) =>
          Ref.get(imported).pipe(Effect.map((current) => (current === id ? ({} as never) : null))),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          input.threadId === undefined
            ? Effect.die("Imported thread id was not provided")
            : requireMutation.pipe(
                Effect.andThen(Ref.update(launches, (all) => [...all, input])),
                Effect.andThen(Ref.set(imported, input.threadId)),
                Effect.as({ threadId: input.threadId, projection: {} as never, resumed: false }),
              ),
      }),
      Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({ enqueueCommand: (effect) => effect }),
      Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
        withSessionMutation: (effect) =>
          Effect.acquireUseRelease(
            Ref.update(mutations, (n) => n + 1).pipe(Effect.andThen(Ref.set(mutationActive, true))),
            () => effect,
            () => Ref.set(mutationActive, false),
          ),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* AcpSessionService.AcpSessionService;
      const initial = yield* service.list({ instanceId, projectId });
      expect(initial.sessions).toHaveLength(1);
      expect(initial.truncated).toBe(true);
      expect(initial.sessions[0]).toMatchObject({ sessionId: "native-1", importedThreadId: null });
      const first = yield* service.import({ instanceId, projectId, sessionId: "native-1" });
      expect(first).toEqual({ threadId: expectedThreadId, imported: true });
      const second = yield* service.import({ instanceId, projectId, sessionId: "native-1" });
      expect(second).toEqual({ threadId: expectedThreadId, imported: false });
      expect(yield* Ref.get(launches)).toHaveLength(1);
      expect((yield* Ref.get(launches))[0]).toMatchObject({
        threadId: expectedThreadId,
        importedNativeThread: { ref: { nativeId: "native-1", driver: "acpRegistry" } },
      });
      const listed = yield* service.list({ instanceId, projectId });
      expect(listed.sessions).toHaveLength(1);
      expect(listed.truncated).toBe(true);
      expect(listed.sessions[0]).toMatchObject({
        sessionId: "native-1",
        importedThreadId: expectedThreadId,
      });
      const failure = yield* Effect.flip(
        service.delete({ instanceId, projectId, sessionId: "native-1" }),
      );
      expect(failure.reason).toBe("session_delete_failed");
      expect(yield* Ref.get(deleted)).toEqual([]);
      expect(yield* service.delete({ instanceId, projectId, sessionId: "native-2" })).toEqual({
        deleted: true,
      });
      expect(yield* Ref.get(deleted)).toEqual(["native-2"]);
      expect(yield* Ref.get(mutations)).toBe(4);
      expect(yield* Ref.get(mutationActive)).toBe(false);
    }).pipe(Effect.provide(AcpSessionService.layer.pipe(Layer.provide(dependencies))));
  }),
);
