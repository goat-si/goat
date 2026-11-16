import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { recordSessionPublished } from "../connection/sessionPublication.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  type AtomCommandResult,
} from "./runtime.ts";

// Publication order is page-wide, so every test names its own computers.
const makeComputer = Effect.fn("TestCommandSession.makeComputer")(function* (name: string) {
  const environmentId = EnvironmentId.make(name);
  const session = yield* SubscriptionRef.make(Option.none<RpcSession>());
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: name,
      httpBaseUrl: "https://computer.example.test",
      wsBaseUrl: "wss://computer.example.test",
    }),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  // Numbered first, then made current, as the supervisor publishes a session.
  const publish = Effect.suspend(() => {
    const next = { label: `${name} session` } as unknown as RpcSession;
    recordSessionPublished(environmentId, next);
    return SubscriptionRef.set(session, Option.some(next));
  });
  return { environmentId, supervisor, publish, drop: SubscriptionRef.set(session, Option.none()) };
});

type Computer = Effect.Success<ReturnType<typeof makeComputer>>;

const makeLanes = Effect.fn("TestCommandSession.makeLanes")(function* (
  computers: ReadonlyArray<Computer>,
) {
  const supervisorOf = (environmentId: EnvironmentId) => {
    const computer = computers.find((entry) => entry.environmentId === environmentId);
    if (computer === undefined) throw new Error(`No computer ${environmentId}`);
    return computer.supervisor;
  };
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      run: (environmentId, effect) =>
        Effect.provideService(
          effect,
          EnvironmentSupervisor.EnvironmentSupervisor,
          supervisorOf(environmentId),
        ),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const headStarted = yield* Deferred.make<void>();
  const releaseHead = yield* Deferred.make<void>();
  const ran: Array<EnvironmentId> = [];
  const head = createEnvironmentCommand(runtime, {
    label: "test:head",
    scheduler,
    concurrency,
    execute: () =>
      Deferred.succeed(headStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseHead))),
  });
  const queued = createEnvironmentCommand(runtime, {
    label: "test:queued",
    scheduler,
    concurrency,
    // Builds its effect with a side effect, as plain-arrow commands such as openScratch do.
    execute: (_input: void, _registry, environmentId) => {
      ran.push(environmentId);
      return Effect.void;
    },
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  return {
    ran,
    headStarted: Deferred.await(headStarted),
    releaseHead: Deferred.succeed(releaseHead, undefined),
    pressHead: (computer: Computer) =>
      head.run(registry, { environmentId: computer.environmentId, input: undefined }),
    press: (computer: Computer) =>
      queued.run(registry, { environmentId: computer.environmentId, input: undefined }),
  };
});

const settled = <A, E>(pending: Promise<AtomCommandResult<A, E>>) => Effect.promise(() => pending);

function expectRefused(result: AtomCommandResult<unknown, unknown>, label: string) {
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(Cause.squash(result.cause)).toMatchObject({
    _tag: "EnvironmentRpcUnavailableError",
    environmentId: label,
    message: `${label} reconnected before this ran, so it was not sent. Try again.`,
  });
}

describe("queued computer commands", () => {
  it.effect(
    "a command pressed on one session and started on the next is refused and never runs",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer("replaced-session");
        const lanes = yield* makeLanes([computer]);
        yield* computer.publish;
        const head = lanes.pressHead(computer);
        yield* lanes.headStarted;
        const queued = lanes.press(computer);
        yield* computer.drop;
        yield* computer.publish;
        yield* lanes.releaseHead;

        expect((yield* settled(head))._tag).toBe("Success");
        expectRefused(yield* settled(queued), "replaced-session");
        expect(lanes.ran).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("a queued command still runs when its session did not change", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer("same-session");
      const lanes = yield* makeLanes([computer]);
      yield* computer.publish;
      const head = lanes.pressHead(computer);
      yield* lanes.headStarted;
      const queued = lanes.press(computer);
      yield* lanes.releaseHead;

      expect((yield* settled(head))._tag).toBe("Success");
      expect((yield* settled(queued))._tag).toBe("Success");
      expect(lanes.ran).toEqual([computer.environmentId]);
    }).pipe(Effect.scoped),
  );

  it.effect("a press made while disconnected is refused once a later session is up", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer("pressed-while-down");
      const lanes = yield* makeLanes([computer]);
      yield* computer.publish;
      const head = lanes.pressHead(computer);
      yield* lanes.headStarted;
      yield* computer.drop;
      const queued = lanes.press(computer);
      yield* computer.publish;
      yield* lanes.releaseHead;

      expect((yield* settled(head))._tag).toBe("Success");
      expectRefused(yield* settled(queued), "pressed-while-down");
      expect(lanes.ran).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("a press made before the computer's first session runs on that session", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer("first-session");
      const lanes = yield* makeLanes([computer]);
      const head = lanes.pressHead(computer);
      yield* lanes.headStarted;
      const queued = lanes.press(computer);
      yield* computer.publish;
      yield* lanes.releaseHead;

      expect((yield* settled(head))._tag).toBe("Success");
      expect((yield* settled(queued))._tag).toBe("Success");
      expect(lanes.ran).toEqual([computer.environmentId]);
    }).pipe(Effect.scoped),
  );

  it.effect("a press made after the new session was published runs on it", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer("pressed-after-reconnect");
      const lanes = yield* makeLanes([computer]);
      yield* computer.publish;
      const head = lanes.pressHead(computer);
      yield* lanes.headStarted;
      yield* computer.drop;
      yield* computer.publish;
      const queued = lanes.press(computer);
      yield* lanes.releaseHead;

      expect((yield* settled(head))._tag).toBe("Success");
      expect((yield* settled(queued))._tag).toBe("Success");
      expect(lanes.ran).toEqual([computer.environmentId]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "another computer reconnecting between the press and the start does not refuse it",
    () =>
      Effect.gen(function* () {
        const computerA = yield* makeComputer("computer-a");
        const computerB = yield* makeComputer("computer-b");
        const lanes = yield* makeLanes([computerA, computerB]);
        yield* computerA.publish;
        yield* computerB.publish;
        const head = lanes.pressHead(computerA);
        yield* lanes.headStarted;
        const queued = lanes.press(computerA);
        yield* computerB.drop;
        yield* computerB.publish;
        yield* lanes.releaseHead;

        expect((yield* settled(head))._tag).toBe("Success");
        expect((yield* settled(queued))._tag).toBe("Success");
        expect(lanes.ran).toEqual([computerA.environmentId]);
      }).pipe(Effect.scoped),
  );
});
