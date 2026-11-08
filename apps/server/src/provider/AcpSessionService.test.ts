import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as AcpRegistryRuntimeCoordinator from "@goat/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
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
            rawCursor: null,
            droppedSessions: true,
            directoriesCut: false,
            overflow: false,
            cursorDropped: false,
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

const continuationInstanceId = ProviderInstanceId.make("acp-hold");

const heldContinuation = (token: string | undefined) => {
  if (token === undefined) throw new Error("Expected a continuation token");
  return token;
};
const continuationProjectId = ProjectId.make("project-hold");

const heldSession = (sessionId: string) => ({
  sessionId,
  cwd: "/fixture",
  additionalDirectories: [] as ReadonlyArray<string>,
  title: null as string | null,
  updatedAt: null as string | null,
  importedThreadId: null,
});

const heldPage = (
  sessions: ReadonlyArray<ReturnType<typeof heldSession>>,
  rawCursor: string | null,
) => ({
  sessions,
  rawCursor,
  droppedSessions: false,
  directoriesCut: false,
  overflow: false,
  cursorDropped: false,
  canLoad: true,
  canResume: false,
  canDelete: true,
});

const provideHeldSessions = (
  listSessions: (input: {
    readonly cwd: string;
    readonly cursor?: string;
  }) => Effect.Effect<ReturnType<typeof heldPage>>,
  deleted: Ref.Ref<ReadonlyArray<string>>,
) => {
  const instance = {
    driverKind: ProviderDriverKind.make("acpRegistry"),
    snapshot: {
      getSnapshot: Effect.succeed({ nativeSessions: { canDelete: true, canLoad: true } }),
    },
    acpSessionManagement: {
      listSessions,
      deleteSession: ({ sessionId }: { sessionId: string }) =>
        Ref.update(deleted, (ids) => [...ids, sessionId]),
    },
  } as unknown as ProviderInstance;
  return AcpSessionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: continuationProjectId,
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
          getThreadShell: () => Effect.succeed(null),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: () => Effect.die("unused launch"),
        }),
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          enqueueCommand: (effect) => effect,
        }),
        Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
          withSessionMutation: (effect) => effect,
        }),
      ),
    ),
  );
};

it.effect("returns held session 257 from continuation without another provider call", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
    const deleted = yield* Ref.make<ReadonlyArray<string>>([]);
    const sessions = Array.from({ length: 257 }, (_, index) => heldSession(`native-${index + 1}`));
    const dependencies = provideHeldSessions(
      (input) =>
        Ref.update(calls, (all) => [...all, input.cursor]).pipe(
          Effect.as(heldPage(sessions, "after-page")),
        ),
      deleted,
    );
    yield* Effect.gen(function* () {
      const service = yield* AcpSessionService.AcpSessionService;
      const first = yield* service.list({
        instanceId: continuationInstanceId,
        projectId: continuationProjectId,
      });
      expect(first.sessions).toHaveLength(256);
      expect(first.sessions.at(-1)?.sessionId).toBe("native-256");
      expect(first.nextCursor).toBeNull();
      expect(first.continuation).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      expect(yield* Ref.get(calls)).toEqual([undefined]);
      const second = yield* service.list({
        instanceId: continuationInstanceId,
        projectId: continuationProjectId,
        continuation: heldContinuation(first.continuation),
      });
      expect(second.sessions.map((session) => session.sessionId)).toEqual(["native-257"]);
      expect(second.nextCursor).toBe("after-page");
      expect(second.continuation).toBeUndefined();
      expect(yield* Ref.get(calls)).toEqual([undefined]);
      const replay = yield* Effect.result(
        service.list({
          instanceId: continuationInstanceId,
          projectId: continuationProjectId,
          continuation: heldContinuation(first.continuation),
        }),
      );
      expect(Result.isFailure(replay) && replay.failure.reason).toBe("continuation_unavailable");
      expect(yield* Ref.get(calls)).toEqual([undefined]);
    }).pipe(Effect.provide(dependencies));
  }),
);

it.effect("rejects an unknown, mismatched, or expired continuation without a provider call", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
    const deleted = yield* Ref.make<ReadonlyArray<string>>([]);
    const dependencies = provideHeldSessions(
      (input) =>
        Ref.update(calls, (all) => [...all, input.cursor]).pipe(
          Effect.as(heldPage([heldSession("native-1")], "x".repeat(2_049))),
        ),
      deleted,
    );
    yield* Effect.gen(function* () {
      const service = yield* AcpSessionService.AcpSessionService;
      const both = yield* Effect.result(
        service.list({
          instanceId: continuationInstanceId,
          projectId: continuationProjectId,
          cursor: "legacy",
          continuation: "a".repeat(16),
        }),
      );
      expect(yield* Ref.get(calls)).toEqual([]);
      expect(Result.isFailure(both) && both.failure.reason).toBe("continuation_unavailable");
      const unknown = yield* Effect.result(
        service.list({
          instanceId: continuationInstanceId,
          projectId: continuationProjectId,
          continuation: "b".repeat(16),
        }),
      );
      expect(yield* Ref.get(calls)).toEqual([]);
      expect(Result.isFailure(unknown) && unknown.failure.reason).toBe("continuation_unavailable");
      const held = yield* service.list({
        instanceId: continuationInstanceId,
        projectId: continuationProjectId,
      });
      expect(held.sessions.map((session) => session.sessionId)).toEqual(["native-1"]);
      expect(held.nextCursor).toBeNull();
      expect(held.continuation).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      expect(yield* Ref.get(calls)).toEqual([undefined]);
      yield* TestClock.adjust("10 minutes");
      yield* TestClock.adjust("1 millis");
      const expired = yield* Effect.result(
        service.list({
          instanceId: continuationInstanceId,
          projectId: continuationProjectId,
          continuation: heldContinuation(held.continuation),
        }),
      );
      expect(Result.isFailure(expired) && expired.failure.reason).toBe("continuation_unavailable");
      expect(yield* Ref.get(calls)).toEqual([undefined]);
    }).pipe(Effect.provide(dependencies));
  }),
);

