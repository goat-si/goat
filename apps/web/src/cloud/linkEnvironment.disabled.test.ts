import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentRegistry,
  type ConnectionCatalogEntry,
  type NetworkStatus,
} from "@goat/client-runtime/connection";
import { ManagedRelay } from "@goat/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentId } from "@goat/contracts";
import { layerRemoteHttpClient } from "@goat/client-runtime/rpc";
import { afterEach, vi } from "vite-plus/test";
import { linkPrimaryEnvironmentToCloud } from "./linkEnvironment";
import { readRelayClientInstallDialogState } from "./relayClientInstallDialog";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("linking with GOAT Connect disabled", () => {
  it.effect.each(["managed", "publish_only"] as const)(
    "refuses %s before token access, relay calls, HTTP, or installation",
    (mode) =>
      Effect.gen(function* () {
        vi.stubEnv("VITE_GOAT_RELAY_URL", "https://relay.example.test");
        const fetch = vi.fn();
        const token = vi.fn(() => "saved-clerk-token");
        const run = vi.fn(() => Effect.die("Unexpected RPC"));
        const challenge = vi.fn(() => Effect.die("Unexpected relay request"));
        vi.stubGlobal("fetch", fetch);
        const entries = yield* SubscriptionRef.make<
          ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
        >(new Map());
        const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
        const error = yield* linkPrimaryEnvironmentToCloud({
          target: {
            environmentId: "saved",
            label: "Saved machine",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
          },
          get clerkToken() {
            return token();
          },
          mode,
        }).pipe(
          Effect.flip,
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({ entries, networkStatus, run }),
              Layer.mock(ManagedRelay.ManagedRelayClient)({
                relayUrl: "https://relay.example.test",
                createEnvironmentLinkChallenge: challenge,
              }),
              layerRemoteHttpClient(globalThis.fetch),
            ),
          ),
        );
        expect(error._tag).toBe("CloudEnvironmentLinkError");
        expect(error.message).toBe("GOAT_RELAY_URL is not configured.");
        expect(token).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(challenge).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(readRelayClientInstallDialogState()).toEqual({ status: "idle" });
      }),
  );
});
