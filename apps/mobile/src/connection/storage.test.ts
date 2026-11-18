import { describe, expect, it } from "@effect/vitest";
import { BearerConnectionCredential, CredentialStore } from "@goat/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import { CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY, make } from "./catalog-store";
import * as ConnectionStorage from "./storage";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";

function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  const storage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      }),
  });
  return { deleted, storage, values };
}

describe("mobile connection catalog storage", () => {
  it.effect("keeps a credential saved after the one a replacement expected", () =>
    Effect.gen(function* () {
      const memory = makeStorage({});
      const credentials = yield* CredentialStore.ConnectionCredentialStore.pipe(
        Effect.provide(
          ConnectionStorage.layer.pipe(
            Layer.provide(Layer.succeed(MobileSecureStorage.MobileSecureStorage, memory.storage)),
          ),
        ),
      );
      yield* credentials.put("a", new BearerConnectionCredential({ token: "fresh" }));
      yield* credentials.put("a", new BearerConnectionCredential({ token: "adopted" }), "old");
      expect(Option.getOrNull(yield* credentials.get("a"))?.token).toBe("fresh");
    }),
  );

  it.effect.each(["the Pen field", "the shared list"] as const)(
    "a Pen record the client cannot read in %s keeps the catalog and its pairings",
    (place) =>
      Effect.gen(function* () {
        const memory = makeStorage({});
        const store = () =>
          CredentialStore.ConnectionCredentialStore.pipe(
            Effect.provide(
              ConnectionStorage.layer.pipe(
                Layer.provide(
                  Layer.succeed(MobileSecureStorage.MobileSecureStorage, memory.storage),
                ),
              ),
            ),
          );
        yield* (yield* store()).put("desk", new BearerConnectionCredential({ token: "kept" }));
        // A newer or broken writer left a Pen record this client cannot read.
        const saved = JSON.parse(memory.values.get(CONNECTION_CATALOG_KEY) ?? "{}");
        const broken = {
          _tag: "PenConnectionTarget",
          environmentId: "e",
          label: "Pen",
          connectionId: 7,
        };
        memory.values.set(
          CONNECTION_CATALOG_KEY,
          JSON.stringify(
            place === "the Pen field"
              ? { ...saved, penTargets: [null] }
              : { ...saved, targets: [...saved.targets, broken] },
          ),
        );
        expect(Option.getOrNull(yield* (yield* store()).get("desk"))?.token).toBe("kept");
        expect(memory.deleted).toEqual([]);
      }),
  );

  it.effect("refuses a future catalog without deleting or rewriting it", () =>
    Effect.gen(function* () {
      const raw = JSON.stringify({ schemaVersion: 99 });
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: raw });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );
      expect(yield* Effect.flip(catalog.read)).toMatchObject({ _tag: "ConnectionTransientError" });
      expect(yield* Effect.flip(catalog.update((document) => document))).toMatchObject({
        _tag: "ConnectionTransientError",
      });
      expect(memory.deleted).toEqual([]);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(raw);
    }),
  );

  it.effect("recovers from a corrupt current catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY]);
    }),
  );

  it.effect("replaces a corrupt legacy catalog while retaining it for rollback", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({ connections: [{ invalid: true }] }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([]);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
    }),
  );

  it.effect("falls back to valid legacy data when the current catalog is corrupt", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({
          connections: [
            {
              environmentId: "legacy-environment",
              environmentLabel: "Legacy",
              pairingUrl: "https://legacy.example.test/pair",
              displayUrl: "https://legacy.example.test",
              httpBaseUrl: "https://legacy.example.test",
              wsBaseUrl: "wss://legacy.example.test",
              bearerToken: "legacy-token",
              authenticationMethod: "bearer",
            },
          ],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY]);

      yield* catalog.update((document) => document);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(true);
    }),
  );
});
