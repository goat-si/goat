import { expect, vi } from "vite-plus/test";
import { describe, it } from "@effect/vitest";
import { ProviderInstanceId, ServerSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { resolveKey, makeCursorCloudCredentials } from "./credentials.ts";
import * as CursorCloudSdk from "./sdk.ts";

const instanceId = ProviderInstanceId.make("cursorCloud-test");
const siblingId = ProviderInstanceId.make("cursor-account-2");
const stored = (apiKey: string, apiKeyExpiresAtMs?: number) => ({
  version: 1 as const,
  backendUrl: "https://api2.cursor.sh",
  apiKey,
  createdAtMs: 0,
  ...(apiKeyExpiresAtMs === undefined ? {} : { apiKeyExpiresAtMs }),
});

const decodeSettings = Schema.decodeEffect(ServerSettings);

const credentialFixture = (settings: ServerSettings) => {
  const getKey = vi.fn(() =>
    Effect.succeedSome(new TextEncoder().encode(JSON.stringify(stored("binding-fixture")))),
  );
  const readLogin = vi.fn(() => Effect.succeed(stored("fallback-fixture")));
  const set = vi.fn(() => Effect.void);
  const remove = vi.fn(() => Effect.void);
  const open = vi.fn(() =>
    Effect.succeed({
      binding: { owner: "t3" as const, key: "cursor:account-2" },
      get: Effect.suspend(getKey),
      set,
      remove: Effect.suspend(remove),
    }),
  );
  const host = ProviderHost.ProviderHost.of({
    paths: {
      cwd: "/fixture",
      baseDir: "/fixture",
      stateDir: "/fixture",
      providerStatusCacheDir: "/fixture",
      attachmentsDir: "/fixture",
    },
    settings: {
      get: Effect.succeed(settings),
      withSnapshot: (use) => use(settings),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: () => Effect.succeed(true),
    resolveAttachmentPath: () => null,
    credentials: open,
  });
  const sdk = CursorCloudSdk.CursorCloudSdk.of({
    create: () => Promise.reject(new Error("not used")),
    resume: () => Promise.reject(new Error("not used")),
    getRun: () => Promise.reject(new Error("not used")),
    cancelRun: () => Promise.reject(new Error("not used")),
    readLogin: Effect.suspend(readLogin),
    checkAccess: () => Effect.void,
    readModels: () => Effect.succeed([]),
  });
  return { host, sdk, getKey, readLogin, set, remove, open };
};

describe("Cursor Cloud credential precedence", () => {
  it.effect("uses the sibling key without reading the SDK fallback", () =>
    Effect.gen(function* () {
      const fallback = vi.fn(() => Effect.succeed(stored("sdk-fixture")));
      const key = yield* resolveKey({
        instanceId,
        sibling: Effect.succeed(stored("sibling-fixture")),
        fallback: Effect.suspend(fallback),
      });
      expect(key).toBe("sibling-fixture");
      expect(fallback).not.toHaveBeenCalled();
    }),
  );
  it.effect("retains the sibling's existing explicit-key override", () =>
    Effect.gen(function* () {
      const sibling = vi.fn(() => Effect.succeed(stored("stored-fixture")));
      const key = yield* resolveKey({
        instanceId,
        configuredKey: "configured-fixture",
        sibling: Effect.suspend(sibling),
        fallback: Effect.succeed(undefined),
      });
      expect(key).toBe("configured-fixture");
      expect(sibling).not.toHaveBeenCalled();
    }),
  );
  it.effect("falls back when the GOAT key is missing or expired", () =>
    Effect.gen(function* () {
      for (const value of [undefined, stored("expired-fixture", 0)]) {
        const key = yield* resolveKey({
          instanceId,
          sibling: Effect.succeed(value),
          fallback: Effect.succeed(stored("sdk-fixture")),
        });
        expect(key).toBe("sdk-fixture");
      }
    }),
  );
  it.effect("rejects absent/expired or foreign-backend fallback keys", () =>
    Effect.gen(function* () {
      for (const value of [
        undefined,
        stored("expired-fixture", 0),
        { ...stored("foreign-fixture"), backendUrl: "https://example.invalid" },
      ]) {
        const result = yield* resolveKey({
          instanceId,
          sibling: Effect.succeed(undefined),
          fallback: Effect.succeed(value),
        }).pipe(Effect.flip);
        expect(result._tag).toBe("ProviderSetupError");
        expect(result.message).not.toContain("foreign-fixture");
      }
    }),
  );
  it.effect("opens the sibling GOAT binding and never writes or clears credentials", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({
        providerInstances: {
          [siblingId]: { driver: "cursor", enabled: true, config: {} },
        },
      });
      const { host, sdk, set, remove, open } = credentialFixture(settings);
      const result = yield* Effect.gen(function* () {
        const credentials = yield* makeCursorCloudCredentials(instanceId, siblingId);
        const key = yield* credentials.requireApiKey;
        const logout = yield* credentials.auth.logout(Effect.void).pipe(Effect.flip);
        return { key, binding: credentials.auth.credentialBinding, logout };
      }).pipe(
        Effect.provideService(ProviderHost.ProviderHost, host),
        Effect.provideService(CursorCloudSdk.CursorCloudSdk, sdk),
      );
      expect(open).toHaveBeenCalledWith("cursor", siblingId);
      expect(result.key).toBe("binding-fixture");
      expect(result.binding).toEqual({ owner: "t3", key: "cursor:account-2" });
      expect(result.logout._tag).toBe("ProviderSetupError");
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    }),
  );
  it.effect("rejects a missing explicit sibling before reading either key source", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({ providerInstances: {} });
      const h = credentialFixture(settings);
      const failure = yield* Effect.gen(function* () {
        const credentials = yield* makeCursorCloudCredentials(instanceId, siblingId);
        return yield* credentials.requireApiKey;
      }).pipe(
        Effect.provideService(ProviderHost.ProviderHost, h.host),
        Effect.provideService(CursorCloudSdk.CursorCloudSdk, h.sdk),
        Effect.flip,
      );
      expect(failure._tag).toBe("ProviderSetupError");
      expect(failure.instanceId).toBe(instanceId);
      expect(h.getKey).not.toHaveBeenCalled();
      expect(h.readLogin).not.toHaveBeenCalled();
    }),
  );
  it.effect("rejects an existing non-Cursor sibling before reading either key source", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({
        providerInstances: {
          [siblingId]: { driver: "grok", enabled: true, config: {} },
        },
      });
      const h = credentialFixture(settings);
      const failure = yield* Effect.gen(function* () {
        const credentials = yield* makeCursorCloudCredentials(instanceId, siblingId);
        return yield* credentials.requireApiKey;
      }).pipe(
        Effect.provideService(ProviderHost.ProviderHost, h.host),
        Effect.provideService(CursorCloudSdk.CursorCloudSdk, h.sdk),
        Effect.flip,
      );
      expect(failure._tag).toBe("ProviderSetupError");
      expect(failure.instanceId).toBe(instanceId);
      expect(h.getKey).not.toHaveBeenCalled();
      expect(h.readLogin).not.toHaveBeenCalled();
    }),
  );
});
