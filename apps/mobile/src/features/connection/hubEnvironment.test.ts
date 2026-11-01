import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  CredentialStore,
  ProfileStore,
} from "@goat/client-runtime/connection";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  Persistence,
} from "@goat/client-runtime/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import * as MobileSecureStorage from "../../persistence/mobile-secure-storage";
import * as ConnectionStorage from "../../connection/storage";
import { CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY } from "../../connection/catalog-store";
import {
  loadHubEnvironmentId,
  rememberHubEnvironment,
  selectHubEnvironmentId,
} from "./hubEnvironment";

const a = EnvironmentId.make("hub-a");
const b = EnvironmentId.make("advanced-b");
const c = EnvironmentId.make("hub-c");

function registration(environmentId: EnvironmentId) {
  const connectionId = `connection-${environmentId}`;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({ environmentId, connectionId, label: environmentId }),
    profile: new BearerConnectionProfile({
      environmentId,
      connectionId,
      label: environmentId,
      httpBaseUrl: `https://${environmentId}.example.test`,
      wsBaseUrl: `wss://${environmentId}.example.test`,
    }),
    credential: new BearerConnectionCredential({ token: `token-${environmentId}` }),
  });
}

function makeStorage(document = EMPTY_CONNECTION_CATALOG_DOCUMENT) {
  const schema = Schema.fromJsonString(ConnectionCatalogDocument);
  const values = new Map([[CONNECTION_CATALOG_KEY, Schema.encodeSync(schema)(document)]]);
  let failWrites = false;
  const storage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.gen(function* () {
        if (failWrites) {
          return yield* new MobileSecureStorage.MobileSecureStorageError({
            operation: "write",
            key,
            cause: new Error("storage unavailable"),
          });
        }
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  });
  return {
    values,
    failWrites: () => {
      failWrites = true;
    },
    build: () =>
      Layer.build(ConnectionStorage.layer).pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, storage),
      ),
    read: () => Schema.decodeSync(schema)(values.get(CONNECTION_CATALOG_KEY)!),
  };
}

