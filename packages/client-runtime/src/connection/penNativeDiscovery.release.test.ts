import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  PenRouteGateway,
  PenViewerPolicy,
  type PenMembersInput,
} from "../platform/capabilities.ts";
import { ConnectionPersistenceError } from "../platform/persistence.ts";
import { PenConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import { PenConnectionTarget, penConnectionId } from "./model.ts";
import { PenMembership } from "./penMembership.ts";
import { makePenNativeDiscovery } from "./penNativeDiscovery.ts";
import { EnvironmentRegistry } from "./registry.ts";

const env = EnvironmentId.make("env");
const pin = {
  meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
  nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
  noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
};
const id = penConnectionId(pin.meshId, pin.nodeId);
const saved = new Map<EnvironmentId, ConnectionCatalogEntry>([
  [
    env,
    {
      enabled: true,
      target: new PenConnectionTarget({ environmentId: env, label: "Node", connectionId: id }),
      profile: Option.some(
        new PenConnectionProfile({ ...pin, environmentId: env, label: "Node", connectionId: id }),
      ),
    },
  ],
]);
const ready = {
  kind: "ready" as const,
  seq: 1,
  meshId: pin.meshId,
  selfNodeId: "self",
  members: [
    {
      nodeId: pin.nodeId,
      name: "Node",
      online: true,
      noisePub: pin.noisePub,
      route: { kind: "refused" as const, reason: "not-pen-route" as const },
    },
  ],
};

const discover = <E>(
  body: (
    discovery: Effect.Success<ReturnType<typeof makePenNativeDiscovery>>,
  ) => Effect.Effect<void, E, HttpClient.HttpClient>,
  options: {
    readonly initial: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
    readonly descriptor: "ok" | "unreachable" | "hangs";
    readonly register: "ok" | "fails";
    readonly opening?: {
      readonly started: Deferred.Deferred<void>;
      readonly done: Deferred.Deferred<void>;
    };
  },
) =>
  Effect.gen(function* () {
    const closed: string[] = [];
    const entries = yield* SubscriptionRef.make(options.initial);
    const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(Option.some(ready));
    const unused = () => Effect.die("unexpected registry call");
    const unusedStream = () => Stream.die("unexpected registry stream");
    const registry = EnvironmentRegistry.of({
      entries,
      networkStatus: yield* SubscriptionRef.make<"unknown" | "online" | "offline">("online"),
      start: Effect.void,
      register: () =>
        options.register === "ok"
          ? Effect.succeed(false)
          : Effect.fail(
              new ConnectionPersistenceError({ operation: "register-connection", message: "full" }),
            ),
      registerPlatform: unused,
      assertKnownAddress: unused,
      reconcilePlatform: unused,
      remove: unused,
      removeRoute: unused,
      reorderRoutes: unused,
      removeRelayEnvironments: unused,
      retryNow: unused,
      reconnect: unused,
      setEnabled: unused,
      setCompatibility: unused,
      state: unused,
      stateChanges: unusedStream,
      run: unused,
      runStream: unusedStream,
      followStream: unusedStream,
    });
    yield* Effect.gen(function* () {
      yield* body(yield* makePenNativeDiscovery());
    }).pipe(
      Effect.provideService(EnvironmentRegistry, registry),
      Effect.provideService(PenMembership, { latest, admit: () => Effect.void }),
      Effect.provideService(PenViewerPolicy, { enabled: true }),
      Effect.provideService(
        PenRouteGateway,
        Option.some({
          open: () =>
            Effect.gen(function* () {
              if (options.opening !== undefined) {
                yield* Deferred.succeed(options.opening.started, undefined);
                yield* Deferred.await(options.opening.done);
              }
              return {
                kind: "open" as const,
                httpBaseUrl: `http://127.0.0.1/pen-route/${"a".repeat(43)}`,
                socketUrl: "ws://127.0.0.1/ws",
              };
            }),
          close: (closing) => Effect.sync(() => void closed.push(closing.nodeId)),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          (options.descriptor === "hangs" ? Effect.never : Effect.void).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                options.descriptor === "ok"
                  ? Response.json({
                      environmentId: "other",
                      label: "Node",
                      platform: { os: "darwin", arch: "arm64" },
                      serverVersion: "1.0.0",
                      capabilities: { repositoryIdentity: true },
                    })
                  : new Response("bad gateway", { status: 502 }),
              ),
            ),
          ),
        ),
      ),
    );
    return closed;
  });

it.effect(
  "removing the environment that holds a member's route closes its link, whoever opened it",
  () =>
    Effect.gen(function* () {
      const closed = yield* discover(
        (discovery) =>
          Effect.gen(function* () {
            yield* discovery.release(saved);
            yield* discovery.release(new Map());
          }),
        { initial: saved, descriptor: "ok", register: "ok" },
      );
      expect(closed).toEqual([pin.nodeId]);
    }),
);

it.effect.each(["unreachable", "refused"] as const)(
  "a link discovery opened is given back when the member is %s and no saved route holds it",
  (outcome) =>
    Effect.gen(function* () {
      const closed = yield* discover((discovery) => discovery.pass(ready), {
        initial: new Map(),
        descriptor: outcome === "unreachable" ? "unreachable" : "ok",
        register: outcome === "refused" ? "fails" : "ok",
      });
      expect(closed).toEqual([pin.nodeId]);
    }),
);

it.effect("a link a saved route holds stays open when discovery cannot reach the member", () =>
  Effect.gen(function* () {
    const closed = yield* discover((discovery) => discovery.pass(ready), {
      initial: saved,
      descriptor: "unreachable",
      register: "ok",
    });
    expect(closed).toEqual([]);
  }),
);

it.effect("a discovery cut short while the link opens still gives the link back", () =>
  Effect.gen(function* () {
    const opening = { started: yield* Deferred.make<void>(), done: yield* Deferred.make<void>() };
    const closed = yield* discover(
      (discovery) =>
        Effect.gen(function* () {
          const passing = yield* Effect.forkChild(discovery.pass(ready));
          yield* Deferred.await(opening.started);
          // A newer member list interrupts the pass while the gateway is still opening the link.
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(passing));
          yield* Deferred.succeed(opening.done, undefined);
          yield* Fiber.join(interrupting);
        }),
      { initial: new Map(), descriptor: "hangs", register: "ok", opening },
    );
    expect(closed).toEqual([pin.nodeId]);
  }),
);

it.effect("switching Pen machines off closes a saved member's link, whoever opened it", () =>
  Effect.gen(function* () {
    const closed = yield* discover((discovery) => discovery.pass({ kind: "disabled" }), {
      initial: saved,
      descriptor: "ok",
      register: "ok",
    });
    expect(closed).toEqual([pin.nodeId]);
  }),
);
