import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { MAIN_LISTENER } from "./connectionContext.testkit.ts";
import { makeCheckProbe, makeServerAndCli } from "./DurableRevocations.testkit.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const layerStore = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("session-end")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-session-end-" })),
  Layer.provide(NodeServices.layer),
);

const mcpClient = {
  subject: "mcp-client",
  method: "bearer-access-token",
  scopes: ["orchestration:read"],
} as const;
const relay = {
  subject: "managed-relay-bootstrap",
  method: "dpop-access-token",
  proofKeyThumbprint: "relay-proof-key",
  ttl: Duration.hours(1),
  client: { label: "Relay desktop", deviceType: "desktop" },
} as const;

/** A call running on the session's authority, parked until something stops it. */
const runningCall = Effect.fn("runningCall")(function* (
  store: SessionStore.SessionStore["Service"],
  sessionId: SessionStore.IssuedSession["sessionId"],
) {
  const started = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  const outcome = yield* (yield* store.sessionEnd(sessionId))
    .run(
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      ),
    )
    .pipe(Effect.forkScoped({ startImmediately: true }));
  yield* Deferred.await(started);
  return { outcome, stopped: Deferred.isDone(stopped), hasStopped: Deferred.await(stopped) };
});

it.effect.each(["revoke", "revokeAllExcept", "replace", "cloud fence"] as const)(
  "%s interrupts a call running on the session and no other",
  (path) =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const owner = yield* store.issue({ subject: "settings-page" });
      const ending = yield* store.issue(
        path === "cloud fence"
          ? { subject: "cloud-connect" }
          : path === "replace"
            ? relay
            : mcpClient,
      );
      const other = yield* store.issue(mcpClient);
      const call = yield* runningCall(store, ending.sessionId);
      const bystander = yield* runningCall(store, other.sessionId);
      if (path === "revoke") yield* store.revoke(ending.sessionId);
      else if (path === "revokeAllExcept") yield* store.revokeAllExcept(owner.sessionId);
      else if (path === "replace")
        yield* store.issue({ ...relay, replaceSessionId: ending.sessionId });
      else yield* store.setCloudWithdrawalPending(true);
      yield* call.hasStopped;
      expect(yield* Fiber.join(call.outcome)).toEqual(Option.none());
      if (path === "revokeAllExcept") yield* bystander.hasStopped;
      else expect(yield* bystander.stopped).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect.each(["revoked by the command line", "deleted, as Pen cleanup leaves it"] as const)(
  "a session %s interrupts its running call at the next durable check",
  (ending) =>
    Effect.gen(function* () {
      const probe = yield* makeCheckProbe;
      const { running, fromCli } = yield* makeServerAndCli(probe.wrap);
      yield* Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        // Keeps a session live so the check reads and proves this one ended.
        yield* store.issue({ scopes: ["memory:read"] });
        const issued = yield* fromCli((cli) =>
          cli.issue({ method: "bearer-access-token", scopes: ["memory:read"] }),
        );
        yield* store.verify(issued.token, MAIN_LISTENER);
        const call = yield* runningCall(store, issued.sessionId);
        if (ending === "revoked by the command line")
          yield* fromCli((cli) => cli.revoke(issued.sessionId));
        else yield* sql`DELETE FROM auth_sessions WHERE session_id = ${issued.sessionId}`;
        expect(yield* call.stopped).toBe(false);
        expect(yield* probe.next).toBe("read");
        yield* call.hasStopped;
        expect(yield* Fiber.join(call.outcome)).toEqual(Option.none());
      }).pipe(Effect.provide(running), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a call that starts after its session was removed is cut at once without running", () =>
  Effect.gen(function* () {
    const store = yield* SessionStore.SessionStore;
    const issued = yield* store.issue(mcpClient);
    const end = yield* store.sessionEnd(issued.sessionId);
    expect(yield* end.ended).toBe(false);
    yield* store.revoke(issued.sessionId);
    expect(yield* end.ended).toBe(true);
    let ran = false;
    const outcome = yield* end.run(
      Effect.sync(() => {
        ran = true;
      }),
    );
    expect(outcome).toEqual(Option.none());
    expect(ran).toBe(false);
  }).pipe(Effect.provide(layerStore)),
);

it.effect("expiry cuts a running call at the deadline, and a later call at once", () =>
  Effect.gen(function* () {
    const store = yield* SessionStore.SessionStore;
    const issued = yield* store.issue({ ...mcpClient, ttl: Duration.hours(1) });
    const call = yield* runningCall(store, issued.sessionId);
    yield* TestClock.adjust(Duration.minutes(59));
    expect(yield* call.stopped).toBe(false);
    yield* TestClock.adjust(Duration.minutes(1));
    expect(yield* Fiber.join(call.outcome)).toEqual(Option.none());
    expect(yield* call.stopped).toBe(true);
    let ran = false;
    const later = yield* (yield* store.sessionEnd(issued.sessionId)).run(
      Effect.sync(() => {
        ran = true;
      }),
    );
    expect(later).toEqual(Option.none());
    expect(ran).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);

it.effect("a call returns its own result or failure, and its caller can still stop it", () =>
  Effect.gen(function* () {
    const store = yield* SessionStore.SessionStore;
    const issued = yield* store.issue(mcpClient);
    const end = yield* store.sessionEnd(issued.sessionId);
    expect(yield* end.run(Effect.succeed("done"))).toEqual(Option.some("done"));
    expect(yield* end.run(Effect.fail("refused")).pipe(Effect.flip)).toBe("refused");
    const call = yield* runningCall(store, issued.sessionId);
    // The caller stops waiting, as a client abort does; the work stops with it.
    yield* Fiber.interrupt(call.outcome);
    expect(yield* call.stopped).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layerStore)),
);
