import type { SdkCredentialStore } from "@cursor/sdk";
import { ProviderSetupError, type ProviderInstanceId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderHost from "@goat/provider-core/server/ProviderHost";

const Credentials = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    backendUrl: Schema.String,
    apiKey: Schema.String,
    createdAtMs: Schema.Finite,
    apiKeyExpiresAtMs: Schema.optionalKey(Schema.Finite),
    email: Schema.optionalKey(Schema.String),
  }),
);

const decodeCredentials = Schema.decodeUnknownEffect(Credentials);
const encodeCredentials = Schema.encodeEffect(Credentials);

export const makeCursorCredentialStore = Effect.fn("makeCursorCredentialStore")(function* (
  instanceId: ProviderInstanceId,
  legacyFile?: string,
) {
  const credentials = yield* (yield* ProviderHost.ProviderHost).credentials("cursor", instanceId);
  if (legacyFile !== undefined) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.gen(function* () {
      const legacy = yield* fileSystem.readFileString(legacyFile).pipe(Effect.option);
      if (Option.isNone(legacy)) return;
      const stored = yield* credentials.get;
      const storedIsValid =
        Option.isSome(stored) &&
        Option.isSome(
          yield* decodeCredentials(new TextDecoder().decode(stored.value)).pipe(Effect.option),
        );
      if (
        !storedIsValid &&
        Option.isSome(yield* decodeCredentials(legacy.value).pipe(Effect.option))
      ) {
        yield* credentials.set(new TextEncoder().encode(legacy.value));
      }
      yield* fileSystem.remove(legacyFile);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not migrate legacy Cursor credentials", error),
      ),
    );
  }
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const store: SdkCredentialStore = {
    load: () =>
      runPromise(
        credentials.get.pipe(
          Effect.flatMap(
            Option.match({
              // @effect-diagnostics-next-line effectSucceedWithVoid:off - The SDK credential API requires undefined, not void.
              onNone: () => Effect.succeed(undefined),
              onSome: (bytes) =>
                decodeCredentials(new TextDecoder().decode(bytes)).pipe(
                  Effect.orElseSucceed(() => undefined),
                ),
            }),
          ),
        ),
      ),
    // The SDK can supply undefined optional fields despite its exact optional types.
    save: ({ email, apiKeyExpiresAtMs, ...requiredFields }) =>
      runPromise(
        encodeCredentials({
          ...requiredFields,
          ...(email === undefined ? {} : { email }),
          ...(apiKeyExpiresAtMs === undefined ? {} : { apiKeyExpiresAtMs }),
        }).pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "credentials",
                detail: "Cursor returned an unsupported credential format.",
              }),
          ),
          Effect.flatMap((encoded) => credentials.set(new TextEncoder().encode(encoded))),
        ),
      ),
    clear: () => runPromise(credentials.remove),
  };
  return { store, binding: credentials.binding };
});

/**
 * This instance's GOAT sign-in, expired or not, and the backend it was made against, read without
 * the SDK. Fails when a stored sign-in cannot be read; `undefined` means there is none.
 */
export const readStoredCursorSignIn = Effect.fn("readStoredCursorSignIn")(function* (
  instanceId: ProviderInstanceId,
) {
  const stored = yield* (yield* (yield* ProviderHost.ProviderHost).credentials(
    "cursor",
    instanceId,
  )).get;
  if (Option.isNone(stored)) return undefined;
  const { apiKey, apiKeyExpiresAtMs, backendUrl } = yield* decodeCredentials(
    new TextDecoder().decode(stored.value),
  );
  const expired =
    apiKeyExpiresAtMs !== undefined && apiKeyExpiresAtMs <= (yield* Clock.currentTimeMillis);
  return { apiKey, backendUrl, expired };
});
