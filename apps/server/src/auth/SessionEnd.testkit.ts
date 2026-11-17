import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { MAIN_LISTENER } from "./connectionContext.testkit.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

/** An in-memory SessionStore, the one the server builds, for tests that revoke a session. */
export const layerSessionStore = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("session-end")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-session-end-" })),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

/** A fresh MCP client session admitted as /mcp admits one request; `revoke` ends it as Settings does. */
const admit = Effect.gen(function* () {
  const store = yield* SessionStore.SessionStore;
  const issued = yield* store.issue({
    subject: "mcp-client",
    method: "bearer-access-token",
    scopes: ["orchestration:read", "orchestration:operate"],
  });
  const { sessionEnd } = yield* store.admitMcpCall(issued.token, MAIN_LISTENER);
  return { sessionEnd, revoke: store.revoke(issued.sessionId) };
});

/** `base` carrying a revocable session's end, for a tool call made over /mcp. */
export const guardedScope = (base: McpInvocationScope) =>
  Effect.map(admit, ({ sessionEnd, revoke }) => ({ scope: { ...base, sessionEnd }, revoke }));

/**
 * Starts `effect` as its caller would, ended by `how`: "stop" interrupts the caller as a cancel or
 * a dropped request does; "revoke" runs it guarded by a fresh MCP session and revokes that session.
 * `interrupted` reads, without waiting, whether the caller's interruption has run; `cut` awaits the
 * caller and says whether it ended without its result.
 */
export const startCallEndedBy = <A, E, R>(effect: Effect.Effect<A, E, R>, how: "stop" | "revoke") =>
  Effect.gen(function* () {
    const interrupted = yield* Deferred.make<void>();
    const caller = effect.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)));
    const ended = { interrupted: Deferred.isDone(interrupted) };
    if (how === "stop") {
      const fiber = yield* caller.pipe(Effect.forkChild({ startImmediately: true }));
      return {
        ...ended,
        stop: Fiber.interrupt(fiber),
        cut: Effect.map(Fiber.await(fiber), Exit.hasInterrupts),
      };
    }
    const { sessionEnd, revoke } = yield* admit;
    const fiber = yield* sessionEnd.run(caller).pipe(Effect.forkChild({ startImmediately: true }));
    return { ...ended, stop: revoke, cut: Effect.map(Fiber.join(fiber), Option.isNone) };
  });