it.effect("scrubs a deleted session id from the held page and keeps the token", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
    const deleted = yield* Ref.make<ReadonlyArray<string>>([]);
    const sessions = Array.from({ length: 257 }, (_, index) => heldSession(`native-${index + 1}`));
    const dependencies = provideHeldSessions(
      (input) =>
        Ref.update(calls, (all) => [...all, input.cursor]).pipe(
          Effect.as(heldPage(sessions, null)),
        ),
      deleted,
    );
    yield* Effect.gen(function* () {
      const service = yield* AcpSessionService.AcpSessionService;
      const first = yield* service.list({
        instanceId: continuationInstanceId,
        projectId: continuationProjectId,
      });
      expect(first.continuation).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      expect(
        yield* service.delete({
          instanceId: continuationInstanceId,
          projectId: continuationProjectId,
          sessionId: "native-257",
        }),
      ).toEqual({ deleted: true });
      expect(yield* Ref.get(deleted)).toEqual(["native-257"]);
      const second = yield* service.list({
        instanceId: continuationInstanceId,
        projectId: continuationProjectId,
        continuation: heldContinuation(first.continuation),
      });
      expect(second.sessions.map((session) => session.sessionId)).toEqual([]);
      expect(second.nextCursor).toBeNull();
      expect(second.continuation).toBeUndefined();
      expect(yield* Ref.get(calls)).toEqual([undefined]);
    }).pipe(Effect.provide(dependencies));
  }),
);

it.effect("calls the provider with the exact 2049-character cursor held for continuation", () =>
  Effect.gen(function* () {
    const cursor = "x".repeat(2_049);
    const calls = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
    const deleted = yield* Ref.make<ReadonlyArray<string>>([]);
    const dependencies = provideHeldSessions(
      (input) =>
        Ref.update(calls, (all) => [...all, input.cursor]).pipe(
          Effect.as(
            input.cursor === undefined
              ? heldPage([heldSession("native-1")], cursor)
              : heldPage([heldSession("from-cursor")], null),
          ),
        ),
      deleted,
    );
    yield* Effect.gen(function* () {
      const service = yield* AcpSessionService.AcpSessionService;
      const first = yield* service.list({
        instanceId: continuationInstanceId,
        projectId: continuationProjectId,
      });
      expect(first.sessions.map((session) => session.sessionId)).toEqual(["native-1"]);
      expect(first.nextCursor).toBeNull();
      expect(first.continuation).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      expect(yield* Ref.get(calls)).toEqual([undefined]);
      const second = yield* service.list({
        instanceId: continuationInstanceId,
        projectId: continuationProjectId,
        continuation: heldContinuation(first.continuation),
      });
      expect(second.sessions.map((session) => session.sessionId)).toEqual(["from-cursor"]);
      expect(yield* Ref.get(calls)).toEqual([undefined, cursor]);
    }).pipe(Effect.provide(dependencies));
  }),
);

it.effect("does not let an older provider page replace a newer hold", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const deleted = yield* Ref.make<ReadonlyArray<string>>([]);
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const pageFor = (prefix: string) =>
      heldPage(
        Array.from({ length: 257 }, (_, index) => heldSession(`${prefix}-${index + 1}`)),
        null,
      );
    const dependencies = provideHeldSessions(
      () =>
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(calls, (count) => count + 1);
          if (n === 1) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
            return pageFor("stale");
          }
          return pageFor("fresh");
        }),
      deleted,
    );
    yield* Effect.gen(function* () {
      const service = yield* AcpSessionService.AcpSessionService;
      const staleFiber = yield* Effect.forkChild(
        service.list({
          instanceId: continuationInstanceId,
          projectId: continuationProjectId,
        }),
      );
      yield* Deferred.await(firstStarted);
      const fresh = yield* service.list({
        instanceId: continuationInstanceId,
        projectId: continuationProjectId,
      });
      yield* Deferred.succeed(releaseFirst, undefined);
      const stale = yield* Fiber.join(staleFiber);
      expect(stale.sessions[0]?.sessionId).toBe("stale-1");
      expect(stale.continuation).toBeUndefined();
      expect(fresh.sessions).toHaveLength(256);
      expect(fresh.sessions.at(-1)?.sessionId).toBe("fresh-256");
      expect(fresh.continuation).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      const next = yield* service.list({
        instanceId: continuationInstanceId,
        projectId: continuationProjectId,
        continuation: heldContinuation(fresh.continuation),
      });
      expect(next.sessions.map((session) => session.sessionId)).toEqual(["fresh-257"]);
      expect(yield* Ref.get(calls)).toBe(2);
    }).pipe(Effect.provide(dependencies));
  }),
);
