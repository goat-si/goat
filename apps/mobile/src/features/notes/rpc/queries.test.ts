import { EnvironmentId, NoteError } from "@goat/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@goat/client-runtime/connection";
import type { RpcSession } from "@goat/client-runtime/rpc";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { notesQueries } from "./queries";
import { notesRpc } from "./notes";

vi.mock("../../../connection/runtime", () => ({
  connectionAtomRuntime: Atom.runtime(
    Layer.suspend(() =>
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
    ),
  ),
}));

let environmentRegistry: EnvironmentRegistry.EnvironmentRegistry["Service"];
const environmentId = EnvironmentId.make("notes-hub");
const target = { environmentId, input: {} };
const targets = { hub: { projects: [] }, hosts: [] };
const connectionState = (phase: SupervisorConnectionState["phase"]): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase,
  generation: 1,
});

const harness = (phase: SupervisorConnectionState["phase"] = "connecting") =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(connectionState(phase));
    const session = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Notes hub",
        httpBaseUrl: "https://notes.example.test",
        wsBaseUrl: "wss://notes.example.test",
      }),
      state,
      session,
      prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
      _id,
      stream,
    ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    environmentRegistry = {
      run,
      followStream,
    } as EnvironmentRegistry.EnvironmentRegistry["Service"];
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const connect = SubscriptionRef.set(session, Option.some({} as RpcSession)).pipe(
      Effect.andThen(SubscriptionRef.set(state, connectionState("connected"))),
    );
    return { registry, state, session, connect };
  });

const read = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) =>
  AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(
    Effect.tap(() => Effect.yieldNow),
  );

afterEach(() => vi.restoreAllMocks());

describe("connection-aware mobile note target reads", () => {
  it.effect.each(["workTargets", "workTargetProjects"] as const)(
    "%s waits for the initial connection and retries when the session reconnects",
    (name) =>
      Effect.scoped(
        Effect.gen(function* () {
          vi.spyOn(notesRpc.workTargets, "run").mockResolvedValue(
            AsyncResult.success({ hub: { projects: [] }, hosts: [] }),
          );
          vi.spyOn(notesRpc.workTargetProjects, "run").mockResolvedValue(
            AsyncResult.success({ projects: [], truncated: false }),
          );
          const command = vi.spyOn(notesRpc[name], "run");
          const { registry, state, session, connect } = yield* harness();
          const atom =
            name === "workTargets"
              ? notesQueries
                  .workTargets({ environmentId, input: {} })
                  .pipe(Atom.map(AsyncResult.map(() => undefined)))
              : notesQueries
                  .workTargetProjects({ environmentId, input: { host: "studio" } })
                  .pipe(Atom.map(AsyncResult.map(() => undefined)));
          const unmount = registry.mount(atom);
          yield* Effect.addFinalizer(() => Effect.sync(unmount));
          yield* Effect.yieldNow;
          expect(command).not.toHaveBeenCalled();
          expect(registry.get(atom).waiting).toBe(true);
          yield* connect;
          yield* read(registry, atom);
          expect(command).toHaveBeenCalledTimes(1);
          yield* SubscriptionRef.set(session, Option.none());
          yield* SubscriptionRef.set(state, connectionState("connecting"));
          yield* Effect.yieldNow;
          expect(command).toHaveBeenCalledTimes(1);
          yield* connect;
          yield* read(registry, atom);
          expect(command).toHaveBeenCalledTimes(2);
        }),
      ),
  );

  it.effect(
    "recovers targets after an unavailable connection becomes connected without Reload",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const command = vi
            .spyOn(notesRpc.workTargets, "run")
            .mockResolvedValue(AsyncResult.success(targets));
          const { registry, connect } = yield* harness("available");
          const atom = notesQueries.workTargets(target);
          const unmount = registry.mount(atom);
          yield* Effect.addFinalizer(() => Effect.sync(unmount));
          expect((yield* Effect.exit(read(registry, atom)))._tag).toBe("Failure");
          expect(command).not.toHaveBeenCalled();
          yield* connect;
          yield* AtomRegistry.toStream(registry, atom).pipe(
            Stream.filter((result) => result._tag === "Success" && !result.waiting),
            Stream.take(1),
            Stream.runDrain,
          );
          expect(yield* read(registry, atom)).toEqual(targets);
          expect(command).toHaveBeenCalledTimes(1);
        }),
      ),
  );

  it.effect("Reload retries a failed targets command and clears its cached error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const command = vi
          .spyOn(notesRpc.workTargets, "run")
          .mockResolvedValueOnce(
            AsyncResult.failure(
              Cause.fail(
                new NoteError({
                  reason: "storage",
                  message: "Targets unavailable",
                }),
              ),
            ),
          )
          .mockResolvedValue(AsyncResult.success(targets));
        const { registry, connect } = yield* harness();
        yield* connect;
        const atom = notesQueries.workTargets(target);
        const unmount = registry.mount(atom);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        expect((yield* Effect.exit(read(registry, atom)))._tag).toBe("Failure");
        expect(command).toHaveBeenCalledTimes(1);
        registry.refresh(atom);
        expect(yield* read(registry, atom)).toEqual(targets);
        expect(registry.get(atom)._tag).toBe("Success");
        expect(command).toHaveBeenCalledTimes(2);
      }),
    ),
  );
});
