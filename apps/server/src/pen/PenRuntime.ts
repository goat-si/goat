// @effect-diagnostics nodeBuiltinImport:off -- K comes from node:crypto.
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";

import type { PenTrustRoot, SessionPrincipalKind } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { canResolveHumanStep, sessionResolver } from "../handoffs/HumanStepAuthority.ts";
import * as Settings from "../serverSettings.ts";
import { PenEnablement } from "./PenEnablement.ts";
import * as PenListener from "./PenListener.ts";
import { watchSnapshots } from "./PenMesh.ts";
import { checkPenPlatform, type PlatformProbe } from "./penPlatformGate.ts";
import { PenRegistrar } from "./PenRegistrar.ts";
import { PenSessions } from "./PenSessions.ts";

/** The main HTTP server, which the Pen listener hands admitted requests to; set at startup. */
export class MainHttpServer extends Context.Service<
  MainHttpServer,
  { readonly server: Deferred.Deferred<NodeHttp.Server> }
>()("goat/pen/PenRuntime/MainHttpServer") {}
export const layerMainHttpServer = Layer.effect(
  MainHttpServer,
  Effect.map(Deferred.make<NodeHttp.Server>(), (server) => ({ server })),
);

export class PenTrustRootError extends Data.TaggedError("PenTrustRootError")<{
  readonly reason: string;
}> {}

export type PenStatus =
  | { readonly state: "off"; readonly reason: string }
  | { readonly state: "listening"; readonly generation: number; readonly port: number };

export class PenRuntime extends Context.Service<
  PenRuntime,
  {
    /** The person-only confirmation of design §7, and the only writer of the pen setting. */
    readonly replaceTrustRoot: (
      session: { readonly principalKind?: SessionPrincipalKind | undefined },
      root: PenTrustRoot | null,
    ) => Effect.Effect<void, PenTrustRootError>;
    readonly status: Effect.Effect<PenStatus>;
  }
>()("goat/pen/PenRuntime") {}

/** How long a watch that ended waits before Pen's member list is watched again. */
const REWATCH = "5 seconds";
const sameRoot = (left: PenTrustRoot | null, right: PenTrustRoot | null) =>
  JSON.stringify(left) === JSON.stringify(right);

