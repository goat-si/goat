import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  ThreadId,
  TurnItemId,
  SshHandoffProgressResult,
  SshHostResult,
  SshHostProbeError,
  WS_METHODS,
  type AuthSessionState,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createSshHostState,
  sshHostPollDelay,
  sshHostProbeErrorText,
  sshHostProgressComplete,
  sshHostProgressText,
} from "./sshHost.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: sessions,
    preparedConnectionValueAtom: prepared,
  }),
}));
vi.mock("../rpc/client.ts", async (original) => ({
  ...(await original<typeof import("../rpc/client.ts")>()),
  requestGuarded: (tag: string, input: unknown) => Effect.suspend(() => transport(tag, input)),
}));
const transport =
  vi.fn<(tag: string, input: unknown) => Effect.Effect<unknown, Schema.SchemaError>>();
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.initial()),
);
const prepared = Atom.family((_id: EnvironmentId) =>
  Atom.make<Option.Option<PreparedConnection>>(Option.none()),
);
const origin = EnvironmentId.make("origin");
const other = EnvironmentId.make("other");
const input = { threadId: ThreadId.make("thread"), handoffId: TurnItemId.make("handoff") };
const base = { host: "vps-1", runtimeVersion: "0.4.2", requestedVersion: "0.4.2" };
const runtimeReady: SshHostResult = {
  kind: "ok",
  status: {
    ...base,
    state: "ready",
    setup: { operationId: "operation", generation: 2, stage: "diagnosis" },
  },
};
const progress: SshHandoffProgressResult = {
  kind: "available",
  host: "vps-1",
  operationId: "operation",
  generation: 2,
  result: runtimeReady,
};
const decodeProgress = Schema.decodeUnknownEffect(SshHandoffProgressResult);
const grant = (permissions: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  permissions,
  scopes: permissions,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
});
const fullGrant = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthEnvironmentMaintainScope,
];
const route = {
  target: new PrimaryConnectionTarget({
    environmentId: origin,
    label: "Origin",
    httpBaseUrl: "https://origin.test",
    wsBaseUrl: "wss://origin.test",
  }),
} as unknown as PreparedConnection;

