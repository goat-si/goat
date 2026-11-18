import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { MAIN_LISTENER, penConnection } from "./connectionContext.testkit.ts";
import { makeCheckProbe, makeReadBarrier, makeServerAndCli } from "./DurableRevocations.testkit.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { reauthorizeSession } from "./McpClientAuthority.ts";
import { PEN_PROXY_SUBJECT } from "./sessionBinding.ts";
import * as SessionStore from "./SessionStore.ts";

const grantState = (
  store: SessionStore.SessionStore["Service"],
  sessionId: SessionStore.IssuedSession["sessionId"],
) =>
  store
    .readActiveScopes(sessionId)
    .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "live" as const }));

it.effect.each(["revoked", "deleted"] as const)(
  "a session another process %s loses its live grant and invalidation wait at the next durable check",
  (ending) =>
    Effect.gen(function* () {
      const barrier = yield* makeReadBarrier;
      const probe = yield* makeCheckProbe;
      const { running, fromCli } = yield* makeServerAndCli((repository) =>
        barrier.wrap(probe.wrap(repository)),
      );
      yield* Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        // Keeps a session live so the next check reads and proves this one ended.
        const kept = yield* store.issue({ scopes: ["memory:read"] });
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
        expect(yield* grantState(store, issued.sessionId)).toBe("live");

        yield* probe.pass(
          Effect.gen(function* () {
            expect(yield* grantState(store, issued.sessionId)).toBe("UnknownSessionTokenError");
            expect(yield* grantState(store, kept.sessionId)).toBe("live");
          }),
        );
        // The waiter subscribed before the removal was published; only that event ends it.
        yield* Fiber.join(waiting);
        expect(
          yield* reauthorizeSession(
            store,
            issued.sessionId,
          )(["memory:read"]).pipe(
            Effect.match({ onFailure: (error) => error.message, onSuccess: () => "authorized" }),
          ),
        ).toBe("The MCP session is no longer active.");
      }).pipe(Effect.provide(running), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const penPeer = {
  meshId: "mesh-1",
  nodeId: "node-a",
  signPub: "sign",
  noisePub: "noise",
  name: "a",
};
// Revoke others keeps unrevoked sessions of these shapes, never ones another process revoked.
const cliRevokedShapes = {
  plain: { issue: {}, connection: MAIN_LISTENER },
  "desktop app": { issue: { subject: "desktop-bootstrap" }, connection: MAIN_LISTENER },
  "Pen-bound": {
    issue: {
      subject: PEN_PROXY_SUBJECT,
      principalKind: "proxied_person",
      penBinding: { meshId: "mesh-1", nodeId: "node-a", signPub: "sign", noisePub: "noise" },
    },
    connection: penConnection(penPeer).context,
  },
} as const;

it.effect.each([
  ["revoke", "plain"],
  ["revokeAllExcept", "plain"],
  ["revokeAllExcept", "desktop app"],
  ["revokeAllExcept", "Pen-bound"],
] as const)(
  "Settings %s ends a %s session the command line already revoked, without waiting for a check",
  ([operation, shape]) =>
    Effect.gen(function* () {
      const barrier = yield* makeReadBarrier;
      const { running, fromCli } = yield* makeServerAndCli(barrier.wrap);
      yield* Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        const { issue, connection } = cliRevokedShapes[shape];
        const issued = yield* fromCli((cli) =>
          cli.issue({ ...issue, method: "bearer-access-token", scopes: ["memory:read"] }),
        );
        yield* store.verify(issued.token, connection);
        const current = yield* store.issue({ subject: "settings-page" });
        yield* barrier.arm;
        const waiting = yield* store
          .awaitInvalidation(issued.sessionId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* barrier.read;
        yield* fromCli((cli) => cli.revoke(issued.sessionId));

        if (operation === "revoke") expect(yield* store.revoke(issued.sessionId)).toBe(true);
        else yield* store.revokeAllExcept(current.sessionId);
        expect(yield* grantState(store, issued.sessionId)).toBe("UnknownSessionTokenError");
        yield* Fiber.join(waiting);
        expect(yield* store.readActiveScopes(current.sessionId)).toEqual(AuthStandardClientScopes);
      }).pipe(Effect.provide(running), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

type Repository = Parameters<Parameters<typeof makeServerAndCli>[0] & {}>[0];
type ReadMode = (
  repository: Repository,
  input: Parameters<Repository["listUnrevoked"]>[0],
) => ReturnType<Repository["listUnrevoked"]>;

/** A store whose press runs `afterCommit` between its transaction and its read of live ids. */
const makeLateAdmission = Effect.fn("makeLateAdmission")(function* (read: ReadMode) {
  const afterCommit = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const { running, fromCli } = yield* makeServerAndCli((repository) => ({
    ...repository,
    revokeAllExcept: (input) =>
      repository
        .revokeAllExcept(input)
        .pipe(Effect.tap(() => Effect.flatten(Ref.get(afterCommit)))),
    listUnrevoked: (input) => read(repository, input),
  }));
  // Another process adds a desktop session after the press commits; this one admits it (no lock).
  const admitLateDesktop = (store: SessionStore.SessionStore["Service"]) =>
    Effect.gen(function* () {
      const late = yield* Deferred.make<SessionStore.IssuedSession>();
      yield* Ref.set(
        afterCommit,
        Effect.gen(function* () {
          const issued = yield* fromCli((cli) =>
            cli.issue({ subject: "desktop-bootstrap", method: "bearer-access-token" }),
          );
          yield* store.verify(issued.token, MAIN_LISTENER);
          yield* Deferred.succeed(late, issued);
        }).pipe(Effect.orDie, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
      );
      return late;
    });
  return { running, admitLateDesktop };
});

const readModes = {
  reads: (repository, input) => repository.listUnrevoked(input),
  "fails reading": () =>
    Effect.fail(new PersistenceSqlError({ operation: "listUnrevoked", detail: "injected" })),
  "dies reading": () => Effect.die(new Error("injected defect")),
} satisfies Record<string, ReadMode>;

it.effect.each(Object.keys(readModes) as ReadonlyArray<keyof typeof readModes>)(
  "Revoke others ends what it revoked and keeps a desktop session added after it commits when the store %s that session's row",
  (mode) =>
    Effect.gen(function* () {
      const { running, admitLateDesktop } = yield* makeLateAdmission(readModes[mode]);
      yield* Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        const current = yield* store.issue({ subject: "settings-page" });
        const phone = yield* store.issue({ subject: "one-time-token" });
        const late = yield* admitLateDesktop(store);

        const pressed = yield* Effect.exit(store.revokeAllExcept(current.sessionId));

        expect(Exit.isSuccess(pressed)).toBe(true);
        expect(yield* grantState(store, phone.sessionId)).toBe("UnknownSessionTokenError");
        expect(yield* grantState(store, (yield* Deferred.await(late)).sessionId)).toBe("live");
      }).pipe(Effect.provide(running), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "Revoke others ends the sessions it revoked before it reads the rows of sessions added after it",
  () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { running, admitLateDesktop } = yield* makeLateAdmission((repository, input) =>
        Deferred.succeed(reading, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(repository.listUnrevoked(input)),
        ),
      );
      yield* Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        const current = yield* store.issue({ subject: "settings-page" });
        const phone = yield* store.issue({ subject: "one-time-token" });
        const phoneEnded = yield* store
          .awaitInvalidation(phone.sessionId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const late = yield* admitLateDesktop(store);

        const press = yield* store
          .revokeAllExcept(current.sessionId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(reading);

        // The read is still held: what the press revoked has already ended. The release always
        // runs, so a failed assertion cannot leave the uninterruptible press waiting.
        yield* Effect.gen(function* () {
          expect(yield* grantState(store, phone.sessionId)).toBe("UnknownSessionTokenError");
          yield* Fiber.join(phoneEnded);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(press);
        expect(yield* grantState(store, (yield* Deferred.await(late)).sessionId)).toBe("live");
      }).pipe(Effect.provide(running), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["fail", "die"] as const)(
  "a check whose read ends with %s ends no session, and the next check still applies a revoke",
  (failure) =>
    Effect.gen(function* () {
      const barrier = yield* makeReadBarrier;
      const probe = yield* makeCheckProbe;
      const { running, fromCli } = yield* makeServerAndCli((repository) =>
        barrier.wrap(probe.wrap(repository)),
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

        yield* Ref.set(probe.mode, failure);
        yield* probe.next;
        // An unreadable database is never taken to mean every session ended.
        expect(yield* grantState(store, kept.sessionId)).toBe("live");
        expect(yield* grantState(store, ended.sessionId)).toBe("live");

        yield* Ref.set(probe.mode, "read");
        yield* probe.pass(
          Effect.gen(function* () {
            expect(yield* grantState(store, ended.sessionId)).toBe("UnknownSessionTokenError");
            expect(yield* grantState(store, kept.sessionId)).toBe("live");
          }),
        );
        yield* Fiber.join(waiting);
      }).pipe(Effect.provide(running), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "one check ends 1,200 sessions another process revoked, more than one statement holds",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeCheckProbe;
      const { running } = yield* makeServerAndCli(probe.wrap);
      yield* Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        const kept = yield* store.issue({ subject: "kept", scopes: ["memory:read"] });
        const bulk = yield* Effect.forEach(Array.from({ length: 1_200 }), () =>
          store.issue({ subject: "bulk", scopes: ["memory:read"] }),
        );
        const ids = new Set<string>(bulk.map((session) => session.sessionId));
        const removed = yield* store.streamChanges.pipe(
          Stream.filter((change) => change.type === "clientRemoved" && ids.has(change.sessionId)),
          Stream.take(ids.size),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        // One statement from another process, as a script or an older CLI might write.
        yield* sql`UPDATE auth_sessions SET revoked_at = '2026-01-01T00:00:00.000Z' WHERE subject = 'bulk'`;

        yield* probe.pass(
          Effect.gen(function* () {
            const states = yield* Effect.forEach(bulk, (session) =>
              grantState(store, session.sessionId),
            );
            expect(states.filter((state) => state !== "UnknownSessionTokenError")).toEqual([]);
            expect(yield* grantState(store, kept.sessionId)).toBe("live");
          }),
        );
        const events = Array.from(yield* Fiber.join(removed));
        const removedIds = events.map((change) =>
          change.type === "clientRemoved" ? change.sessionId : "",
        );
        expect(new Set(removedIds).size).toBe(ids.size);
      }).pipe(Effect.provide(running), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