export const make = Effect.fn("PenRuntime.make")(function* (
  options: { readonly probe?: PlatformProbe } = {},
) {
  const enablement = yield* PenEnablement;
  const status = yield* Ref.make<PenStatus>({
    state: "off",
    reason: "Pen is not enabled in this build.",
  });
  if (!enablement.enabled)
    return PenRuntime.of({
      replaceTrustRoot: Effect.fn("PenRuntime.replaceTrustRoot")(function* () {
        return yield* new PenTrustRootError({ reason: "Pen is not enabled in this build." });
      }),
      status: Ref.get(status),
    });

  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* Settings.ServerSettingsService;
  const penSessions = yield* PenSessions;
  const registrar = yield* PenRegistrar;
  const main = yield* MainHttpServer;
  const generation = yield* Ref.make(0);
  const live = yield* Ref.make<Scope.Closeable | undefined>(undefined);
  const desired = yield* Ref.make<PenTrustRoot | null>(null);
  const outer = yield* Effect.scope;
  const gate = (root: PenTrustRoot) => checkPenPlatform(root, options.probe);

  /** Ends the live generation: listener, sockets, registration, watch, every Pen-bound session. */
  const teardown = Effect.fn("PenRuntime.teardown")(function* (reason: string) {
    yield* Ref.set(status, { state: "off", reason });
    yield* Ref.update(generation, (current) => current + 1);
    yield* penSessions.setGeneration(undefined);
    const current = yield* Ref.getAndSet(live, undefined);
    if (current !== undefined) yield* Scope.close(current, Exit.void);
    yield* penSessions.revokeAll.pipe(Effect.ignore);
  });
  const fence = (reason: string): Effect.Effect<void> =>
    penSessions.withIssueLock(teardown(reason));
  const fenceLater = (reason: string): Effect.Effect<void> =>
    fence(reason).pipe(Effect.forkIn(outer), Effect.asVoid);

  const off = (reason: string) => Ref.set(status, { state: "off", reason });

  const watchMembers = Effect.fn("PenRuntime.watchMembers")(function* (root: PenTrustRoot) {
    const verdict = yield* gate(root);
    if (!verdict.ok) {
      // The fence closes this generation's scope, which ends this watch.
      yield* fenceLater(verdict.reason);
      return yield* Effect.never;
    }
    yield* watchSnapshots(root.stateDir, (snapshot) =>
      snapshot.mesh !== root.meshId || snapshot.self !== root.nodeId
        ? fenceLater("Pen's mesh is no longer the one a person confirmed.")
        : penSessions.revokeExcept(snapshot.members).pipe(Effect.ignore),
    ).pipe(Effect.scoped, Effect.ignore);
    yield* Effect.sleep(REWATCH);
  });

  /** Listener, registration and member watch of one generation, in the caller's scope. */
  const open = Effect.fn("PenRuntime.open")(function* (
    root: PenTrustRoot,
    key: Uint8Array,
    current: number,
  ) {
    const listener = yield* PenListener.make({
      pin: { key, meshId: root.meshId, nodeId: root.nodeId },
      generation: current,
      mainServer: yield* Deferred.await(main.server),
      admitAccept: gate(root).pipe(Effect.map((result) => result.ok)),
      onUnsafe: fenceLater("The Pen paths are no longer safe."),
    });
    const beforeSpawn = yield* gate(root);
    if (!beforeSpawn.ok) return { ok: false as const, reason: beforeSpawn.reason };
    const registration = yield* registrar.register({
      executablePath: root.executablePath,
      stateDir: root.stateDir,
      port: listener.port,
      key,
    });
    yield* Deferred.await(registration.lost).pipe(
      Effect.andThen(fenceLater("Pen no longer holds GOAT's registration.")),
      Effect.forkScoped,
    );
    yield* watchMembers(root).pipe(Effect.forever, Effect.forkScoped);
    return { ok: true as const, port: listener.port };
  });

  const start = (root: PenTrustRoot) =>
    penSessions.withIssueLock(
      Effect.gen(function* () {
        if (config.devUrl !== undefined)
          return yield* off("A dev server never registers with Pen.");
        const verdict = yield* gate(root);
        if (!verdict.ok) return yield* off(verdict.reason);
        const scope = yield* Scope.make();
        const current = yield* Ref.updateAndGet(generation, (value) => value + 1);
        const key = NodeCrypto.randomBytes(32);
        const started = yield* open(root, key, current).pipe(
          Effect.catchTags({
            PenListenError: (error) => Effect.succeed({ ok: false as const, reason: error.reason }),
            PenRegistrationError: (error) =>
              Effect.succeed({ ok: false as const, reason: error.reason }),
          }),
          Scope.provide(scope),
        );
        if (!started.ok) {
          yield* Scope.close(scope, Exit.void);
          return yield* off(started.reason);
        }
        yield* Ref.set(live, scope);
        yield* penSessions.setGeneration(current);
        yield* Ref.set(status, { state: "listening", generation: current, port: started.port });
      }),
    );

  // No Pen-bound session survives a restart, before any listener accepts.
  yield* penSessions.revokeAll.pipe(Effect.orDie);
  const initial = (yield* settings.getSettings.pipe(Effect.orDie)).pen;
  yield* Ref.set(desired, initial);
  if (initial !== null) yield* start(initial);
  yield* Effect.addFinalizer(() => fence("GOAT is stopping."));

  // A pen value changed outside replaceTrustRoot (a hand edit) is fenced when observed.
  yield* settings.streamChanges.pipe(
    Stream.map((next) => next.pen),
    Stream.runForEach((next) =>
      Effect.gen(function* () {
        if (sameRoot(yield* Ref.get(desired), next)) return;
        yield* Ref.set(desired, next);
        yield* fence("The Pen trust root changed.");
        if (next !== null) yield* start(next);
      }),
    ),
    Effect.forkScoped,
  );

  return PenRuntime.of({
    replaceTrustRoot: Effect.fn("PenRuntime.replaceTrustRoot")(function* (session, root) {
      if (!canResolveHumanStep(sessionResolver(session), "person_only"))
        return yield* new PenTrustRootError({
          reason: "Only a person confirms the Pen trust root.",
        });
      if (root !== null) {
        const verdict = yield* gate(root);
        if (!verdict.ok) return yield* new PenTrustRootError({ reason: verdict.reason });
      }
      yield* penSessions.withIssueLock(
        Effect.gen(function* () {
          yield* teardown("The Pen trust root changed.");
          yield* Ref.set(desired, root);
          yield* settings.updateSettings({ pen: root });
        }).pipe(Effect.mapError((cause) => new PenTrustRootError({ reason: cause.message }))),
      );
      if (root !== null) yield* start(root);
    }),
    status: Ref.get(status),
  });
});

export const layer = Layer.effect(PenRuntime, make());
