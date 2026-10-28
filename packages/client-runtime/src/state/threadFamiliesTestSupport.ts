import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetShellSnapshotError,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "./shell.ts";
import { createThreadFamilyAtoms } from "./threadFamilies.ts";
export const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-family"),
  label: "Family environment",
  httpBaseUrl: "https://family.example.test",
  wsBaseUrl: "wss://family.example.test",
});

export const makeFamilyHarness = Effect.fn(function* () {
  const started = yield* Queue.unbounded<{
    threadId: ThreadId;
    reply: import("effect/Deferred").Deferred<
      OrchestrationV2ThreadFamily,
      OrchestrationV2GetShellSnapshotError
    >;
    stopped: import("effect/Deferred").Deferred<void>;
  }>();
  const activity = { active: 0, peak: 0, calls: 0 };
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: Effect.fn("TestThreadFamilies.read")(function* ({
      threadId,
    }: {
      threadId: ThreadId;
    }) {
      const reply = yield* Deferred.make<
        OrchestrationV2ThreadFamily,
        OrchestrationV2GetShellSnapshotError
      >();
      const stopped = yield* Deferred.make<void>();
      activity.active++;
      activity.calls++;
      activity.peak = Math.max(activity.peak, activity.active);
      yield* Queue.offer(started, { threadId, reply, stopped });
      return yield* Deferred.await(reply).pipe(
        Effect.ensuring(Effect.sync(() => activity.active--)),
        Effect.ensuring(Deferred.succeed(stopped, undefined)),
      );
    }),
  } as unknown as WsRpcProtocolClient;
  const session = {
    client,
    initialConfig: Effect.succeed({ shellThreadFamilies: true } as never),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  } as unknown as RpcSession.RpcSession;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const supervisorFor = (id: EnvironmentId) =>
    id === TARGET.environmentId
      ? supervisor
      : { ...supervisor, target: new PrimaryConnectionTarget({ ...TARGET, environmentId: id }) };
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisorFor(id));
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    id,
    stream,
  ) =>
    Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisorFor(id));
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      run,
      followStream,
    } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const shellAt = (
    generation: number,
    threads: readonly OrchestrationV2ThreadShell[] = [],
  ): EnvironmentShellState => ({
    ...EMPTY_SHELL_STATE,
    status: "live",
    authoritativeSession: session,
    generation,
    snapshot: Option.some({
      schemaVersion: 1,
      snapshotSequence: generation,
      projects: [],
      threads,
      archivedThreads: [],
    } as OrchestrationV2ShellSnapshot),
  });
  const shells = Atom.family((_id: EnvironmentId) => Atom.make(AsyncResult.success(shellAt(1))));
  const shell = shells(TARGET.environmentId);
  const families = createThreadFamilyAtoms(runtime, shells);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (r) =>
    Effect.sync(() => r.dispose()),
  );
  return {
    started,
    activity,
    session,
    supervisor,
    runtime,
    shellAt,
    shell,
    shells,
    families,
    registry,
  };
});
