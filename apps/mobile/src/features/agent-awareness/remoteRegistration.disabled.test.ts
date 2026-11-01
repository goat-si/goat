import { describe, expect, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { ManagedRelay } from "@goat/client-runtime/relay";
import { EnvironmentId } from "@goat/contracts";
import { RelayMobileClientId } from "@goat/contracts/relay";
import * as Notifications from "expo-notifications";
import { AppState } from "react-native";
import { runtime } from "../../lib/runtime";
import {
  clearAgentAwarenessRegistrationRecord,
  loadOrCreateAgentAwarenessDeviceId,
} from "../../persistence/imperative";
import {
  __resetAgentAwarenessRemoteRegistrationForTest,
  getAgentAwarenessRegistrationStatus,
  refreshActiveLiveActivityRemoteRegistration,
  refreshAgentAwarenessRegistration,
  registerAgentAwarenessConnection,
  registerLiveActivityPushToken,
  setAgentAwarenessRelayTokenProvider,
  unregisterAgentAwarenessDeviceForCurrentUser,
  updateAgentAwarenessRegistrationPreferences,
} from "./remoteRegistration";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        clerk: { publishableKey: "pk_test_populated", jwtTemplate: "relay" },
        relay: { url: "https://relay.example.test" },
      },
    },
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "18.0" },
  AppState: { addEventListener: vi.fn() },
}));
vi.mock("expo-notifications", () => ({
  addPushTokenListener: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
}));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromiseExit: vi.fn() } }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => new Map() } }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: Symbol("configs") }));
vi.mock("./androidNotifications", () => ({
  configureAndroidAgentNotifications: vi.fn(),
  clearAndroidAgentNotifications: vi.fn(),
}));
vi.mock("./agentLiveActivity", () => ({
  getAgentLiveActivities: vi.fn(() => []),
  startAgentLiveActivity: vi.fn(),
}));
vi.mock("../../persistence/imperative", () => ({
  loadAgentAwarenessDeviceId: vi.fn(async () => "saved-device"),
  loadOrCreateAgentAwarenessDeviceId: vi.fn(async () => "saved-device"),
  loadPreferences: vi.fn(),
  loadAgentAwarenessRegistrationRecord: vi.fn(),
  saveAgentAwarenessRegistrationRecord: vi.fn(),
  clearAgentAwarenessRegistrationRecord: vi.fn(),
}));

const relayLayer = ManagedRelay.layer({
  relayUrl: "https://relay.example.test",
  clientId: RelayMobileClientId,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      FetchHttpClient.layer,
      Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, {
        thumbprint: Effect.die("Unexpected signer read"),
        createProof: () => Effect.die("Unexpected signing work"),
      }),
    ),
  ),
);

beforeEach(() => {
  __resetAgentAwarenessRemoteRegistrationForTest();
  vi.clearAllMocks();
  vi.stubGlobal("__DEV__", false);
});

describe("default-off mobile agent awareness", () => {
  it.effect(
    "skips registration, refresh and removal without token reads, HTTP or spawned work",
    () => {
      const token = vi.fn(async () => "previous-account-token");
      const fetch = vi.fn<typeof globalThis.fetch>();
      const activity = {
        getId: vi.fn(() => "old-activity"),
        getPushToken: vi.fn(async () => "old-push-token"),
        addPushTokenListener: vi.fn(),
      };
      return Effect.gen(function* () {
        setAgentAwarenessRelayTokenProvider(token, "previous-account");
        registerAgentAwarenessConnection({
          environmentId: EnvironmentId.make("saved"),
          environmentLabel: "Saved",
          pairingUrl: "https://desktop.tail.test/pair",
          displayUrl: "https://desktop.tail.test",
          httpBaseUrl: "https://desktop.tail.test",
          wsBaseUrl: "wss://desktop.tail.test/ws",
          bearerToken: "paired-token",
        });
        expect(yield* registerLiveActivityPushToken({ activity: activity as never })).toBe(false);
        yield* refreshAgentAwarenessRegistration();
        yield* updateAgentAwarenessRegistrationPreferences({ liveActivitiesEnabled: true });
        yield* refreshActiveLiveActivityRemoteRegistration();
        yield* unregisterAgentAwarenessDeviceForCurrentUser(token);
        expect(getAgentAwarenessRegistrationStatus()).toBe("unknown");
        expect(token).not.toHaveBeenCalled();
        expect(activity.getPushToken).not.toHaveBeenCalled();
        expect(activity.addPushTokenListener).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(runtime.runPromiseExit).not.toHaveBeenCalled();
        expect(AppState.addEventListener).not.toHaveBeenCalled();
        expect(Notifications.addPushTokenListener).not.toHaveBeenCalled();
        expect(Notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
        expect(loadOrCreateAgentAwarenessDeviceId).not.toHaveBeenCalled();
        expect(clearAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
      }).pipe(Effect.provide(relayLayer), Effect.provideService(FetchHttpClient.Fetch, fetch));
    },
  );
});
