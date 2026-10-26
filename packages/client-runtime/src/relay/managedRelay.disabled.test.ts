import { EnvironmentId } from "@goat/contracts";
import { RelayEnvironmentConnectScope } from "@goat/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as ManagedRelay from "./managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";

describe("ManagedRelayClient with Connect disabled", () => {
  it.effect("refuses every operation without HTTP, signer work or persisted token access", () =>
    Effect.gen(function* () {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const thumbprint = vi.fn(() => "thumbprint");
      const createProof = vi.fn(() => Effect.succeed("proof"));
      const load = vi.fn((): ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> => [
        {
          accountId: "account-1",
          clientId: "goat-mobile",
          relayUrl: "https://relay.example.test",
          thumbprint: "thumbprint",
          scopes: [RelayEnvironmentConnectScope],
          accessToken: "persisted-token",
          expiresAtMillis: Number.MAX_SAFE_INTEGER,
        },
      ]);
      const save = vi.fn(() => Effect.void);
      const clear = vi.fn();
      const relay = yield* ManagedRelay.make({
        relayUrl: "https://relay.example.test",
        clientId: "goat-mobile",
        accessTokenStore: { load: Effect.sync(load), save, clear: Effect.sync(clear) },
      }).pipe(
        Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, {
          thumbprint: Effect.sync(thumbprint),
          createProof,
        }),
        Effect.provide(RpcHttp.layerRemoteHttpClient(fetch)),
      );
      const account = { clerkToken: "persisted-clerk-token" };
      const environment = {
        ...account,
        environmentId: EnvironmentId.make("environment-1"),
        scopes: [RelayEnvironmentConnectScope],
      };
      const capabilities = {
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled: true,
      };
      const failures = yield* Effect.all([
        relay.listEnvironments(account).pipe(Effect.flip),
        relay.listDevices(account).pipe(Effect.flip),
        relay
          .createEnvironmentLinkChallenge({ ...account, payload: capabilities })
          .pipe(Effect.flip),
        relay
          .linkEnvironment({ ...account, payload: { ...capabilities, proof: "link-proof" } })
          .pipe(Effect.flip),
        relay.unlinkEnvironment(environment).pipe(Effect.flip),
        relay.getEnvironmentStatus(environment).pipe(Effect.flip),
        relay.connectEnvironment(environment).pipe(Effect.flip),
        relay
          .registerDevice({
            ...account,
            payload: {
              deviceId: "device-1",
              label: "Phone",
              platform: "ios",
              iosMajorVersion: 18,
              pushToken: "saved-push-token",
              preferences: {
                ...capabilities,
                notifyOnApproval: true,
                notifyOnInput: true,
                notifyOnCompletion: true,
                notifyOnFailure: true,
              },
            },
          })
          .pipe(Effect.flip),
        relay.unregisterDevice({ ...account, deviceId: "device-1" }).pipe(Effect.flip),
        relay
          .registerLiveActivity({
            ...account,
            payload: { deviceId: "device-1", activityPushToken: "saved-activity-token" },
          })
          .pipe(Effect.flip),
        relay.getAgentActivitySnapshot(account).pipe(Effect.flip),
      ]);
      expect(failures).toHaveLength(11);
      for (const failure of failures) expect(failure._tag).toBe("ManagedRelayUrlInvalidError");
      yield* relay.resetTokenCache;
      for (const spy of [fetch, thumbprint, createProof, load, save, clear]) {
        expect(spy).not.toHaveBeenCalled();
      }
    }),
  );
});
