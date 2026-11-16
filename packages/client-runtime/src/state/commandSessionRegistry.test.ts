import { vi } from "vite-plus/test";
vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

import { EnvironmentId, ProjectId, WS_METHODS } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/reactivity";

import { RelayConnectionRegistration } from "../connection/catalog.ts";
import type { ConnectionAttemptError } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  RELAY_TARGET,
  SECOND_TARGET,
  TARGET,
  awaitConnectionState,
  makeHarness,
} from "../connection/registry.testkit.ts";
import type { ConnectionPersistenceError } from "../platform/persistence.ts";
import type * as RpcSession from "../rpc/session.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  type AtomCommandResult,
} from "./runtime.ts";

/** Each new session answers Scratch requests and records which session received them. */
function recordingSessions() {
  const received: Array<string> = [];
  const opened = new Map<EnvironmentId, number>();
  const sessionClient = (environmentId: EnvironmentId) => {
    const count = (opened.get(environmentId) ?? 0) + 1;
    opened.set(environmentId, count);
    return {
      [WS_METHODS.projectsEnsureScratch]: () =>
        Effect.sync(() => {
          received.push(`${environmentId}#${count}`);
          return { projectId: ProjectId.make("scratch") };
        }),
    } as unknown as RpcSession.RpcSession["client"];
  };
  return { received, sessionClient };
}

interface Hold {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

/** A real registry, a lane per computer, and a request command that can wait on it. */
const makeLane = Effect.fn("TestCommandSessionRegistry.makeLane")(function* (
  layer: Layer.Layer<
    EnvironmentRegistry.EnvironmentRegistry,
    ConnectionPersistenceError | ConnectionAttemptError
  >,
) {
  const registry = Context.get(yield* Layer.build(layer), EnvironmentRegistry.EnvironmentRegistry);
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry));
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const head = createEnvironmentCommand(runtime, {
    label: "test:head",
    scheduler,
    concurrency,
    execute: (hold: Hold) =>
      Deferred.succeed(hold.started, undefined).pipe(Effect.andThen(Deferred.await(hold.release))),
  });
  const request = createEnvironmentRpcCommand(runtime, {
    label: "test:ensure-scratch",
    tag: WS_METHODS.projectsEnsureScratch,
    scheduler,
    concurrency,
  });
  const atoms = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  return {
    registry,
    /** Occupies the computer's lane until released. */
    hold: Effect.fn("TestCommandSessionRegistry.hold")(function* (environmentId: EnvironmentId) {
      const input: Hold = {
        started: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      const result = head.run(atoms, { environmentId, input });
      yield* Deferred.await(input.started);
      return { result, release: Deferred.succeed(input.release, undefined) };
    }),
    press: (environmentId: EnvironmentId) => request.run(atoms, { environmentId, input: {} }),
  };
});

const settled = <A, E>(pending: Promise<AtomCommandResult<A, E>>) => Effect.promise(() => pending);

function expectNotSent(result: AtomCommandResult<unknown, unknown>, label: string) {
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(Cause.squash(result.cause)).toMatchObject({
    _tag: "EnvironmentRpcUnavailableError",
    message: `${label} reconnected before this ran, so it was not sent. Try again.`,
  });
}

const connected = (
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
  generation = 1,
) =>
  awaitConnectionState(
    registry,
    environmentId,
    (state) => state.phase === "connected" && state.generation >= generation,
  );

