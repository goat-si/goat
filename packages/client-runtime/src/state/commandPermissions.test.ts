import * as Schema from "effect/Schema";
import { SshWorkspaceLaunchInput, SshWorkspaceLaunchResult } from "@goat/contracts";
import * as Persistence from "../platform/persistence.ts";
import { createVcsEnvironmentAtoms } from "./vcs.ts";
import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  SSH_PREFLIGHT_STEP_ORDER,
  AuthSourceControlWriteScope,
  ThreadId,
  EnvironmentId,
  ScheduledTaskId,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type AuthSessionState,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect("requires the destination preview grant to close a browser tab", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const close = createCommandPermissions(runtime, WS_METHODS.previewClose);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(close.permissionAtom(env))).toBe(false);
        expect((yield* close.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthPreviewOperateScope],
            permissions: [AuthPreviewOperateScope],
          }),
        );
        expect(registry.get(close.permissionAtom(env))).toBe(true);
        yield* close.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(close.permissionAtom(other))).toBe(false);
        expect((yield* close.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }),
    ),
  );

  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires the destination maintenance grant to sync OpenCodex", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const sync = createCommandPermissions(runtime, WS_METHODS.serverSyncOpenCodex);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(sync.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthEnvironmentMaintainScope],
            permissions: [AuthEnvironmentMaintainScope],
          }),
        );
        expect(registry.get(sync.permissionAtom(env))).toBe(true);
        yield* sync.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(sync.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect.each(["commit", "push", "commit_push", "create_pr", "commit_push_pr"] as const)(
  "%s needs thread read permission only when generating a PR from a thread",
  (action) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const command = createCommandPermissions(runtime, WS_METHODS.gitRunStackedAction);
        const input = { actionId: "action", cwd: "/repo", action };
        const withThread = { ...input, threadId: ThreadId.make("thread") };
        const session = {
          ...grant(false),
          scopes: [AuthSourceControlWriteScope],
          permissions: [AuthSourceControlWriteScope],
        };
        registry.set(sessions(env), AsyncResult.success(session));
        expect(registry.get(command.permissionAtom(env, input))).toBe(true);
        yield* command.authorize(registry, env, input);
        const readsThread = action === "create_pr" || action === "commit_push_pr";
        expect(registry.get(command.permissionAtom(env, withThread))).toBe(!readsThread);
        if (readsThread) {
          expect(
            yield* command.authorize(registry, env, withThread).pipe(Effect.flip),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
        } else {
          yield* command.authorize(registry, env, withThread);
        }
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...session,
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationReadScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationReadScope],
          }),
        );
        expect(registry.get(command.permissionAtom(env, withThread))).toBe(true);
        yield* command.authorize(registry, env, withThread);
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);

const sshLaunchPayload = Schema.decodeUnknownSync(SshWorkspaceLaunchInput)({
  sourceProjectId: "source",
  destination: {
    connectionId: "saved",
    expectedEnvironmentId: "remote",
    target: { alias: "box", hostname: "box", username: null, port: null },
  },
  title: "Work",
  modelSelection: { instanceId: "codex", model: "model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  initialMessage: { text: "Implement" },
});
const sshLaunchSuccess = Schema.decodeUnknownSync(SshWorkspaceLaunchResult)({
  operationId: "12345678",
  snapshotRef: "refs/goat/snapshots/12345678",
  snapshotOid: "a".repeat(40),
  remoteEnvironmentId: "remote",
  remoteProjectId: "rp",
  remoteThreadId: "rt",
  remoteRepoPath: "/home/test/.goat/repos/repo-12345678",
  branch: "goat/ssh/12345678",
});
const sshFetchPayload = {
  target: sshLaunchPayload.destination.target,
  remoteWorkspaceRoot: sshLaunchSuccess.remoteRepoPath,
  branch: sshLaunchSuccess.branch,
};
const sshFetchSuccess = {
  sourceProjectId: sshLaunchPayload.sourceProjectId,
  localWorkspaceRoot: "/repo",
  localRef: "refs/remotes/goat-ssh/box/goat/ssh/12345678",
  commitOid: "a".repeat(40),
  remoteBranch: sshFetchPayload.branch,
};
const sshCommandFixture = (onLaunch = async () => sshLaunchSuccess) =>
  Effect.gen(function* () {
    let calls = 0;
    const session = {
      client: {
        [WS_METHODS.sshWorkspaceLaunch]: () =>
          Effect.promise(async () => {
            calls++;
            return await onLaunch();
          }),
        [WS_METHODS.sshWorkspaceFetchBack]: () =>
          Effect.sync(() => {
            calls++;
            return sshFetchSuccess;
          }),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "source" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const commandRuntime = Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry, {
          run: (id: EnvironmentId, effect: Effect.Effect<unknown>) =>
            effect.pipe(
              Effect.provideService(EnvironmentSupervisor, {
                ...supervisor,
                target: { ...supervisor.target, environmentId: id },
              }),
            ),
        } as unknown as EnvironmentRegistry["Service"]),
        Layer.mock(Persistence.EnvironmentCacheStore)({}),
      ),
    );
    const commands = createVcsEnvironmentAtoms(commandRuntime);
    const registry = AtomRegistry.make();
    registry.mount(sessions(env));
    registry.mount(sessions(other));
    const setGrant = (id: EnvironmentId, scopes: NonNullable<AuthSessionState["scopes"]>) =>
      registry.set(
        sessions(id),
        AsyncResult.success({ ...grant(false), scopes, permissions: scopes }),
      );
    return { commands, registry, setGrant, calls: () => calls, dispose: () => registry.dispose() };
  });
