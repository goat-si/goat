import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";

const { values } = vi.hoisted(() => ({ values: new Map<string, string>() }));

// No SQLite in tests: the store runs on its secure-storage fallback, which sanitizes the same way.
vi.mock("./mobile-database-migration", () => ({
  openMigratedMobileDatabase: () => Promise.reject(new Error("no sqlite in tests")),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    values.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    values.delete(key);
  },
}));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

const storeLayer = Layer.mergeAll(MobileDatabase.layer, MobileSecureStorage.layer);
const loadFresh = MobilePreferences.make().pipe(
  Effect.flatMap((store) => store.load),
  Effect.provide(storeLayer),
);

const seedStoredPreferences = (preferences: Record<string, unknown>) =>
  Effect.gen(function* () {
    const storage = yield* MobileSecureStorage.MobileSecureStorage;
    yield* storage.setItem(
      "goat.preferences.fallback",
      JSON.stringify({ payload: JSON.stringify(preferences), updatedAt: 1 }),
    );
  }).pipe(Effect.provide(MobileSecureStorage.layer));

beforeEach(() => {
  values.clear();
});

describe("mobile language preference", () => {
  it.effect("keeps the chosen language across an app restart", () =>
    Effect.gen(function* () {
      yield* MobilePreferences.make().pipe(
        Effect.flatMap((store) => store.savePatch({ language: "ko" })),
        Effect.provide(storeLayer),
      );

      expect((yield* loadFresh).language).toBe("ko");
    }),
  );

  it.effect("drops a stored language that is not a string", () =>
    Effect.gen(function* () {
      yield* seedStoredPreferences({ language: 42, followUpBehavior: "queue" });

      const loaded = yield* loadFresh;
      expect(loaded.followUpBehavior).toBe("queue");
      expect("language" in loaded).toBe(false);
    }),
  );

  it.effect("loads preferences saved by a build without the setting as unset", () =>
    Effect.gen(function* () {
      yield* seedStoredPreferences({ followUpBehavior: "steer" });

      const loaded = yield* loadFresh;
      expect(loaded.followUpBehavior).toBe("steer");
      expect(loaded.language).toBeUndefined();
    }),
  );
});
// A database that opens; preferences use only its preferences row.
const openedDatabase = (row: { current: MobileDatabase.StoredPreferencesJson | null }) => {
  const unused = Effect.die(new Error("not used by preferences"));
  return Layer.mergeAll(
    Layer.succeed(
      MobileDatabase.MobileDatabase,
      MobileDatabase.MobileDatabase.of({
        loadNoteOutbox: unused,
        saveNoteOutbox: () => unused,
        removeNoteOutbox: () => unused,
        loadCache: () => unused,
        listCache: () => unused,
        saveCache: () => unused,
        removeCache: () => unused,
        clearCacheKind: () => unused,
        clearEnvironmentCache: () => unused,
        clearAllCaches: unused,
        inspectCaches: unused,
        loadPreferencesJson: Effect.sync(() =>
          row.current === null ? Option.none() : Option.some(row.current),
        ),
        savePreferencesJson: (payload, updatedAt) =>
          Effect.sync(() => {
            row.current = { payload, updatedAt };
          }),
      }),
    ),
    MobileSecureStorage.layer,
  );
};
const fallbackItem = MobileSecureStorage.MobileSecureStorage.pipe(
  Effect.flatMap((storage) => storage.getItem("goat.preferences.fallback")),
  Effect.provide(MobileSecureStorage.layer),
);

describe("preferences when the database opens on Android (#3549)", () => {
  it.effect(
    "guard: preferences kept in the fallback load unchanged and move into the database (#3549)",
    () =>
      Effect.gen(function* () {
        yield* seedStoredPreferences({ language: "ko", followUpBehavior: "steer" });
        const withoutDatabase = yield* loadFresh;
        const row = { current: null as MobileDatabase.StoredPreferencesJson | null };

        const withDatabase = yield* MobilePreferences.make().pipe(
          Effect.flatMap((store) => store.load),
          Effect.provide(openedDatabase(row)),
        );

        expect(withDatabase).toEqual(withoutDatabase);
        expect(row.current?.updatedAt).toBe(1);
        expect(JSON.parse(row.current?.payload ?? "null")).toEqual({
          language: "ko",
          followUpBehavior: "steer",
        });
        expect(yield* fallbackItem).toBeNull();
      }),
  );
});
