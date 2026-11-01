import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));
import { MobileDatabase } from "../../persistence/mobile-database";
import { MobileSecureStorage } from "../../persistence/mobile-secure-storage";
import * as MobilePreferences from "../../persistence/mobile-preferences";

function fixture(initial: unknown = {}) {
  let stored = { payload: JSON.stringify(initial), updatedAt: 1 };
  const database = MobileDatabase.of({
    loadNoteOutbox: Effect.succeed([]),
    saveNoteOutbox: () => Effect.void,
    removeNoteOutbox: () => Effect.void,
    loadCache: () => Effect.succeed(Option.none()),
    listCache: () => Effect.succeed([]),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.sync(() => Option.some(stored)),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.sync(() => {
        stored = { payload, updatedAt };
      }),
  });
  const secureStorage = MobileSecureStorage.of({
    getItem: () => Effect.succeed(null),
    setItem: () => Effect.void,
    removeItem: () => Effect.void,
  });
  const make = MobilePreferences.make().pipe(
    Effect.provideService(MobileDatabase, database),
    Effect.provideService(MobileSecureStorage, secureStorage),
  );
  return { make, payload: () => JSON.parse(stored.payload) as unknown };
}

describe("GOAT Bot mobile preferences", () => {
  it.effect("saves and reloads both home modes and the full bot reference with a fresh store", () =>
    Effect.gen(function* () {
      const storage = fixture({ themeMode: "dark" });
      const store = yield* storage.make;
      const goatBotRef = {
        environmentId: EnvironmentId.make("env"),
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("thread"),
      };
      yield* store.savePatch({ homeMode: "bot", goatBotRef });
      expect(storage.payload()).toEqual({ themeMode: "dark", homeMode: "bot", goatBotRef });
      const reopened = yield* storage.make;
      expect(yield* reopened.load).toEqual({ themeMode: "dark", homeMode: "bot", goatBotRef });
      yield* reopened.savePatch({ homeMode: "thread" });
      expect(yield* (yield* storage.make).load).toEqual({
        themeMode: "dark",
        homeMode: "thread",
        goatBotRef,
      });
    }),
  );
  it.effect("keeps older preferences without inventing a bot", () =>
    Effect.gen(function* () {
      const store = yield* fixture({ themeMode: "light" }).make;
      expect(yield* store.load).toEqual({ themeMode: "light" });
    }),
  );
  it.effect("discards unknown modes and malformed bot references", () =>
    Effect.gen(function* () {
      for (const goatBotRef of [
        null,
        [],
        "bot",
        {},
        { environmentId: "env", threadId: "thread" },
        { environmentId: 7, projectId: "project", threadId: "thread" },
        { environmentId: "env", projectId: false, threadId: "thread" },
        { environmentId: "env", projectId: "project", threadId: 2 },
        { environmentId: "env", projectId: "project", threadId: " " },
      ]) {
        const store = yield* fixture({ homeMode: "unknown", goatBotRef, themeMode: "dark" }).make;
        expect(yield* store.load).toEqual({ themeMode: "dark" });
      }
    }),
  );
  it.effect("retains only the three server confirmed identity fields", () =>
    Effect.gen(function* () {
      const store = yield* fixture({
        homeMode: "bot",
        goatBotRef: {
          environmentId: "env",
          projectId: "project",
          threadId: "thread",
          extra: "ignored",
        },
      }).make;
      expect(yield* store.load).toEqual({
        homeMode: "bot",
        goatBotRef: { environmentId: "env", projectId: "project", threadId: "thread" },
      });
    }),
  );
});
