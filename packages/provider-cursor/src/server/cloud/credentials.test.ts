import { expect, vi } from "vite-plus/test";
import { describe, it } from "@effect/vitest";
import { ProviderInstanceId, ServerSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { resolveKey, makeCursorCloudCredentials } from "./credentials.ts";

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

const credentialFixture = (
  settings: ServerSettings,
  saved: ReturnType<typeof stored> | null = stored("binding-fixture"),
) => {
  const getKey = vi.fn(() =>
    saved === null
      ? Effect.succeedNone
      : Effect.succeedSome(new TextEncoder().encode(JSON.stringify(saved))),
  );
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
  return { host, getKey, set, remove, open };
};

const withProcessKey = <A, E, R>(value: string | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.CURSOR_API_KEY;
      if (value === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = value;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.CURSOR_API_KEY;
        else process.env.CURSOR_API_KEY = previous;
      }),
  );

describe("Cursor Cloud credential precedence", () => {
  it.effect("uses the sibling's GOAT sign-in", () =>
    Effect.gen(function* () {
      const key = yield* resolveKey({
        instanceId,
        sibling: Effect.succeed(stored("sibling-fixture")),
      });
      expect(key).toBe("sibling-fixture");
    }),
  );
  it.effect("retains the sibling's existing explicit-key override", () =>
    Effect.gen(function* () {
      const sibling = vi.fn(() => Effect.succeed(stored("stored-fixture")));
      const key = yield* resolveKey({
        instanceId,
        configuredKey: "configured-fixture",
        sibling: Effect.suspend(sibling),
      });
      expect(key).toBe("configured-fixture");
      expect(sibling).not.toHaveBeenCalled();
    }),
  );
  it.effect(
    "fails instead of using another account when the sign-in is absent, expired or foreign",
    () =>
      Effect.gen(function* () {
        for (const value of [
          undefined,
          stored("expired-fixture", 0),
          { ...stored("foreign-fixture"), backendUrl: "https://example.invalid" },
        ]) {
          const result = yield* resolveKey({
            instanceId,
            sibling: Effect.succeed(value),
          }).pipe(Effect.flip);
          expect(result._tag).toBe("ProviderSetupError");
          expect(result.message).not.toContain("foreign-fixture");
        }
      }),
  );
  it.effect("uses the server's CURSOR_API_KEY like the local Cursor provider does", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({
        providerInstances: {
          [siblingId]: { driver: "cursor", enabled: true, config: {} },
        },
      });
      const h = credentialFixture(settings);
      const key = yield* withProcessKey(
        "process-fixture",
        Effect.gen(function* () {
          const credentials = yield* makeCursorCloudCredentials(instanceId, siblingId);
          return yield* credentials.requireApiKey;
        }).pipe(Effect.provideService(ProviderHost.ProviderHost, h.host)),
      );
      expect(key).toBe("process-fixture");
    }),
  );
  it.effect("prefers the sibling's configured key over the server's", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({
        providerInstances: {
          [siblingId]: {
            driver: "cursor",
            enabled: true,
            config: {},
            environment: [{ name: "CURSOR_API_KEY", value: "instance-fixture" }],
          },
        },
      });
      const h = credentialFixture(settings);
      const key = yield* withProcessKey(
        "process-fixture",
        Effect.gen(function* () {
          const credentials = yield* makeCursorCloudCredentials(instanceId, siblingId);
          return yield* credentials.requireApiKey;
        }).pipe(Effect.provideService(ProviderHost.ProviderHost, h.host)),
      );
      expect(key).toBe("instance-fixture");
    }),
  );
  it.effect("fails when the selected Cursor provider is signed out", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({
        providerInstances: {
          [siblingId]: { driver: "cursor", enabled: true, config: {} },
        },
      });
      const h = credentialFixture(settings, null);
      const failure = yield* withProcessKey(
        undefined,
        Effect.gen(function* () {
          const credentials = yield* makeCursorCloudCredentials(instanceId, siblingId);
          return yield* credentials.requireApiKey;
        }).pipe(Effect.provideService(ProviderHost.ProviderHost, h.host), Effect.flip),
      );
      expect(failure._tag).toBe("ProviderSetupError");
      expect(h.getKey).toHaveBeenCalled();
    }),
  );
  it.effect("opens the sibling GOAT binding and never writes or clears credentials", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({
        providerInstances: {
          [siblingId]: { driver: "cursor", enabled: true, config: {} },
        },
      });
      const { host, set, remove, open } = credentialFixture(settings);
      const result = yield* withProcessKey(
        undefined,
        Effect.gen(function* () {
          const credentials = yield* makeCursorCloudCredentials(instanceId, siblingId);
          const key = yield* credentials.requireApiKey;
          const logout = yield* credentials.auth.logout(Effect.void).pipe(Effect.flip);
          return { key, binding: credentials.auth.credentialBinding, logout };
        }).pipe(Effect.provideService(ProviderHost.ProviderHost, host)),
      );
      expect(open).toHaveBeenCalledWith("cursor", siblingId);
      expect(result.key).toBe("binding-fixture");
      expect(result.binding).toEqual({ owner: "t3", key: "cursor:account-2" });
      expect(result.logout._tag).toBe("ProviderSetupError");
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    }),
  );
  it.effect("rejects a missing explicit sibling before reading its sign-in", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({ providerInstances: {} });
      const h = credentialFixture(settings);
      const failure = yield* Effect.gen(function* () {
        const credentials = yield* makeCursorCloudCredentials(instanceId, siblingId);
        return yield* credentials.requireApiKey;
      }).pipe(Effect.provideService(ProviderHost.ProviderHost, h.host), Effect.flip);
      expect(failure._tag).toBe("ProviderSetupError");
      expect(failure.instanceId).toBe(instanceId);
      expect(h.getKey).not.toHaveBeenCalled();
    }),
  );
  it.effect("rejects an existing non-Cursor sibling before reading its sign-in", () =>
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
      }).pipe(Effect.provideService(ProviderHost.ProviderHost, h.host), Effect.flip);
      expect(failure._tag).toBe("ProviderSetupError");
      expect(failure.instanceId).toBe(instanceId);
      expect(h.getKey).not.toHaveBeenCalled();
    }),
  );
});
