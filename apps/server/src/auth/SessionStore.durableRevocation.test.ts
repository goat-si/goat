import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { MAIN_LISTENER, penConnection } from "./connectionContext.testkit.ts";
import { makeCheckProbe, makeReadBarrier, makeServerAndCli } from "./DurableRevocations.testkit.ts";
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a desktop session another process adds after Revoke others commits, and this one admits before settling, stays live",
  () =>
    Effect.gen(function* () {
      const afterCommit = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      const { running, fromCli } = yield* makeServerAndCli((repository) => ({
        ...repository,
        revokeAllExcept: (input) =>
          repository
            .revokeAllExcept(input)
            .pipe(Effect.tap(() => Effect.flatten(Ref.get(afterCommit)))),
      }));
      yield* Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        const current = yield* store.issue({ subject: "settings-page" });
        const late = yield* Deferred.make<SessionStore.IssuedSession>();
        // Runs between the press's transaction and its read of live ids; verify takes no lock.
        yield* Ref.set(
          afterCommit,
          Effect.gen(function* () {
            const issued = yield* fromCli((cli) =>
              cli.issue({ subject: "desktop-bootstrap", method: "bearer-access-token" }),
            );
            yield* store.verify(issued.token, MAIN_LISTENER);
            yield* Deferred.succeed(late, issued);
          }).pipe(Effect.orDie),
        );

        yield* store.revokeAllExcept(current.sessionId);

        const issued = yield* Deferred.await(late);
        expect(yield* grantState(store, issued.sessionId)).toBe("live");
      }).pipe(Effect.provide(running), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
