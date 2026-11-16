import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { EnvironmentId } from "@goat/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as HubConnectAccess from "./HubConnectAccess.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

export type Repository = AuthSessions.AuthSessionRepository["Service"];

/** A session store on an on-disk database, the way the server and the CLI each build one. */
const makeDiskStore = Effect.fn("makeDiskStore")(function* (
  baseDir: string,
  wrapRepository: (repository: Repository) => Repository = (repository) => repository,
) {
  const devUrl = new URL("http://127.0.0.1:5173");
  const paths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, { baseDirIsExplicit: true });
  yield* ServerConfig.ensureServerDirectories(paths);
  return Layer.effect(SessionStore.SessionStore, SessionStore.make).pipe(
    Layer.provideMerge(
      Layer.effect(
        AuthSessions.AuthSessionRepository,
        Effect.map(AuthSessions.make, wrapRepository),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerFromPath(paths.dbPath)),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(baseDir)),
      }),
    ),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.map(ServerConfig.ServerConfig, (config) => ({
          ...config,
          ...paths,
          baseDir,
          mode: "web" as const,
          devUrl,
        })),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-durable-config-" })),
      ),
    ),
  );
});

/** A running store and a second store on the same file, which is what the CLI is. */
export const makeServerAndCli = Effect.fn("makeServerAndCli")(function* (
  wrapRepository?: (repository: Repository) => Repository,
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-session-durable-" });
  const running = yield* makeDiskStore(baseDir, wrapRepository);
  const cli = yield* makeDiskStore(baseDir);
  const fromCli = <A, E>(
    use: (store: SessionStore.SessionStore["Service"]) => Effect.Effect<A, E>,
  ) =>
    SessionStore.SessionStore.pipe(
      Effect.flatMap(use),
      Effect.provide(cli, { local: true }),
      Effect.scoped,
    );
  return { running, fromCli };
});

/** Hub access that admits every session that is not a privileged Connect session. */
export const layerHubAccess = Layer.unwrap(
  SubscriptionRef.make({ generation: 0, allowed: false, fenced: false }).pipe(
    Effect.map((state) =>
      Layer.mock(HubConnectAccess.HubConnectAccess, {
        state,
        current: SubscriptionRef.get(state),
        awaitDenial: () => Effect.never,
      }),
    ),
  ),
);

/** Opens once after the first armed getById: awaitInvalidation has read the still-active row. */
export const makeReadBarrier = Effect.gen(function* () {
  const read = yield* Deferred.make<void>();
  let armed = false;
  const wrap = (repository: Repository): Repository => ({
    ...repository,
    getById: (input) =>
      repository.getById(input).pipe(
        Effect.tap(() =>
          Effect.suspend(() => {
            if (!armed) return Effect.void;
            armed = false;
            return Deferred.succeed(read, undefined);
          }),
        ),
      ),
  });
  return {
    wrap,
    arm: Effect.sync(() => {
      armed = true;
    }),
    read: Deferred.await(read),
  };
});

export type CheckOutcome = "read" | "fail" | "die";

/**
 * Wraps listUnrevoked so a test knows whether a durable check ran and when its read returned.
 * A check calls it before its first suspension, so after TestClock.adjust the count is settled.
 */
export const makeCheckProbe = Effect.gen(function* () {
  const mode = yield* Ref.make<CheckOutcome>("read");
  const started = yield* Ref.make(0);
  const finished = yield* Queue.unbounded<CheckOutcome>();
  const wrap = (repository: Repository): Repository => ({
    ...repository,
    listUnrevoked: (input) =>
      Ref.update(started, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(mode)),
        Effect.flatMap((outcome) => {
          if (outcome === "fail")
            return Queue.offer(finished, outcome).pipe(
              Effect.andThen(
                Effect.fail(
                  new PersistenceSqlError({
                    operation: "AuthSessionRepository.listUnrevoked:query",
                    detail: "sqlite is unavailable",
                  }),
                ),
              ),
            );
          if (outcome === "die")
            return Queue.offer(finished, outcome).pipe(
              Effect.andThen(Effect.die(new Error("unexpected repository defect"))),
            );
          return repository
            .listUnrevoked(input)
            .pipe(Effect.tap(() => Queue.offer(finished, outcome)));
        }),
      ),
  });
  return {
    wrap,
    mode,
    /** Advances one interval; the check's outcome once its read returned, or "none" if none ran. */
    next: Effect.gen(function* () {
      yield* TestClock.adjust(Duration.seconds(5));
      if ((yield* Ref.getAndSet(started, 0)) === 0) return "none" as const;
      return yield* Queue.take(finished);
    }),
  };
});

/** Joins a fiber the check ends; when no check read anything it reports false instead of waiting. */
export const joinAfterCheck = <A, E>(
  outcome: CheckOutcome | "none",
  fiber: Fiber.Fiber<A, E>,
): Effect.Effect<boolean, E> =>
  outcome === "read" ? Fiber.join(fiber).pipe(Effect.as(true)) : Effect.succeed(false);