it.effect("SSH launch availability and execution require both grants", () =>
  Effect.gen(function* () {
    const f = yield* sshCommandFixture();
    yield* Effect.promise(async () => {
      try {
        for (const scopes of [[], [AuthSourceControlWriteScope], [AuthOrchestrationOperateScope]]) {
          f.setGrant(env, scopes);
          expect(f.registry.get(f.commands.sshWorkspaceLaunch.permissionAtom(env))).toBe(false);
          expect(
            (
              await f.commands.sshWorkspaceLaunch.run(f.registry, {
                environmentId: env,
                input: sshLaunchPayload,
              })
            )._tag,
          ).toBe("Failure");
        }
        expect(f.calls()).toBe(0);
        f.setGrant(env, [AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
        expect(f.registry.get(f.commands.sshWorkspaceLaunch.permissionAtom(env))).toBe(true);
        expect(
          (
            await f.commands.sshWorkspaceLaunch.run(f.registry, {
              environmentId: env,
              input: sshLaunchPayload,
            })
          )._tag,
        ).toBe("Success");
        expect(f.calls()).toBe(1);
      } finally {
        f.dispose();
      }
    });
  }),
);
it.effect("SSH fetchBack requires only source-control write", () =>
  Effect.gen(function* () {
    const f = yield* sshCommandFixture();
    yield* Effect.promise(async () => {
      try {
        f.setGrant(env, [AuthOrchestrationOperateScope]);
        expect(f.registry.get(f.commands.sshWorkspaceFetchBack.permissionAtom(env))).toBe(false);
        expect(
          (
            await f.commands.sshWorkspaceFetchBack.run(f.registry, {
              environmentId: env,
              input: sshFetchPayload,
            })
          )._tag,
        ).toBe("Failure");
        expect(f.calls()).toBe(0);
        f.setGrant(env, [AuthSourceControlWriteScope]);
        expect(f.registry.get(f.commands.sshWorkspaceFetchBack.permissionAtom(env))).toBe(true);
        expect(
          (
            await f.commands.sshWorkspaceFetchBack.run(f.registry, {
              environmentId: env,
              input: sshFetchPayload,
            })
          )._tag,
        ).toBe("Success");
        expect(f.calls()).toBe(1);
      } finally {
        f.dispose();
      }
    });
  }),
);
it.effect("SSH launch rechecks source environment grant after serial queue", () =>
  Effect.gen(function* () {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = yield* sshCommandFixture(async () => {
      started();
      await gate;
      return sshLaunchSuccess;
    });
    yield* Effect.promise(async () => {
      try {
        f.setGrant(env, [AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
        const target = { environmentId: env, input: sshLaunchPayload };
        const first = f.commands.sshWorkspaceLaunch.run(f.registry, target);
        await entered;
        const second = f.commands.sshWorkspaceLaunch.run(f.registry, target);
        f.setGrant(env, []);
        release();
        expect((await first)._tag).toBe("Success");
        expect((await second)._tag).toBe("Failure");
        expect(f.calls()).toBe(1);
      } finally {
        release();
        f.dispose();
      }
    });
  }),
);
it.effect("SSH command cannot borrow a grant from the selected remote environment", () =>
  Effect.gen(function* () {
    const f = yield* sshCommandFixture();
    yield* Effect.promise(async () => {
      try {
        f.setGrant(env, []);
        f.setGrant(other, [AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
        expect(
          (
            await f.commands.sshWorkspaceLaunch.run(f.registry, {
              environmentId: env,
              input: {
                ...sshLaunchPayload,
                destination: { ...sshLaunchPayload.destination, expectedEnvironmentId: other },
              },
            })
          )._tag,
        ).toBe("Failure");
        expect(f.calls()).toBe(0);
      } finally {
        f.dispose();
      }
    });
  }),
);

it.effect("memory commands check the destination's live grant for all 16 installed methods", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const reads = [
        WS_METHODS.memoryList,
        WS_METHODS.memorySearch,
        WS_METHODS.memoryRead,
        WS_METHODS.memoryHistory,
        WS_METHODS.memoryChanges,
        WS_METHODS.memorySyncStatus,
      ];
      const writes = [
        WS_METHODS.memoryUpsert,
        WS_METHODS.memoryForget,
        WS_METHODS.memoryRevertResolution,
        WS_METHODS.memoryProjectBindingGet,
        WS_METHODS.memoryProjectBindingUpdate,
      ];
      const administration = [
        WS_METHODS.memoryHubSettingsGet,
        WS_METHODS.memoryHubSettingsUpdate,
        WS_METHODS.memoryOwnerSourceReadPolicyGet,
        WS_METHODS.memoryOwnerSourceReadPolicyUpdate,
      ];
      const cases = [
        ...reads.map((method) => ({ method, scopes: ["memory:read"] as const })),
        ...writes.map((method) => ({ method, scopes: ["memory:write"] as const })),
        ...administration.map((method) => ({ method, scopes: ["settings:write"] as const })),
        {
          method: WS_METHODS.memoryReadSource,
          scopes: ["memory:read", "orchestration:read"] as const,
        },
      ];
      for (const { method, scopes } of cases) {
        const permission = createCommandPermissions(runtime, method);
        registry.set(
          sessions(env),
          AsyncResult.success({ ...grant(false), scopes, permissions: scopes }),
        );
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permission.permissionAtom(env))).toBe(true);
        yield* permission.authorize(registry, env);
        expect(registry.get(permission.permissionAtom(other))).toBe(false);
        expect((yield* Effect.flip(permission.authorize(registry, other)))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(permission.permissionAtom(env))).toBe(false);
        expect((yield* Effect.flip(permission.authorize(registry, env)))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }
    }),
  ),
);

it.effect("SSH preflight uses the destination settings grant at availability and dispatch", () =>
  Effect.gen(function* () {
    let calls = 0;
    const session = {
      client: {
        [WS_METHODS.sshHostPreflight]: () =>
          Effect.sync(() => {
            calls++;
            return {
              host: "box",
              destination: { alias: "box", hostname: "box.local", user: "dev", port: 22 },
              steps: SSH_PREFLIGHT_STEP_ORDER.map((id) => ({
                id,
                state: "passed",
                summary: "Passed",
              })),
              ready: true,
            };
          }),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const commandRuntime = Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry, {
          run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) =>
            effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisor)),
        } as unknown as EnvironmentRegistry["Service"]),
        Layer.mock(Persistence.EnvironmentCacheStore)({}),
      ),
    );
    const command = createServerEnvironmentAtoms(commandRuntime, {
      initialConfigValueAtom: () => Atom.make(null),
    }).preflightSshHost;
    const registry = AtomRegistry.make();
    registry.mount(sessions(env));
    registry.mount(sessions(other));
    yield* Effect.promise(async () => {
      try {
        const input = { environmentId: env, input: { host: "box" } };
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        registry.set(
          sessions(other),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(command.permissionAtom(env))).toBe(false);
        expect((await command.run(registry, input))._tag).toBe("Failure");
        expect(calls).toBe(0);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(command.permissionAtom(env))).toBe(true);
        expect((await command.run(registry, input))._tag).toBe("Success");
        expect(calls).toBe(1);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect((await command.run(registry, input))._tag).toBe("Failure");
        expect(calls).toBe(1);
      } finally {
        registry.dispose();
      }
    });
  }),
);
describe("command permissions through a hub", () => {
  it.effect("hides node actions the hub does not forward and keeps follow-ups and stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const dispatch = createCommandPermissions(
          runtime,
          ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        );
        const remove = { type: "thread.delete", commandId: "c1", threadId: "t1" };
        const followUp = {
          type: "message.dispatch",
          commandId: "c2",
          threadId: "t1",
          createdBy: "user",
        };
        const stop = { type: "run.interrupt", commandId: "c3", threadId: "t1", runId: "r1" };
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        // A direct connection is unaffected.
        expect(registry.get(dispatch.permissionAtom(env, remove))).toBe(true);
        registry.set(sessions(env), AsyncResult.success({ ...grant(true), proxiedByHub: true }));
        expect(registry.get(dispatch.permissionAtom(env, remove))).toBe(false);
        expect(registry.get(dispatch.permissionAtom(env, followUp))).toBe(true);
        expect(registry.get(dispatch.permissionAtom(env, stop))).toBe(true);
        expect(yield* dispatch.authorize(registry, env, remove).pipe(Effect.flip)).toMatchObject({
          requiredScope: "hub:proxy",
        });
        yield* dispatch.authorize(registry, env, followUp);
      }),
    ),
  );
});
