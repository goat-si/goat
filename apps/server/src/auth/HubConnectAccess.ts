import type * as Scope from "effect/Scope";
import { AuthHubProxyScope, type AuthEnvironmentScope } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

interface Credential {
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly connectAccessGeneration?: number;
}
interface AccessState {
  readonly generation: number;
  readonly allowed: boolean;
  readonly fenced: boolean;
}

export const isPrivilegedConnect = (credential: Credential) =>
  credential.subject === "cloud-connect" && credential.scopes.includes(AuthHubProxyScope);

export const admits = (credential: Credential, state: AccessState) =>
  !isPrivilegedConnect(credential) ||
  (state.allowed && !state.fenced && credential.connectAccessGeneration === state.generation);

export class HubConnectAccessError extends Schema.TaggedError<HubConnectAccessError>()(
  "HubConnectAccessError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not persist GOAT Connect hub authorization.";
  }
}

export class HubConnectAccess extends Context.Service<
  HubConnectAccess,
  {
    readonly current: Effect.Effect<AccessState>;
    readonly state: SubscriptionRef.SubscriptionRef<AccessState>;
    readonly awaitRecovery: Effect.Effect<void>;
    readonly withPolicy: <A, E, R>(
      use: (state: AccessState) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly commitPolicy: <A, E, R>(
      allowed: boolean,
      commit: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | HubConnectAccessError, R>;
    readonly subscribeDenial: (
      credential: Credential,
    ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
    readonly awaitDenial: (credential: Credential) => Effect.Effect<void>;
    readonly rotate: <A, E, R>(
      change: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | HubConnectAccessError, R>;
  }
>()("goat/auth/HubConnectAccess") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const grants = yield* PairingGrantStore.PairingGrantStore;
  const sessions = yield* SessionStore.SessionStore;
  const marker = `${config.stateDir}/connect-hub-access.fence`;
  const rows = yield* sql<{
    generation: number;
    allowed: number;
  }>`SELECT generation, allowed FROM hub_connect_access WHERE id = 1`;
  const initial = rows[0];
  if (!initial)
    return yield* new HubConnectAccessError({ cause: "Missing authorization generation" });
  const state = yield* SubscriptionRef.make<AccessState>({
    generation: initial.generation,
    allowed: false,
    fenced: yield* fs.exists(marker),
  });
  const permit = yield* Semaphore.make(1);
  const recovery = yield* Queue.unbounded<void>();
  let initialized = false;
  const cleanup = Effect.gen(function* () {
    for (const grant of yield* grants.listActive())
      if (isPrivilegedConnect(grant)) yield* grants.revoke(grant.id);
    for (const session of yield* sessions.listActive())
      if (isPrivilegedConnect(session)) yield* sessions.revoke(session.sessionId);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Connect hub credential cleanup failed", { reason: cause._tag }),
    ),
  );
  const bump = Effect.fn("HubConnectAccess.bump")(
    function* () {
      const updated = yield* sql.withTransaction(
        sql<{
          generation: number;
        }>`UPDATE hub_connect_access SET generation = generation + 1, allowed = 0 WHERE id = 1 RETURNING generation`,
      );
      const row = updated[0];
      if (!row)
        return yield* new HubConnectAccessError({ cause: "Missing authorization generation" });
      yield* fs.remove(marker, { force: true });
      yield* SubscriptionRef.set(state, {
        generation: row.generation,
        allowed: false,
        fenced: false,
      });
      initialized = true;
      yield* cleanup;
    },
    Effect.mapError((cause) => new HubConnectAccessError({ cause })),
  );
  const withdraw = Effect.fn("HubConnectAccess.withdraw")(function* () {
    const previous = yield* SubscriptionRef.get(state);
    yield* SubscriptionRef.set(state, { ...previous, allowed: false, fenced: true });
    // A failed marker must never skip the independent SQLite withdrawal.
    yield* fs.writeFileString(`${marker}.tmp`, "withdrawn\n").pipe(
      Effect.andThen(fs.rename(`${marker}.tmp`, marker)),
      Effect.catch((cause) =>
        Effect.logError("Could not persist Connect hub withdrawal fence", { cause }),
      ),
    );
    yield* bump().pipe(Effect.tapError(() => Queue.offer(recovery, undefined)));
  });
  yield* Queue.take(recovery).pipe(
    Effect.andThen(
      permit
        .withPermits(1)(
          SubscriptionRef.get(state).pipe(
            Effect.flatMap((value) =>
              value.fenced ? Effect.uninterruptible(bump()) : Effect.void,
            ),
          ),
        )
        .pipe(
          Effect.retry(
            Schedule.spaced("1 second").pipe(
              Schedule.modifyDelay(({ attempt }) =>
                Effect.succeed(Math.min(1000 * 2 ** Math.min(attempt - 1, 6), 60_000)),
              ),
            ),
          ),
        ),
    ),
    Effect.forever,
    Effect.withSpan("HubConnectAccess.recover"),
    Effect.forkScoped,
  );
  // The CLI's offline unlink can advance the generation or persist a fence from another process.
  const readDurable = Effect.gen(function* () {
    const durable = (yield* sql<{
      generation: number;
      allowed: number;
    }>`SELECT generation, allowed FROM hub_connect_access WHERE id = 1`)[0];
    const current = yield* SubscriptionRef.get(state);
    if (durable && durable.generation > current.generation)
      yield* SubscriptionRef.set(state, {
        ...current,
        generation: durable.generation,
        allowed: current.allowed && durable.allowed === 1,
      });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read Connect hub authorization", { reason: cause._tag }),
    ),
  );
  // Checked apart from SQLite: the fence is what remains when the other process's SQL failed.
  const readFence = Effect.gen(function* () {
    if ((yield* SubscriptionRef.get(state)).fenced || !(yield* fs.exists(marker))) return;
    yield* SubscriptionRef.update(state, (value) => ({ ...value, fenced: true }));
    yield* Queue.offer(recovery, undefined);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read Connect hub withdrawal fence", { reason: cause._tag }),
    ),
  );
  yield* permit
    .withPermits(1)(Effect.andThen(readDurable, readFence))
    .pipe(
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.withSpan("HubConnectAccess.observeDurable"),
      Effect.forkScoped,
    );
  if ((yield* SubscriptionRef.get(state)).fenced) {
    yield* permit
      .withPermits(1)(bump())
      .pipe(
        Effect.catch((cause) =>
          Effect.logError("Connect hub access remains fenced", { cause }).pipe(
            Effect.andThen(Queue.offer(recovery, undefined)),
          ),
        ),
      );
  }
  const service: HubConnectAccess["Service"] = {
    awaitRecovery: SubscriptionRef.changes(state).pipe(
      Stream.filter((value) => !value.fenced),
      Stream.runHead,
      Effect.asVoid,
      Effect.withSpan("HubConnectAccess.awaitRecovery"),
    ),
    current: SubscriptionRef.get(state),
    state,
    withPolicy: Effect.fn("HubConnectAccess.withPolicy")((use) =>
      permit.withPermits(1)(SubscriptionRef.get(state).pipe(Effect.flatMap(use))),
    ),
    commitPolicy: Effect.fn("HubConnectAccess.commitPolicy")((allowed, commit) =>
      permit.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(state);
            if (allowed && current.fenced)
              return yield* new HubConnectAccessError({ cause: "Withdrawal fence pending" });
            if (!allowed && (!initialized || current.allowed || current.fenced)) yield* withdraw();
            // An unchanged allow at startup preserves current-generation sessions.
            if (allowed && !current.allowed && initialized) yield* cleanup;
            const result = yield* commit;
            if (allowed && !current.allowed) {
              yield* sql`UPDATE hub_connect_access SET allowed = 1 WHERE id = 1`.pipe(
                Effect.mapError((cause) => new HubConnectAccessError({ cause })),
              );
              yield* SubscriptionRef.update(state, (value) => ({ ...value, allowed: true }));
            }
            initialized = true;
            return result;
          }),
        ),
      ),
    ),
    subscribeDenial: Effect.fn("HubConnectAccess.subscribeDenial")(function* (credential) {
      if (!isPrivilegedConnect(credential)) return Effect.never;
      const subscription = yield* PubSub.subscribe(state.pubsub);
      if (!admits(credential, yield* SubscriptionRef.get(state))) return Effect.void;
      return Stream.fromSubscription(subscription).pipe(
        Stream.filter((value) => !admits(credential, value)),
        Stream.runHead,
        Effect.asVoid,
      );
    }),
    // Link trust changes end every issued hub privilege but keep the standing consent.
    // The trust change and the generation advance commit together, so no process sees the
    // replacement generation while the previous link trust can still admit a grant.
    rotate: Effect.fn("HubConnectAccess.rotate")((change) =>
      permit.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const committed = yield* Effect.exit(
              sql
                .withTransaction(
                  Effect.gen(function* () {
                    const result = yield* change;
                    const row = (yield* sql<{
                      generation: number;
                    }>`UPDATE hub_connect_access SET generation = generation + 1 WHERE id = 1 RETURNING generation`)[0];
                    if (!row)
                      return yield* new HubConnectAccessError({
                        cause: "Missing authorization generation",
                      });
                    return { result, generation: row.generation };
                  }),
                )
                .pipe(
                  Effect.catchIf(
                    (error): error is SqlError.SqlError => Predicate.isTagged(error, "SqlError"),
                    (cause) => Effect.fail(new HubConnectAccessError({ cause })),
                  ),
                ),
            );
            if (Exit.isFailure(committed)) {
              yield* withdraw().pipe(Effect.ignore({ log: true }));
              return yield* Effect.failCause(committed.cause);
            }
            yield* SubscriptionRef.update(state, (value) => ({
              ...value,
              generation: committed.value.generation,
            }));
            yield* cleanup;
            return committed.value.result;
          }),
        ),
      ),
    ),
    awaitDenial: Effect.fn("HubConnectAccess.awaitDenial")((credential) =>
      Effect.scoped(
        service
          .subscribeDenial(credential)
          .pipe(
            Effect.flatMap((stop) =>
              stop.pipe(Effect.withSpan("HubConnectAccess.watchCredential")),
            ),
          ),
      ),
    ),
  };
  return HubConnectAccess.of(service);
});

export const layer = Layer.unwrap(
  Effect.sync(() =>
    Layer.effect(HubConnectAccess, make).pipe(
      Layer.provideMerge(PairingGrantStore.layer),
      Layer.provideMerge(SessionStore.layer),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
    ),
  ),
);
