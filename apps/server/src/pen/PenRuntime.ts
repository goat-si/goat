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
import * as Semaphore from "effect/Semaphore";
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
  options: {
    readonly probe?: PlatformProbe;
    /** Runs as a transition starts waiting for the one before it; tests order races with it. */
    readonly onTransitionWait?: Effect.Effect<void>;
  } = {},
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
  // Set while some Pen-bound session may have survived a fence; nothing starts until it clears.
  const unrevoked = yield* Ref.make(false);
  const UNREVOKED = "Pen member sessions could not all be withdrawn; Pen stays off until they are.";
  /** Withdraws every Pen-bound session, remembering a failure instead of hiding it. */
  const revokeEvery = penSessions.revokeAll.pipe(
    Effect.match({ onFailure: () => false, onSuccess: () => true }),
    Effect.tap((done) => Ref.set(unrevoked, !done)),
  );
  const gate = (root: PenTrustRoot) => checkPenPlatform(root, options.probe);

  /** Ends the live generation: listener, sockets, registration, watch, every Pen-bound session. */
  const teardown = Effect.fn("PenRuntime.teardown")(function* (reason: string) {
    yield* Ref.set(status, { state: "off", reason });
    yield* Ref.update(generation, (current) => current + 1);
    yield* penSessions.setGeneration(undefined);
    const current = yield* Ref.getAndSet(live, undefined);
    if (current !== undefined) yield* Scope.close(current, Exit.void);
    if (!(yield* revokeEvery)) yield* Ref.set(status, { state: "off", reason: UNREVOKED });
  });
  const fence = (reason: string): Effect.Effect<void> =>
    penSessions.withIssueLock(teardown(reason));
  /** A fence one generation asks for; it does nothing once that generation has ended. */
  const fenceLater = (expected: number, reason: string): Effect.Effect<void> =>
    penSessions
      .withIssueLock(
        Effect.gen(function* () {
          if ((yield* Ref.get(generation)) === expected) yield* teardown(reason);
        }),
      )
      .pipe(Effect.forkIn(outer), Effect.asVoid);

  const off = (reason: string) => Ref.set(status, { state: "off", reason });

  const watchMembers = Effect.fn("PenRuntime.watchMembers")(function* (
    root: PenTrustRoot,
    current: number,
  ) {
    const verdict = yield* gate(root);
    if (!verdict.ok) {
      // The fence closes this generation's scope, which ends this watch.
      yield* fenceLater(current, verdict.reason);
      return yield* Effect.never;
    }
    yield* watchSnapshots(root.stateDir, (snapshot) =>
      snapshot.mesh !== root.meshId || snapshot.self !== root.nodeId
        ? fenceLater(current, "Pen's mesh is no longer the one a person confirmed.")
        : // Under the issue lock, so a session issued for a member who just left is withdrawn too.
          penSessions
            .withIssueLock(penSessions.revokeExcept(snapshot.members))
            .pipe(
              Effect.catch(() =>
                fenceLater(current, "A departed member's Pen sessions could not be withdrawn."),
              ),
            ),
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
      onUnsafe: fenceLater(current, "The Pen paths are no longer safe."),
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
      Effect.andThen(fenceLater(current, "Pen no longer holds GOAT's registration.")),
      Effect.forkScoped,
    );
    yield* watchMembers(root, current).pipe(Effect.forever, Effect.forkScoped);
    return { ok: true as const, port: listener.port };
  });

  /** Starts a generation for root; true when it is listening. */
  const start = (root: PenTrustRoot): Effect.Effect<boolean> =>
    penSessions.withIssueLock(
      Effect.gen(function* () {
        if (config.devUrl !== undefined) {
          yield* off("A dev server never registers with Pen.");
          return false;
        }
        if ((yield* Ref.get(unrevoked)) && !(yield* revokeEvery)) {
          yield* off(UNREVOKED);
          return false;
        }
        // Only the root a person confirmed last may start, and never beside another generation.
        if (!sameRoot(yield* Ref.get(desired), root)) {
          yield* off("The Pen trust root changed before it started.");
          return false;
        }
        const previous = yield* Ref.getAndSet(live, undefined);
        if (previous !== undefined) yield* Scope.close(previous, Exit.void);
        const verdict = yield* gate(root);
        if (!verdict.ok) {
          yield* off(verdict.reason);
          return false;
        }
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
          yield* off(started.reason);
          return false;
        }
        yield* Ref.set(live, scope);
        yield* penSessions.setGeneration(current);
        yield* Ref.set(status, { state: "listening", generation: current, port: started.port });
        return true;
      }),
    );

  // Confirmation, an observed edit and startup each run alone, start to finish.
  const transitions = yield* Semaphore.make(1);
  const transition = <A, E>(effect: Effect.Effect<A, E>) =>
    (options.onTransitionWait ?? Effect.void).pipe(
      Effect.andThen(transitions.withPermits(1)(effect)),
    );

  // A pen value changed outside replaceTrustRoot (a hand edit) is fenced when observed and
  // stays off until a person confirms a root again (design §7). The stored value decides, so a
  // late notification of an earlier confirmation is not mistaken for an edit.
  const reconcile = transition(
    Effect.gen(function* () {
      const stored = yield* settings.getSettings.pipe(Effect.option);
      if (stored._tag === "None")
        return yield* fence("The Pen trust root could not be read; confirm it again.");
      const next = stored.value.pen;
      if (sameRoot(yield* Ref.get(desired), next)) return;
      yield* Ref.set(desired, next);
      yield* fence("The Pen trust root changed outside its confirmation; confirm it again.");
    }),
  );

  // Subscribe before the startup read, so an edit while startup registers is never missed.
  const changes = yield* settings.subscribeChanges;
  // No Pen-bound session survives a restart, before any listener accepts.
  yield* revokeEvery;
  const initial = (yield* settings.getSettings.pipe(Effect.orDie)).pen;
  yield* Ref.set(desired, initial);
  if (initial !== null) yield* transition(start(initial));
  yield* Effect.addFinalizer(() => fence("GOAT is stopping."));
  yield* reconcile;
  yield* changes.pipe(
    Stream.runForEach(() => reconcile),
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
      yield* transition(
        Effect.gen(function* () {
          yield* penSessions.withIssueLock(
            Effect.gen(function* () {
              yield* teardown("The Pen trust root changed.");
              yield* Ref.set(desired, root);
              yield* settings.updateSettings({ pen: root });
            }),
          );
          if (root === null && (yield* Ref.get(unrevoked)))
            return yield* new PenTrustRootError({ reason: UNREVOKED });
          if (root !== null && !(yield* start(root))) {
            const now = yield* Ref.get(status);
            return yield* new PenTrustRootError({
              reason: now.state === "off" ? now.reason : "Pen did not start.",
            });
          }
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "PenTrustRootError"
              ? cause
              : new PenTrustRootError({ reason: cause.message }),
          ),
        ),
      );
    }),
    status: Ref.get(status),
  });
});

export const layer = Layer.effect(PenRuntime, make());
