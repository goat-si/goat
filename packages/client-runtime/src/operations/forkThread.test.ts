import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2ThreadForkError,
  RunId,
  ThreadId,
  type AuthSessionState,
  type OrchestrationV2ThreadForkResult,
  type OrchestrationV2ShellSnapshot,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createThreadEnvironmentAtoms } from "../state/threadCommands.ts";
import { forkThread, threadForkSourcePoint, type ForkThreadInput } from "./forkThread.ts";

vi.mock("../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const SOURCE_THREAD_ID = ThreadId.make("source-thread");
const TARGET_THREAD_ID = ThreadId.make("target-thread");
const RUN_ID = RunId.make("run-1");

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

const permit = { authorize: () => Effect.void };
const isForkError = Schema.is(OrchestrationV2ThreadForkError);

const input = (overrides?: Partial<ForkThreadInput>): ForkThreadInput => ({
  commandId: CommandId.make("fork-command"),
  sourceThreadId: SOURCE_THREAD_ID,
  targetThreadId: TARGET_THREAD_ID,
  sourcePoint: { type: "latest_stable" },
  workspace: { type: "current" },
  serverForks: true,
  ...overrides,
});

const SERVER_RESULT: OrchestrationV2ThreadForkResult = {
  sequence: 7,
  targetThreadId: TARGET_THREAD_ID,
  worktree: {
    branch: "goat/fork",
    worktreePath: "/workspace/fork",
    baseCommit: "abc123",
    uncommitted: "none",
    setupScript: "no-script",
  },
};

const makeHarness = Effect.fn("TestForkThread.makeHarness")(function* (options?: {
  readonly fork?: (requestInput: unknown) => Effect.Effect<unknown, OrchestrationV2ThreadForkError>;
  readonly dispatch?: (
    requestInput: unknown,
  ) => Effect.Effect<unknown, OrchestrationV2DispatchCommandError>;
}) {
  const forkRequests: unknown[] = [];
  const dispatchRequests: unknown[] = [];
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.forkThread]: (requestInput: unknown) => {
      forkRequests.push(requestInput);
      return options?.fork?.(requestInput) ?? Effect.succeed(SERVER_RESULT);
    },
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (requestInput: unknown) => {
      dispatchRequests.push(requestInput);
      return options?.dispatch?.(requestInput) ?? Effect.succeed({ sequence: 3 });
    },
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID, label: "Test environment" },
    session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return { forkRequests, dispatchRequests, supervisor };
});

const fork = (
  forkInput: ForkThreadInput,
  supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
) =>
  forkThread(forkInput).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(RpcPermissionGuard, permit),
  );

const forkFailure = Effect.fn("TestForkThread.failure")(function* (
  forkInput: ForkThreadInput,
  supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
) {
  const error = yield* fork(forkInput, supervisor).pipe(Effect.flip);
  if (!isForkError(error)) {
    return yield* Effect.die(new Error(`Unexpected failure: ${String(error)}`));
  }
  return error;
});

describe("fork thread", () => {
  it.effect(
    "sends one orchestration.forkThread request without serverForks when the server forks",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const forkInput = input({
          serverForks: true,
          workspace: { type: "worktree", includeUncommitted: false },
        });

        const result = yield* fork(forkInput, h.supervisor);

        expect(result).toEqual(SERVER_RESULT);
        expect(h.dispatchRequests).toEqual([]);
        expect(h.forkRequests).toHaveLength(1);
        expect(h.forkRequests[0]).toEqual({
          commandId: "fork-command",
          sourceThreadId: SOURCE_THREAD_ID,
          targetThreadId: TARGET_THREAD_ID,
          sourcePoint: { type: "latest_stable" },
          workspace: { type: "worktree", includeUncommitted: false },
        });
        expect(Object.hasOwn(h.forkRequests[0] as object, "serverForks")).toBe(false);
      }),
  );

  it.effect("dispatches thread.fork into the current checkout when the server cannot fork", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();

      const result = yield* fork(input({ serverForks: false }), h.supervisor);

      expect(result).toEqual({ sequence: 3, targetThreadId: TARGET_THREAD_ID });
      expect(h.forkRequests).toEqual([]);
      expect(h.dispatchRequests).toEqual([
        {
          type: "thread.fork",
          commandId: "fork-command",
          createdBy: "user",
          creationSource: "web",
          sourceThreadId: SOURCE_THREAD_ID,
          targetThreadId: TARGET_THREAD_ID,
          sourcePoint: { type: "latest_stable" },
        },
      ]);
      expect(Object.hasOwn(h.dispatchRequests[0] as object, "workspace")).toBe(false);
    }),
  );

  it.effect("refuses a worktree fork on an old server without sending a request", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();

      const error = yield* forkFailure(
        input({ serverForks: false, workspace: { type: "worktree" } }),
        h.supervisor,
      );

      expect(error.reason).toBe("unsupported");
      expect(h.forkRequests).toEqual([]);
      expect(h.dispatchRequests).toEqual([]);
    }),
  );

  it.effect("keeps a run source point unchanged on both the server and dispatch paths", () =>
    Effect.gen(function* () {
      expect(threadForkSourcePoint()).toEqual({ type: "latest_stable" });
      expect(threadForkSourcePoint(RUN_ID)).toEqual({ type: "run", runId: RUN_ID });

      const server = yield* makeHarness();
      yield* fork(
        input({ serverForks: true, sourcePoint: threadForkSourcePoint(RUN_ID) }),
        server.supervisor,
      );
      expect(server.forkRequests[0]).toMatchObject({ sourcePoint: { type: "run", runId: RUN_ID } });

      const legacy = yield* makeHarness();
      yield* fork(
        input({ serverForks: false, sourcePoint: threadForkSourcePoint(RUN_ID) }),
        legacy.supervisor,
      );
      expect(legacy.dispatchRequests[0]).toMatchObject({
        sourcePoint: { type: "run", runId: RUN_ID },
      });
    }),
  );

  it.effect("passes an uncommitted refusal through, then forks with uncommitted excluded", () =>
    Effect.gen(function* () {
      let calls = 0;
      const h = yield* makeHarness({
        fork: () => {
          calls++;
          return calls === 1
            ? Effect.fail(
                new OrchestrationV2ThreadForkError({
                  commandId: CommandId.make("fork-command"),
                  sourceThreadId: SOURCE_THREAD_ID,
                  reason: "uncommitted_unsupported",
                  message: "This checkout cannot carry uncommitted changes.",
                }),
              )
            : Effect.succeed(SERVER_RESULT);
        },
      });

      const refusal = yield* forkFailure(
        input({ serverForks: true, workspace: { type: "worktree" } }),
        h.supervisor,
      );
      expect(refusal.reason).toBe("uncommitted_unsupported");

      const result = yield* fork(
        input({
          serverForks: true,
          workspace: { type: "worktree", includeUncommitted: false },
        }),
        h.supervisor,
      );

      expect(result).toEqual(SERVER_RESULT);
      expect(h.forkRequests).toHaveLength(2);
      expect(h.forkRequests[1]).toMatchObject({
        workspace: { type: "worktree", includeUncommitted: false },
      });
    }),
  );

  it.effect("surfaces a legacy dispatch failure as a fork_failed error with its message", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        dispatch: () =>
          Effect.fail(
            new OrchestrationV2DispatchCommandError({
              commandId: CommandId.make("fork-command"),
              commandType: "thread.fork",
              message: "Source thread has no stable turn.",
            }),
          ),
      });

      const error = yield* forkFailure(input({ serverForks: false }), h.supervisor);

      expect(error.reason).toBe("fork_failed");
      expect(error.message).toBe("Source thread has no stable turn.");
    }),
  );
});

