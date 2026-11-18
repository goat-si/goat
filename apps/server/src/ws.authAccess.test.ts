import { assert, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthSessionId,
  WS_METHODS,
  WsRpcGroup,
  type AuthAccessStreamEvent,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Headers } from "effect/http";
import { RpcMessage, RpcServer } from "effect/rpc";
import { ACCESS_CHANGE_BUFFER } from "./auth/AccessRpc.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "./ws.ts";
import {
  layerConfigEnvironment,
  layerConfigSources,
  layerUnusedConfigRpcServices,
} from "./wsRpcServices.testkit.ts";

const subscribeAccess = Effect.fn("test.subscribeAccess")(function* (stores: {
  readonly auth: Partial<EnvironmentAuth.EnvironmentAuth["Service"]>;
  readonly pairingChanges: Stream.Stream<PairingGrantStore.BootstrapCredentialChange>;
  readonly sessionChanges: Stream.Stream<SessionStore.SessionCredentialChange>;
}) {
  const responses = yield* Queue.unbounded<AuthAccessStreamEvent>();
  const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
    ...WS_RPC_SERVER_OPTIONS,
    onFromServer: (response) =>
      response._tag === "Chunk"
        ? Effect.forEach(
            response.values,
            (event) => Queue.offer(responses, event as AuthAccessStreamEvent),
            { discard: true },
          )
        : Effect.void,
  }).pipe(
    Effect.provide(
      layerWsRpc(
        {
          sessionId: AuthSessionId.make("current"),
          subject: "current",
          principalKind: "person",
          method: "browser-session-cookie",
          scopes: [AuthAccessReadScope],
        },
        {
          hasHost: Effect.succeed(false),
          attach: () => Stream.die("unused connection catalog"),
          respond: () => Effect.die("unused connection catalog"),
          invoke: () => Effect.die("unused connection catalog"),
        },
        { surface: "web" },
        {},
        yield* PreviewAutomationBroker.PreviewAutomationBroker,
        yield* ServerBrowser.ServerBrowser,
        () => Effect.void,
      ).pipe(
        Layer.merge(RpcAuthorization.layer([AuthAccessReadScope])),
        Layer.provide(
          Layer.mergeAll(
            layerUnusedConfigRpcServices,
            Layer.mock(ExternalLauncher.ExternalLauncher)({}),
            Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            Layer.mock(UsageLimitSources.UsageLimitSources)({}),
            Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
            Layer.mock(DirectEndpoints.DirectEndpoints)({}),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/unused",
            }),
            Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
            layerConfigEnvironment,
            Layer.mock(EnvironmentAuth.EnvironmentAuth)(stores.auth),
            Layer.mock(PairingGrantStore.PairingGrantStore)({
              streamChanges: stores.pairingChanges,
            }),
            Layer.mock(SessionStore.SessionStore)({
              cookieName: "auth-access-test",
              legacyCookieName: undefined,
              streamChanges: stores.sessionChanges,
            }),
          ),
        ),
      ),
    ),
  );
  const requestId = RpcMessage.RequestId("auth-access");
  yield* server.write(0, {
    _tag: "Request",
    id: requestId,
    tag: WS_METHODS.subscribeAuthAccess,
    payload: {},
    headers: Headers.empty,
  });
  return {
    next: Queue.take(responses),
    ack: server.write(0, { _tag: "Ack", requestId }),
    close: server.write(0, { _tag: "Interrupt", requestId, interruptors: [] }),
  };
});

const withRpcSources = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
    Effect.scoped,
  );

it.effect("access changes made while the snapshot loads reach the client after it", () =>
  withRpcSources(
    Effect.gen(function* () {
      const pairingChanges = yield* PubSub.unbounded<PairingGrantStore.BootstrapCredentialChange>();
      const sessionChanges = yield* PubSub.unbounded<SessionStore.SessionCredentialChange>();
      const subscribed = yield* Queue.unbounded<void>();
      const subscribe = <A>(changes: PubSub.PubSub<A>) =>
        Stream.unwrap(
          PubSub.subscribe(changes).pipe(
            Effect.tap(() => Queue.offer(subscribed, undefined)),
            Effect.map(Stream.fromSubscription),
          ),
        );
      const revokedElsewhere = AuthSessionId.make("revoked-elsewhere");
      const access = yield* subscribeAccess({
        auth: {
          listPairingLinks: () => Effect.succeed([]),
          // Another client revokes a session after the snapshot read it.
          listClientSessions: () =>
            PubSub.publish(sessionChanges, {
              type: "clientRemoved",
              sessionId: revokedElsewhere,
            }).pipe(Effect.as([])),
        },
        pairingChanges: subscribe(pairingChanges),
        sessionChanges: subscribe(sessionChanges),
      });
      const snapshot = yield* access.next;
      assert.equal(snapshot.type, "snapshot");
      yield* access.ack;
      yield* Queue.take(subscribed);
      yield* Queue.take(subscribed);

      // A later change arrives either way, so a dropped revocation fails as a mismatch.
      yield* PubSub.publish(pairingChanges, { type: "pairingLinkRemoved", id: "later" });
      assert.deepEqual(yield* access.next, {
        version: 1,
        revision: 2,
        type: "clientRemoved",
        payload: { sessionId: revokedElsewhere },
      });
      yield* access.close;
    }),
  ),
);

it.effect("a burst of access changes past the buffer arrives as one fresh snapshot", () =>
  withRpcSources(
    Effect.gen(function* () {
      const pairingChanges = yield* PubSub.unbounded<PairingGrantStore.BootstrapCredentialChange>();
      const burstOffered = yield* Deferred.make<void>();
      const burst = Array.from({ length: ACCESS_CHANGE_BUFFER + 8 }, (_, index) => ({
        type: "clientRemoved" as const,
        sessionId: AuthSessionId.make(`burst-${index}`),
      }));
      let snapshotReads = 0;
      const access = yield* subscribeAccess({
        auth: {
          listPairingLinks: () => Effect.succeed([]),
          listClientSessions: () =>
            Effect.sync(() => {
              snapshotReads += 1;
              return [];
            }),
        },
        pairingChanges: Stream.fromPubSub(pairingChanges),
        // The burst lands while the client has not acknowledged the first snapshot.
        sessionChanges: Stream.concat(
          Stream.fromIterable(burst),
          Stream.fromEffect(Deferred.succeed(burstOffered, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          ),
        ),
      });
      assert.equal((yield* access.next).type, "snapshot");
      yield* Deferred.await(burstOffered);
      yield* access.ack;

      assert.deepEqual(yield* access.next, {
        version: 1,
        revision: 2,
        type: "snapshot",
        payload: { pairingLinks: [], clientSessions: [] },
      });
      assert.equal(snapshotReads, 2);
      yield* access.ack;
      yield* PubSub.publish(pairingChanges, { type: "pairingLinkRemoved", id: "after" });
      assert.deepEqual(yield* access.next, {
        version: 1,
        revision: 3,
        type: "pairingLinkRemoved",
        payload: { id: "after" },
      });
      yield* access.close;
    }),
  ),
);
