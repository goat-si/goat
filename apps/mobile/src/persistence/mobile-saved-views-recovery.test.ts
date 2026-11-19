import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const { values } = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("./mobile-database-migration", () => ({
  openMigratedMobileDatabase: () => Promise.reject(new Error("no sqlite")),
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

const layer = Layer.mergeAll(MobileDatabase.layer, MobileSecureStorage.layer);
const stored = () =>
  JSON.parse(JSON.parse(values.get("goat.preferences.fallback") ?? "{}").payload);
const view = (i: number) => ({
  id: String(i),
  name: `View ${i}`,
  environmentId: null,
  query: "",
  controls: {
    state: "open" as const,
    involvement: "all" as const,
    filters: {},
    sort: "updated" as const,
  },
});
const seed = (views: unknown) => {
  values.clear();
  values.set(
    "goat.preferences.fallback",
    JSON.stringify({
      payload: JSON.stringify({ language: "en", pullRequestSavedViews: views }),
      updatedAt: 1,
    }),
  );
};

describe("recover saved pull request views", () => {
  it.effect(
    "keeps oversized views through unrelated writes and allows deleting to below the cap",
    () =>
      Effect.gen(function* () {
        const original = Array.from({ length: 51 }, (_, i) => view(i));
        seed(original);
        const store = yield* MobilePreferences.make();
        const loaded = yield* store.load;
        expect(loaded.pullRequestSavedViews).toHaveLength(50);
        expect(loaded.pullRequestSavedViewsStatus).toBe("overflow");
        yield* store.savePatch({ language: "ko" });
        expect(stored().pullRequestSavedViews).toEqual(original);
        const afterDeletion = yield* store.update((current) => ({
          pullRequestSavedViews: current.pullRequestSavedViews?.filter((item) => item.id !== "0"),
        }));
        expect(Object.hasOwn(afterDeletion, "pullRequestSavedViewsStatus")).toBe(true);
        expect(afterDeletion.pullRequestSavedViewsStatus).toBeUndefined();
        expect(stored().pullRequestSavedViews).toHaveLength(50);
        const atLimit = yield* Effect.result(
          store.update((current) => ({
            pullRequestSavedViews: [...(current.pullRequestSavedViews ?? []), view(99)],
          })),
        );
        expect(atLimit._tag).toBe("Failure");
        yield* store.update((current) => ({
          pullRequestSavedViews: current.pullRequestSavedViews?.filter((item) => item.id !== "1"),
        }));
        expect(stored().pullRequestSavedViews).toHaveLength(49);
        yield* store.update((current) => ({
          pullRequestSavedViews: [...(current.pullRequestSavedViews ?? []), view(99)],
        }));
        expect(stored().pullRequestSavedViews).toHaveLength(50);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("retains malformed views on unrelated writes until explicitly cleared", () =>
    Effect.gen(function* () {
      seed("unreadable");
      const store = yield* MobilePreferences.make();
      const loaded = yield* store.load;
      expect(loaded.pullRequestSavedViews).toBeUndefined();
      expect(loaded.pullRequestSavedViewsStatus).toBe("unreadable");
      yield* store.savePatch({ language: "ko" });
      expect(stored().pullRequestSavedViews).toBe("unreadable");
      yield* store.savePatch({ pullRequestSavedViews: [] });
      expect(stored().pullRequestSavedViews).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});

it.effect("preserves the exact saved-view JSON value bytes during an unrelated update", () =>
  Effect.gen(function* () {
    values.clear();
    const fragment = '"unread\\u0061ble"';
    const payload = `{"language":"en","pullRequestSavedViews":${fragment}}`;
    values.set("goat.preferences.fallback", JSON.stringify({ payload, updatedAt: 1 }));
    const store = yield* MobilePreferences.make();
    yield* store.savePatch({ language: "ko" });
    const next = JSON.parse(values.get("goat.preferences.fallback") ?? "{}").payload as string;
    expect(next).toContain(`"pullRequestSavedViews":${fragment}`);
  }).pipe(Effect.provide(layer)),
);
