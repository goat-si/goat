import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const secureStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStore.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((key: string) => {
    secureStore.delete(key);
    return Promise.resolve();
  }),
}));

import { LEGACY_RELAY_CLIENT_IDS } from "@goat/contracts/legacyT3Names";

import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";

it.effect("falls back to an empty cache when persisted data is invalid", () =>
  Effect.gen(function* () {
    secureStore.clear();
    secureStore.set("goat.cloud.relay-access-tokens", "not-json");

    expect(yield* managedRelayAccessTokenStore.load).toEqual([]);
  }),
);

it.effect("loads entries cached under the earlier client id", () =>
  Effect.gen(function* () {
    secureStore.clear();
    const entry = {
      accountId: "account-1",
      relayUrl: "https://relay.example.com",
      thumbprint: "thumb",
      scopes: ["environment:connect"],
      accessToken: "token",
      expiresAtMillis: 1,
    };
    secureStore.set(
      "goat.cloud.relay-access-tokens",
      JSON.stringify({
        version: 1,
        entries: [{ ...entry, clientId: LEGACY_RELAY_CLIENT_IDS.mobile }],
      }),
    );

    expect(yield* managedRelayAccessTokenStore.load).toEqual([
      { ...entry, clientId: "goat-mobile" },
    ]);
  }),
);