describe("fork thread command permission", () => {
  const harness = Effect.fn("TestForkThreadCommand.harness")(function* (allowed: boolean) {
    const forkRequests: unknown[] = [];
    const dispatchRequests: unknown[] = [];
    const client = {
      [ORCHESTRATION_V2_WS_METHODS.forkThread]: (requestInput: unknown) => {
        forkRequests.push(requestInput);
        return Effect.succeed(SERVER_RESULT);
      },
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (requestInput: unknown) => {
        dispatchRequests.push(requestInput);
        return Effect.succeed({ sequence: 3 });
      },
    };
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: { environmentId: ENVIRONMENT_ID, label: "Test environment" },
      session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
    } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const runtime = Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
          run: (_environmentId, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
      ),
    );
    const commands = createThreadEnvironmentAtoms(runtime, () =>
      Atom.make<OrchestrationV2ShellSnapshot | null>(null),
    );
    const registry = AtomRegistry.make();
    registry.mount(sessions(ENVIRONMENT_ID));
    registry.set(sessions(ENVIRONMENT_ID), AsyncResult.success(grant(allowed)));
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    return { commands, registry, forkRequests, dispatchRequests };
  });

  it.effect("refuses both fork routes without orchestration:operate and sends nothing", () =>
    Effect.gen(function* () {
      const h = yield* harness(false);
      const serverInput = input({ serverForks: true });
      const legacyInput = input({ serverForks: false });

      expect(h.registry.get(h.commands.fork.permissionAtom(ENVIRONMENT_ID, serverInput))).toBe(
        false,
      );
      expect(h.registry.get(h.commands.fork.permissionAtom(ENVIRONMENT_ID, legacyInput))).toBe(
        false,
      );

      const serverResult = yield* Effect.promise(() =>
        h.commands.fork.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: serverInput,
        }),
      );
      const legacyResult = yield* Effect.promise(() =>
        h.commands.fork.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { ...legacyInput, targetThreadId: ThreadId.make("target-thread-2") },
        }),
      );

      expect(serverResult._tag).toBe("Failure");
      expect(legacyResult._tag).toBe("Failure");
      if (serverResult._tag === "Failure") {
        expect((Cause.squash(serverResult.cause) as { _tag: string })._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }
      expect(h.forkRequests).toEqual([]);
      expect(h.dispatchRequests).toEqual([]);
    }),
  );

  it.effect("offers the fork command and runs it with orchestration:operate", () =>
    Effect.gen(function* () {
      const h = yield* harness(true);
      const serverInput = input({ serverForks: true });

      expect(h.registry.get(h.commands.fork.permissionAtom(ENVIRONMENT_ID, serverInput))).toBe(
        true,
      );
      const result = yield* Effect.promise(() =>
        h.commands.fork.run(h.registry, { environmentId: ENVIRONMENT_ID, input: serverInput }),
      );

      expect(result._tag).toBe("Success");
      expect(h.forkRequests).toHaveLength(1);
      expect(h.dispatchRequests).toEqual([]);
    }),
  );
});
