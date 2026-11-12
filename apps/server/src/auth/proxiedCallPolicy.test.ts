import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, WS_METHODS, WsRpcGroup } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { RpcTest } from "effect/rpc";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layerFor } from "./proxiedCallPolicy.ts";
import type { RPC_REQUIRED_SCOPES } from "./RpcAuthorization.ts";
import { PEN_PROXY_SUBJECT } from "./sessionBinding.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const tested = [
  WS_METHODS.serverProbe,
  WS_METHODS.projectsEnsureScratch,
  WS_METHODS.computerUseStopAll,
] as const;
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
      !(tested as ReadonlyArray<string>).includes(tag),
  ),
);

const layerStore = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("proxied-call-test")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-proxied-call-" })),
);

const binding = { meshId: "mesh-1", nodeId: "node-a", signPub: "sign-a", noisePub: "noise-a" };

const makeClient = (
  session: Parameters<typeof layerFor>[0],
  sessions: SessionStore.SessionStore["Service"],
  handled: Array<string>,
  gate?: { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> },
) =>
  RpcTest.makeClient(group).pipe(
    Effect.provide(
      Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.serverProbe, () =>
          Effect.sync(() => handled.push("probe")).pipe(
            Effect.andThen(
              gate === undefined
                ? Effect.void
                : Deferred.succeed(gate.entered, undefined).pipe(
                    Effect.andThen(Deferred.await(gate.release)),
                  ),
            ),
            Effect.as({}),
          ),
        ),
        group.toLayerHandler(WS_METHODS.projectsEnsureScratch, () =>
          Effect.sync(() => handled.push("scratch")).pipe(Effect.andThen(Effect.die("unused"))),
        ),
        group.toLayerHandler(WS_METHODS.computerUseStopAll, () =>
          Effect.sync(() => handled.push("stopAll")).pipe(Effect.andThen(Effect.die("unused"))),
        ),
        layerFor(session, sessions),
      ),
    ),
  );

const refusedBeforeHandler = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && JSON.stringify(exit.cause).includes("EnvironmentAuthorizationError");

it.layer(NodeServices.layer)("Pen member proxy RPC frames (mesh link design §5)", (it) => {
  it.effect(
    "a member proxy's frames pass the hub proxy's policy; a person with the same scopes keeps the plain check",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const proxy = yield* sessions.issue({
          subject: PEN_PROXY_SUBJECT,
          method: "bearer-access-token",
          scopes: ["orchestration:read", "orchestration:operate"],
          principalKind: "proxied_person",
          penBinding: binding,
        });
        const handled: Array<string> = [];
        const client = yield* makeClient(
          { sessionId: proxy.sessionId, scopes: proxy.scopes, principalKind: "proxied_person" },
          sessions,
          handled,
        );
        expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
        yield* Effect.exit(client[WS_METHODS.projectsEnsureScratch]({}));
        const stopAll = yield* Effect.exit(client[WS_METHODS.computerUseStopAll]({}));
        expect(refusedBeforeHandler(stopAll)).toBe(true);
        expect(handled).toEqual(["probe", "scratch"]);

        const person = yield* sessions.issue({
          subject: "browser",
          scopes: ["orchestration:read", "orchestration:operate"],
        });
        const personHandled: Array<string> = [];
        const personClient = yield* makeClient(
          { sessionId: person.sessionId, scopes: person.scopes, principalKind: "person" },
          sessions,
          personHandled,
        );
        yield* Effect.exit(personClient[WS_METHODS.computerUseStopAll]({}));
        expect(personHandled).toEqual(["stopAll"]);
      }).pipe(Effect.scoped, Effect.provide(layerStore)),
  );

  it.effect("revocation applies on the next frame; a frame already admitted may finish", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const proxy = yield* sessions.issue({
        subject: PEN_PROXY_SUBJECT,
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
        principalKind: "proxied_person",
        penBinding: binding,
      });
      const handled: Array<string> = [];
      const gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      const client = yield* makeClient(
        { sessionId: proxy.sessionId, scopes: proxy.scopes, principalKind: "proxied_person" },
        sessions,
        handled,
        gate,
      );
      const inFlight = yield* client[WS_METHODS.serverProbe]({}).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      // The admitted frame reaches its handler before the revocation.
      yield* Deferred.await(gate.entered);
      yield* sessions.revoke(proxy.sessionId);
      yield* Deferred.succeed(gate.release, undefined);
      expect(yield* Fiber.join(inFlight)).toEqual({});
      const next = yield* Effect.exit(client[WS_METHODS.serverProbe]({}));
      expect(refusedBeforeHandler(next)).toBe(true);
      expect(handled).toEqual(["probe"]);
    }).pipe(Effect.scoped, Effect.provide(layerStore)),
  );
});
