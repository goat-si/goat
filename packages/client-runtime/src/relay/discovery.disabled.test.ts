import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { vi } from "vite-plus/test";

import * as Discovery from "./discovery.ts";
import * as ManagedRelay from "./managedRelay.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Connectivity from "../connection/connectivity.ts";
import * as Wakeups from "../connection/wakeups.ts";
import type { NetworkStatus } from "../connection/model.ts";

describe("RelayEnvironmentDiscovery with Connect disabled", () => {
  it.effect(
    "stays empty on refresh and credential/network changes without subscribing or reading tokens",
    () =>
      Effect.gen(function* () {
        const work = vi.fn();
        const unexpected = () =>
          Effect.sync(work).pipe(Effect.andThen(Effect.die("Unexpected relay work")));
        const subscribe = vi.fn();
        const network = yield* SubscriptionRef.make<NetworkStatus>("offline");
        const credentials =
          yield* SubscriptionRef.make<Wakeups.ConnectionWakeup>("credentials-changed");
        const observed = <A>(ref: SubscriptionRef.SubscriptionRef<A>) =>
          Stream.unwrap(Effect.sync(subscribe).pipe(Effect.as(SubscriptionRef.changes(ref))));
        const discovery = yield* Discovery.make().pipe(
          Effect.provideService(ManagedRelay.ManagedRelayClient, {
            relayUrl: "https://relay.example.test",
            listEnvironments: unexpected,
            listDevices: unexpected,
            createEnvironmentLinkChallenge: unexpected,
            linkEnvironment: unexpected,
            unlinkEnvironment: unexpected,
            getEnvironmentStatus: unexpected,
            connectEnvironment: unexpected,
            registerDevice: unexpected,
            unregisterDevice: unexpected,
            registerLiveActivity: unexpected,
            getAgentActivitySnapshot: unexpected,
            requestKeyReadmission: () => Effect.void,
            resetTokenCache: unexpected(),
          }),
          Effect.provideService(ClientCapabilities.CloudSession, {
            identity: Effect.sync(work).pipe(
              Effect.as(Option.some({ accountId: "saved-account" })),
            ),
            clerkToken: Effect.sync(work).pipe(Effect.as("saved-token")),
          }),
          Effect.provideService(Connectivity.Connectivity, {
            status: SubscriptionRef.get(network),
            changes: observed(network),
          }),
          Effect.provideService(Wakeups.ConnectionWakeups, { changes: observed(credentials) }),
        );
        yield* discovery.refresh;
        yield* SubscriptionRef.set(network, "online");
        yield* SubscriptionRef.set(credentials, "application-active");
        yield* SubscriptionRef.set(credentials, "credentials-changed");
        yield* discovery.refresh;
        expect(yield* SubscriptionRef.get(discovery.state)).toEqual(
          Discovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
        );
        expect(work).not.toHaveBeenCalled();
        expect(subscribe).not.toHaveBeenCalled();
      }).pipe(Effect.scoped),
  );
});