describe("catalog-backed hub identity", () => {
  it.effect("falls back to the first local environment for a catalog without hub", () =>
    Effect.gen(function* () {
      const context = yield* makeStorage().build();
      const stored = yield* loadHubEnvironmentId().pipe(Effect.provide(context));
      expect(stored).toBeNull();
      expect(selectHubEnvironmentId([{ environmentId: a }, { environmentId: b }], stored)).toBe(a);
      expect(selectHubEnvironmentId([], stored)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps C after A→C with Advanced server B retained, including a fresh catalog instance",
    () =>
      Effect.gen(function* () {
        const memory = makeStorage();
        const context = yield* memory.build();
        yield* Effect.gen(function* () {
          const registrations = yield* Persistence.ConnectionRegistrationStore;
          const targets = yield* Persistence.ConnectionTargetStore;
          // Prime the hub reader before registration to catch independent stale caches.
          expect(yield* loadHubEnvironmentId()).toBeNull();
          for (const id of [a, b]) {
            const entry = registration(id);
            yield* registrations.register(entry, [entry.target]);
          }
          yield* rememberHubEnvironment({ intent: "hub", pairedEnvironmentId: a });
          yield* rememberHubEnvironment({ intent: "add-server", pairedEnvironmentId: b });
          expect(yield* loadHubEnvironmentId()).toBe(a);
          const next = registration(c);
          yield* registrations.register(next, [next.target]);
          yield* rememberHubEnvironment({ intent: "change-hub", pairedEnvironmentId: c });
          yield* registrations.remove(a);
          const environments = yield* targets.list;
          expect(environments.map((entry) => entry.environmentId)).toEqual([b, c]);
          expect(selectHubEnvironmentId(environments, yield* loadHubEnvironmentId())).toBe(c);
        }).pipe(Effect.provide(context));
        const restarted = yield* memory.build();
        const environments = yield* Context.get(restarted, Persistence.ConnectionTargetStore).list;
        const hub = yield* loadHubEnvironmentId().pipe(Effect.provide(restarted));
        expect(selectHubEnvironmentId(environments, hub)).toBe(c);
        expect(memory.read().schemaVersion).toBe(1);
        expect(memory.read().hub).toEqual({ environmentId: c });
        expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("falls back for a dangling id and clears hub on removal or explicit reset", () =>
    Effect.gen(function* () {
      const memory = makeStorage();
      const context = yield* memory.build();
      yield* Effect.gen(function* () {
        const hub = yield* ConnectionStorage.HubEnvironmentStore;
        const registrations = yield* Persistence.ConnectionRegistrationStore;
        yield* hub.setHub(a);
        expect(
          selectHubEnvironmentId([{ environmentId: b }, { environmentId: c }], yield* hub.readHub),
        ).toBe(b);
        yield* registrations.remove(a);
        expect(yield* hub.readHub).toBeNull();
        yield* hub.setHub(c);
        yield* hub.setHub(null);
        expect(yield* hub.readHub).toBeNull();
      }).pipe(Effect.provide(context));
      expect(memory.read()).not.toHaveProperty("hub");
    }).pipe(Effect.scoped),
  );

  it.effect("retains hub through route, enabled, profile and credential writes", () =>
    Effect.gen(function* () {
      const context = yield* makeStorage().build();
      yield* Effect.gen(function* () {
        const registrations = yield* Persistence.ConnectionRegistrationStore;
        const profiles = yield* ProfileStore.ConnectionProfileStore;
        const credentials = yield* CredentialStore.ConnectionCredentialStore;
        const entry = registration(c);
        yield* registrations.register(entry, [entry.target]);
        yield* rememberHubEnvironment({ intent: "hub", pairedEnvironmentId: c });
        for (const mutation of [
          registrations.setRoutes(c, [entry.target]),
          registrations.setEnabled(c, false),
          registrations.setEnabled(c, true),
          profiles.put(entry.profile),
          profiles.remove(entry.target.connectionId),
          credentials.put(entry.target.connectionId, entry.credential),
          credentials.remove(entry.target.connectionId),
        ]) {
          yield* mutation;
          expect(yield* loadHubEnvironmentId()).toBe(c);
        }
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the previous hub and saved connections when a hub write fails", () =>
    Effect.gen(function* () {
      const memory = makeStorage();
      const context = yield* memory.build();
      yield* Effect.gen(function* () {
        const registrations = yield* Persistence.ConnectionRegistrationStore;
        const entry = registration(a);
        yield* registrations.register(entry, [entry.target]);
        yield* rememberHubEnvironment({ intent: "hub", pairedEnvironmentId: a });
        const saved = memory.values.get(CONNECTION_CATALOG_KEY);
        memory.failWrites();
        const error = yield* rememberHubEnvironment({
          intent: "change-hub",
          pairedEnvironmentId: c,
        }).pipe(Effect.flip);
        expect(error._tag).toBe("ConnectionTransientError");
        expect(yield* loadHubEnvironmentId()).toBe(a);
        expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(saved);
        expect(memory.read().targets.map((target) => target.environmentId)).toEqual([a]);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.effect.each(["add-server", "add-route"] as const)(
    "does not change the catalog hub for %s",
    (intent) =>
      Effect.gen(function* () {
        const memory = makeStorage();
        const context = yield* memory.build();
        yield* Effect.gen(function* () {
          yield* rememberHubEnvironment({ intent: "hub", pairedEnvironmentId: a });
          const before = memory.values.get(CONNECTION_CATALOG_KEY);
          yield* rememberHubEnvironment({ intent, pairedEnvironmentId: b });
          expect(yield* loadHubEnvironmentId()).toBe(a);
          expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(before);
        }).pipe(Effect.provide(context));
      }).pipe(Effect.scoped),
  );
});