describe("queued commands at the registry and request boundary", () => {
  it.effect("a command queued on one session sends nothing to the session that replaced it", () =>
    Effect.gen(function* () {
      const sessions = recordingSessions();
      const harness = yield* makeHarness([TARGET], [], [], {
        sessionClient: sessions.sessionClient,
      });
      const lane = yield* makeLane(harness.layer);
      yield* lane.registry.start;
      yield* connected(lane.registry, TARGET.environmentId);
      const head = yield* lane.hold(TARGET.environmentId);
      const queued = lane.press(TARGET.environmentId);
      yield* lane.registry.reconnect(TARGET.environmentId);
      yield* connected(lane.registry, TARGET.environmentId, 2);
      yield* head.release;

      expect((yield* settled(head.result))._tag).toBe("Success");
      expectNotSent(yield* settled(queued), TARGET.label);
      expect(sessions.received).toEqual([]);
      expect((yield* settled(lane.press(TARGET.environmentId)))._tag).toBe("Success");
      expect(sessions.received).toEqual([`${TARGET.environmentId}#2`]);
    }).pipe(Effect.scoped),
  );

  it.effect("a command queued on a session that stays up reaches that session", () =>
    Effect.gen(function* () {
      const sessions = recordingSessions();
      const harness = yield* makeHarness([TARGET], [], [], {
        sessionClient: sessions.sessionClient,
      });
      const lane = yield* makeLane(harness.layer);
      yield* lane.registry.start;
      yield* connected(lane.registry, TARGET.environmentId);
      const head = yield* lane.hold(TARGET.environmentId);
      const queued = lane.press(TARGET.environmentId);
      yield* head.release;

      expect((yield* settled(head.result))._tag).toBe("Success");
      expect((yield* settled(queued))._tag).toBe("Success");
      expect(sessions.received).toEqual([`${TARGET.environmentId}#1`]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "two registries in one page, for different computers, do not refuse each other's commands",
    () =>
      Effect.gen(function* () {
        const sessions = recordingSessions();
        const secondConnects = yield* Deferred.make<void>();
        const first = yield* makeLane(
          (yield* makeHarness([TARGET], [], [], { sessionClient: sessions.sessionClient })).layer,
        );
        const second = yield* makeLane(
          (yield* makeHarness([SECOND_TARGET], [], [], {
            sessionClient: sessions.sessionClient,
            beforeSessionConnect: () => Deferred.await(secondConnects),
          })).layer,
        );
        const one = TARGET.environmentId;
        const two = SECOND_TARGET.environmentId;
        yield* first.registry.start;
        yield* connected(first.registry, one);
        yield* second.registry.start;

        // Pressed before the second computer's first session, while the first computer reconnects.
        const beforeFirst = yield* second.hold(two);
        const pressedBeforeFirst = second.press(two);
        yield* first.registry.reconnect(one);
        yield* connected(first.registry, one, 2);
        yield* Deferred.succeed(secondConnects, undefined);
        yield* connected(second.registry, two);
        yield* beforeFirst.release;
        expect((yield* settled(beforeFirst.result))._tag).toBe("Success");
        expect((yield* settled(pressedBeforeFirst))._tag).toBe("Success");

        // Pressed on the second computer's session, while the first computer reconnects again.
        const onSession = yield* second.hold(two);
        const pressedOnSession = second.press(two);
        yield* first.registry.reconnect(one);
        yield* connected(first.registry, one, 3);
        yield* onSession.release;
        expect((yield* settled(onSession.result))._tag).toBe("Success");
        expect((yield* settled(pressedOnSession))._tag).toBe("Success");

        expect(sessions.received).toEqual([`${two}#1`, `${two}#1`]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a press queued before a re-added computer's new first session is refused, and pressing again works",
    () =>
      Effect.gen(function* () {
        const sessions = recordingSessions();
        const harness = yield* makeHarness([RELAY_TARGET], [], [], {
          sessionClient: sessions.sessionClient,
        });
        const lane = yield* makeLane(harness.layer);
        const environmentId = RELAY_TARGET.environmentId;
        yield* lane.registry.start;
        yield* connected(lane.registry, environmentId);
        const head = yield* lane.hold(environmentId);
        yield* lane.registry.remove(environmentId);
        const queued = lane.press(environmentId);
        yield* lane.registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }));
        yield* connected(lane.registry, environmentId);
        yield* head.release;

        expect((yield* settled(head.result))._tag).toBe("Success");
        expectNotSent(yield* settled(queued), RELAY_TARGET.label);
        expect(sessions.received).toEqual([]);
        expect((yield* settled(lane.press(environmentId)))._tag).toBe("Success");
        expect(sessions.received).toEqual([`${environmentId}#2`]);
      }).pipe(Effect.scoped),
  );
});
