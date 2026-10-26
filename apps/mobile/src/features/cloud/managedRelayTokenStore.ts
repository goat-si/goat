import { ManagedRelay } from "@goat/client-runtime/relay";
import { LEGACY_RELAY_CLIENT_IDS } from "@goat/contracts/legacyT3Names";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { secureStore } from "../../persistence/namespaced-secure-store";

const MANAGED_RELAY_TOKEN_CACHE_KEY = "goat.cloud.relay-access-tokens";
const MANAGED_RELAY_TOKEN_CACHE_VERSION = 1;

// Entries cached before the GOAT client ids keep their old id; reading maps it so the cache still loads.
const ManagedRelayAccessTokenCacheEntrySchema = Schema.Struct({
  accountId: Schema.String,
  clientId: Schema.Literals([
    "goat-mobile",
    "goat-web",
    LEGACY_RELAY_CLIENT_IDS.mobile,
    LEGACY_RELAY_CLIENT_IDS.web,
  ]),
  relayUrl: Schema.String,
  thumbprint: Schema.String,
  scopes: Schema.Array(
    Schema.Literals(["environment:connect", "environment:status", "mobile:registration"]),
  ),
  accessToken: Schema.String,
  expiresAtMillis: Schema.Number,
});

const ManagedRelayAccessTokenCacheSchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(MANAGED_RELAY_TOKEN_CACHE_VERSION),
    entries: Schema.Array(ManagedRelayAccessTokenCacheEntrySchema),
  }),
);

const decodeManagedRelayAccessTokenCache = Schema.decodeUnknownEffect(
  ManagedRelayAccessTokenCacheSchema,
);
const encodeManagedRelayAccessTokenCache = Schema.encodeEffect(ManagedRelayAccessTokenCacheSchema);

export class ManagedRelayTokenStoreError extends Schema.TaggedError<ManagedRelayTokenStoreError>()(
  "ManagedRelayTokenStoreError",
  {
    operation: Schema.Literals(["read", "decode", "encode", "write", "clear"]),
    storageKey: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed relay token store operation "${this.operation}" failed for key "${this.storageKey}".`;
  }
}

function logStoreFailure(error: ManagedRelayTokenStoreError) {
  return Effect.logWarning("Managed relay token store operation failed.", {
    errorTag: error._tag,
    operation: error.operation,
    storageKey: error.storageKey,
    cause: error,
  });
}

const loadManagedRelayAccessTokens = Effect.tryPromise({
  try: () => secureStore.getItem(MANAGED_RELAY_TOKEN_CACHE_KEY),
  catch: (cause) =>
    new ManagedRelayTokenStoreError({
      operation: "read",
      storageKey: MANAGED_RELAY_TOKEN_CACHE_KEY,
      cause,
    }),
}).pipe(
  Effect.flatMap((encoded) =>
    encoded === null
      ? Effect.succeed<ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry>>([])
      : decodeManagedRelayAccessTokenCache(encoded).pipe(
          Effect.map((cache) =>
            cache.entries.map((entry): ManagedRelay.ManagedRelayAccessTokenCacheEntry => ({
              ...entry,
              clientId:
                entry.clientId === LEGACY_RELAY_CLIENT_IDS.mobile
                  ? "goat-mobile"
                  : entry.clientId === LEGACY_RELAY_CLIENT_IDS.web
                    ? "goat-web"
                    : entry.clientId,
            })),
          ),
          Effect.mapError(
            (cause) =>
              new ManagedRelayTokenStoreError({
                operation: "decode",
                storageKey: MANAGED_RELAY_TOKEN_CACHE_KEY,
                cause,
              }),
          ),
        ),
  ),
);

const saveManagedRelayAccessTokens = (
  entries: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry>,
) =>
  encodeManagedRelayAccessTokenCache({
    version: MANAGED_RELAY_TOKEN_CACHE_VERSION,
    entries,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ManagedRelayTokenStoreError({
          operation: "encode",
          storageKey: MANAGED_RELAY_TOKEN_CACHE_KEY,
          cause,
        }),
    ),
    Effect.flatMap((encoded) =>
      Effect.tryPromise({
        try: () => secureStore.setItem(MANAGED_RELAY_TOKEN_CACHE_KEY, encoded),
        catch: (cause) =>
          new ManagedRelayTokenStoreError({
            operation: "write",
            storageKey: MANAGED_RELAY_TOKEN_CACHE_KEY,
            cause,
          }),
      }),
    ),
  );

const clearManagedRelayAccessTokens = Effect.tryPromise({
  try: () => secureStore.removeItem(MANAGED_RELAY_TOKEN_CACHE_KEY),
  catch: (cause) =>
    new ManagedRelayTokenStoreError({
      operation: "clear",
      storageKey: MANAGED_RELAY_TOKEN_CACHE_KEY,
      cause,
    }),
});

export const managedRelayAccessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
  load: loadManagedRelayAccessTokens.pipe(
    Effect.tapError(logStoreFailure),
    Effect.orElseSucceed(() => []),
    Effect.withSpan("mobile.managedRelayTokenStore.load"),
  ),
  save: Effect.fn("mobile.managedRelayTokenStore.save")((entries) =>
    saveManagedRelayAccessTokens(entries).pipe(Effect.tapError(logStoreFailure), Effect.ignore),
  ),
  clear: clearManagedRelayAccessTokens.pipe(
    Effect.tapError(logStoreFailure),
    Effect.ignore,
    Effect.withSpan("mobile.managedRelayTokenStore.clear"),
  ),
};