const harness = Effect.gen(function* () {
  const supervisor = EnvironmentSupervisor.of({
    target: route.target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(Option.some({} as RpcSession)),
    prepared: yield* SubscriptionRef.make(Option.some(route)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const service = EnvironmentRegistry.of({
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const state = createSshHostState(Atom.runtime(Layer.succeed(EnvironmentRegistry, service)));
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(sessions(origin), AsyncResult.success(grant(fullGrant)));
  registry.set(prepared(origin), Option.some(route));
  return { state, registry };
});

describe("SSH origin progress", () => {
  it("keeps polling a ready runtime until this operation's diagnosis completes", () => {
    expect(sshHostPollDelay(runtimeReady)).toBe(1_000);
    expect(sshHostProgressComplete(progress)).toBe(false);
    expect(sshHostProgressText(progress)).toBe("Runtime ready · Checking providers");
    const complete: SshHandoffProgressResult = {
      ...progress,
      kind: "available",
      host: "vps-1",
      operationId: "operation",
      generation: 2,
      result: {
        kind: "ok",
        status: {
          ...base,
          state: "ready",
          setup: { operationId: "operation", generation: 2, stage: "complete" },
        },
      },
    };
    expect(sshHostProgressComplete(complete)).toBe(true);
    if (complete.kind === "available") expect(sshHostPollDelay(complete.result)).toBeNull();
    expect(sshHostProgressComplete({ ...complete, operationId: "old-operation" })).toBe(false);
    expect(sshHostProgressComplete({ ...complete, generation: 1 })).toBe(false);
  });
  it("keeps a fresh approval polling until its continuation starts", () => {
    const result: SshHostResult = {
      kind: "ok",
      status: {
        ...base,
        state: "trust_pending",
        setup: { operationId: "operation", generation: 2, stage: "runtime" },
      },
    };
    expect(sshHostPollDelay(result)).toBeNull();
    expect(sshHostPollDelay(result, true)).toBe(1_000);
  });
  it("keeps waiting slow, and stops at recovery states without inventing success", () => {
    expect(sshHostPollDelay({ kind: "ok", status: { ...base, state: "update_waiting" } })).toBe(
      10_000,
    );
    expect(sshHostPollDelay({ kind: "ok", status: { ...base, state: "auth_failed" } })).toBeNull();
    expect(sshHostProgressComplete({ kind: "unavailable", reason: "superseded" })).toBe(false);
    expect(sshHostProgressText({ kind: "unavailable", reason: "expired" })).toBe(
      "This request expired or was replaced. Ask the agent again.",
    );
  });
  it.live("restores a completed card by thread and handoff ID with no Desktop gateway", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, registry } = yield* harness;
        transport
          .mockReset()
          .mockImplementation((tag) =>
            tag === WS_METHODS.sshHostHandoffProgress
              ? decodeProgress(progress)
              : Effect.succeed(runtimeReady),
          );
        const target = { environmentId: origin, input, targetPath: "ssh.host_add" };
        const atom = state.handoffProgress(target);
        registry.mount(atom);
        expect(yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true })).toEqual(
          progress,
        );
        expect(transport).toHaveBeenCalledWith(WS_METHODS.sshHostHandoffProgress, input);
        const statusAtom = state.status({ environmentId: origin, input: { host: "vps-1" } });
        registry.mount(statusAtom);
        expect(
          yield* AtomRegistry.getResult(registry, statusAtom, { suspendOnWaiting: true }),
        ).toEqual(runtimeReady);
        expect(transport).toHaveBeenCalledWith(WS_METHODS.sshHostStatus, { host: "vps-1" });
        registry.set(sessions(origin), AsyncResult.success(grant([])));
        expect(Option.isNone(AsyncResult.value(registry.get(atom)))).toBe(true);
        expect(Option.isNone(AsyncResult.value(registry.get(statusAtom)))).toBe(true);
        expect(registry.get(state.progressPermissionAtom(other, "ssh.host_add"))).toBe(false);
      }),
    ),
  );
  it.live.each([
    { path: "ssh.host_add", scope: AuthSettingsWriteScope },
    { path: "ssh.host_prepare", scope: AuthEnvironmentMaintainScope },
    { path: "ssh.runtime_update", scope: AuthEnvironmentMaintainScope },
  ] as const)("requires read, operate and the target scope for $path", ({ path, scope }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, registry } = yield* harness;
        const permission = state.progressPermissionAtom(origin, path);
        registry.set(
          sessions(origin),
          AsyncResult.success(grant([AuthOrchestrationReadScope, AuthOrchestrationOperateScope])),
        );
        expect(registry.get(permission)).toBe(false);
        registry.set(
          sessions(origin),
          AsyncResult.success(grant([AuthOrchestrationReadScope, scope])),
        );
        expect(registry.get(permission)).toBe(false);
        registry.set(
          sessions(origin),
          AsyncResult.success(
            grant([AuthOrchestrationReadScope, AuthOrchestrationOperateScope, scope]),
          ),
        );
        expect(registry.get(permission)).toBe(true);
      }),
    ),
  );
  it.live("drops late results after revocation and rejects a mismatched operation binding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, registry } = yield* harness;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        transport.mockReset().mockImplementation(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            yield* Deferred.succeed(finished, undefined);
            return progress;
          }),
        );
        const target = { environmentId: origin, input, targetPath: "ssh.host_add" };
        const atom = state.handoffProgress(target);
        registry.mount(atom);
        yield* Deferred.await(entered);
        registry.set(sessions(origin), AsyncResult.success(grant([])));
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(finished);
        expect(Option.isNone(AsyncResult.value(registry.get(atom)))).toBe(true);
        transport.mockImplementation(() => decodeProgress({ ...progress, generation: 99 }));
        registry.set(sessions(origin), AsyncResult.success(grant(fullGrant)));
        const error = yield* AtomRegistry.getResult(registry, atom, {
          suspendOnWaiting: true,
        }).pipe(Effect.flip);
        expect(error).toBeDefined();
        expect(registry.get(atom)._tag).toBe("Failure");
      }),
    ),
  );
});

describe("SSH probe failure copy", () => {
  it.each([
    {
      reason: "unreachable",
      expected: "Can't reach vps-1. Check the address and that SSH is running, then try again.",
    },
    {
      reason: "connection_refused",
      expected: "vps-1 refused the connection on port 2222. Check the SSH port, then try again.",
    },
    {
      reason: "alias_conflict",
      expected: "vps-1 is already used by another SSH host. Pick a different name.",
    },
    { reason: "invalid_request", expected: "The SSH address is not valid." },
    { reason: "operation_failed", expected: "The SSH address is not valid." },
  ] as const)("presents $reason without parsing SSH output", ({ reason, expected }) => {
    const error = new SshHostProbeError({
      host: "vps-1",
      reason,
      message: "The SSH address is not valid.",
    });
    expect(sshHostProbeErrorText(error, 2222)).toBe(expected);
  });
});
