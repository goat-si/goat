import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthStandardClientScopes, EnvironmentId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { MAIN_LISTENER } from "./connectionContext.testkit.ts";
import { reauthorizeSession } from "./McpClientAuthority.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

type Repository = AuthSessions.AuthSessionRepository["Service"];

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
const makeServerAndCli = Effect.fn("makeServerAndCli")(function* (
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

/** Opens once after the first armed getById: awaitInvalidation has read the still-active row. */
const makeReadBarrier = Effect.gen(function* () {
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

const repositoryFailure = new PersistenceSqlError({
  operation: "AuthSessionRepository.listUnrevoked:query",
  detail: "sqlite is unavailable",
});

it.effect.each(["revoked", "deleted"] as const)(
  "a session another process %s loses its live grant and invalidation wait at the next durable check",
  (ending) =>
    Effect.gen(function* () {
      const barrier = yield* makeReadBarrier;
      const { running, fromCli } = yield* makeServerAndCli(barrier.wrap);
      yield* Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        const issued = yield* fromCli((cli) =>
          cli.issue({ method: "bearer-access-token", scopes: ["memory:read"] }),
        );
        yield* store.verify(issued.token, MAIN_LISTENER);
        yield* barrier.arm;
        const waiting = yield* store
          .awaitInvalidation(issued.sessionId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        // The waiter has read the row as active, so only a later signal can end its wait.
        yield* barrier.read;
        if (ending === "revoked") yield* fromCli((cli) => cli.revoke(issued.sessionId));
        // A row that no longer exists, as Pen cleanup leaves of a revoked or expired Pen session.
        else yield* sql`DELETE FROM auth_sessions WHERE session_id = ${issued.sessionId}`;
        expect(yield* store.readActiveScopes(issued.sessionId)).toEqual(["memory:read"]);

        yield* TestClock.adjust(Duration.seconds(5));
        yield* Fiber.join(waiting);
        expect((yield* store.readActiveScopes(issued.sessionId).pipe(Effect.flip))._tag).toBe(
          "UnknownSessionTokenError",
        );
        expect(
          (yield* reauthorizeSession(store, issued.sessionId)(["memory:read"]).pipe(Effect.flip))
            .message,
        ).toBe("The MCP session is no longer active.");
      }).pipe(Effect.provide(running), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["revoke", "revokeAllExcept"] as const)(
  "Settings %s ends a session the command line already revoked, without waiting for a check",
  (operation) =>
    Effect.gen(function* () {
      const barrier = yield* makeReadBarrier;
      const { running, fromCli } = yield* makeServerAndCli(barrier.wrap);
      yield* Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        const issued = yield* fromCli((cli) =>
          cli.issue({ method: "bearer-access-token", scopes: ["memory:read"] }),
        );
        yield* store.verify(issued.token, MAIN_LISTENER);
        const current = yield* store.issue({ subject: "settings-page" });
        yield* barrier.arm;
        const waiting = yield* store
          .awaitInvalidation(issued.sessionId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* barrier.read;
        yield* fromCli((cli) => cli.revoke(issued.sessionId));

        if (operation === "revoke") expect(yield* store.revoke(issued.sessionId)).toBe(true);
        else yield* store.revokeAllExcept(current.sessionId);
        expect((yield* store.readActiveScopes(issued.sessionId).pipe(Effect.flip))._tag).toBe(
          "UnknownSessionTokenError",
        );
        yield* Fiber.join(waiting);
        expect(yield* store.readActiveScopes(current.sessionId)).toEqual(AuthStandardClientScopes);
      }).pipe(Effect.provide(running), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a failed durable check ends no session and the next one recovers", () =>
  Effect.gen(function* () {
    const barrier = yield* makeReadBarrier;
    const failing = yield* Ref.make(true);
    const checks = yield* Queue.unbounded<"failed" | "read">();
    const { running, fromCli } = yield* makeServerAndCli((repository) =>
      barrier.wrap({
        ...repository,
        listUnrevoked: (input) =>
          Effect.flatMap(Ref.get(failing), (fail) =>
            fail
              ? Queue.offer(checks, "failed").pipe(Effect.andThen(Effect.fail(repositoryFailure)))
              : repository.listUnrevoked(input).pipe(Effect.tap(() => Queue.offer(checks, "read"))),
          ),
      }),
    );
    yield* Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const kept = yield* store.issue({ scopes: ["memory:read"] });
      const ended = yield* fromCli((cli) =>
        cli.issue({ method: "bearer-access-token", scopes: ["memory:write"] }),
      );
      yield* store.verify(ended.token, MAIN_LISTENER);
      yield* barrier.arm;
      const waiting = yield* store
        .awaitInvalidation(ended.sessionId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* barrier.read;
      yield* fromCli((cli) => cli.revoke(ended.sessionId));

      yield* TestClock.adjust(Duration.seconds(5));
      expect(yield* Queue.take(checks)).toBe("failed");
      // An unreadable database is never taken to mean every session ended.
      expect(yield* store.readActiveScopes(kept.sessionId)).toEqual(["memory:read"]);
      expect(yield* store.readActiveScopes(ended.sessionId)).toEqual(["memory:write"]);

      yield* Ref.set(failing, false);
      yield* TestClock.adjust(Duration.seconds(5));
      expect(yield* Queue.take(checks)).toBe("read");
      yield* Fiber.join(waiting);
      expect((yield* store.readActiveScopes(ended.sessionId).pipe(Effect.flip))._tag).toBe(
        "UnknownSessionTokenError",
      );
      expect(yield* store.readActiveScopes(kept.sessionId)).toEqual(["memory:read"]);
    }).pipe(Effect.provide(running), Effect.scoped);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a check that dies with a defect does not stop later checks", () =>
  Effect.gen(function* () {
    const barrier = yield* makeReadBarrier;
    const dying = yield* Ref.make(true);
    const checks = yield* Queue.unbounded<"died" | "read">();
    const { running, fromCli } = yield* makeServerAndCli((repository) =>
      barrier.wrap({
        ...repository,
        listUnrevoked: (input) =>
          Effect.flatMap(Ref.get(dying), (die) =>
            die
              ? Queue.offer(checks, "died").pipe(
                  Effect.andThen(Effect.die(new Error("unexpected repository defect"))),
                )
              : repository.listUnrevoked(input).pipe(Effect.tap(() => Queue.offer(checks, "read"))),
          ),
      }),
    );
    yield* Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const ended = yield* fromCli((cli) =>
        cli.issue({ method: "bearer-access-token", scopes: ["memory:write"] }),
      );
      yield* store.verify(ended.token, MAIN_LISTENER);
      yield* barrier.arm;
      const waiting = yield* store
        .awaitInvalidation(ended.sessionId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* barrier.read;

      yield* TestClock.adjust(Duration.seconds(5));
      expect(yield* Queue.take(checks)).toBe("died");
      expect(yield* store.readActiveScopes(ended.sessionId)).toEqual(["memory:write"]);

      // Revoked after the defect: only a check that still runs can apply it.
      yield* fromCli((cli) => cli.revoke(ended.sessionId));
      yield* Ref.set(dying, false);
      yield* TestClock.adjust(Duration.seconds(5));
      expect(yield* Queue.take(checks)).toBe("read");
      yield* Fiber.join(waiting);
      expect((yield* store.readActiveScopes(ended.sessionId).pipe(Effect.flip))._tag).toBe(
        "UnknownSessionTokenError",
      );
    }).pipe(Effect.provide(running), Effect.scoped);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
