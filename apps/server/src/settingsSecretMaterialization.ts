import type { ServerSettings } from "@goat/contracts";
import { ServerSettingsError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { mapSettingsSecrets, type SettingsSecret } from "./settingsSecrets.ts";

export const makeSettingsSecretMaterializer = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const semaphore = yield* Semaphore.make(1);
  const textDecoder = new TextDecoder();
  const materialize = Effect.fn("serverSettings.materializeSettingsSecrets")(function* <
    S extends ServerSettings,
  >(settings: S) {
    const storedSecrets = new Map<string, string>();
    const pending = new Map<string, SettingsSecret>();
    mapSettingsSecrets(settings, (secret) => {
      if (secret.sensitive && secret.redacted) pending.set(secret.secretName, secret);
      return secret;
    });
    for (const secret of pending.values()) {
      const value = yield* secretStore.get(secret.secretName).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              operation: "read-secret",
              providerInstanceId: secret.providerInstanceId,
              environmentVariable: secret.environmentVariable,
              cause,
            }),
        ),
      );
      storedSecrets.set(
        secret.secretName,
        Option.isSome(value) ? textDecoder.decode(value.value) : "",
      );
    }
    return mapSettingsSecrets(settings, (secret) => ({
      value:
        secret.sensitive && secret.redacted
          ? (storedSecrets.get(secret.secretName) ?? "")
          : secret.value,
      redacted: secret.sensitive && secret.kind === "environment" && secret.redacted,
    }));
  });
  let cached: { settings: ServerSettings; revision: number; value: ServerSettings } | undefined;
  // The cache hit stays untraced; materialize owns the I/O span on misses.
  return Effect.fnUntraced(function* <S extends ServerSettings>(settings: S) {
    return yield* semaphore.withPermits(1)(
      Effect.gen(function* () {
        const revision = yield* secretStore.revision ?? Effect.succeed(undefined);
        if (revision !== undefined && cached?.settings === settings && cached.revision === revision)
          return cached.value;
        const value = yield* materialize(settings);
        // A rotation during a read must not publish a stale or mixed snapshot into the cache.
        if (
          revision !== undefined &&
          revision === (yield* secretStore.revision ?? Effect.succeed(undefined))
        )
          cached = { settings, revision, value };
        else cached = undefined;
        return value;
      }),
    );
  });
});
