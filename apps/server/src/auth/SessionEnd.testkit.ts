import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
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
  Layer.provide(NodeServices.layer),
);

/**
 * Starts `effect` as /mcp runs a tool call on a fresh MCP client session: admitted for this
 * request's scope and guarded by its session end. `revoke` ends that session as Settings does.
 */
export const startGuardedCall = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.SessionStore;
    const issued = yield* store.issue({
      subject: "mcp-client",
      method: "bearer-access-token",
      scopes: ["orchestration:read", "orchestration:operate"],
    });
    const { sessionEnd } = yield* store.admitMcpCall(issued.token, MAIN_LISTENER);
    const fiber = yield* sessionEnd.run(effect).pipe(Effect.forkChild({ startImmediately: true }));
    return { fiber, revoke: store.revoke(issued.sessionId) };
  });
