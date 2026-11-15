import {
  ProviderInstanceId,
  type SecretReference,
  type SecretSourceCheckResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { providerSecretReferences } from "../provider/providerConfigSecrets.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { readOnePassword } from "./onePassword.ts";
import { cachedResolveSecret, resolveSecret, withSecretReadAdmission } from "./secretResolver.ts";

const READ_TIMEOUT = "45 seconds";

export class SecretCheck extends Context.Service<
  SecretCheck,
  {
    /**
     * Reads one secret now, bypassing the cache, for the Settings check button; the value never
     * leaves the server. A readable secret reloads the provider instances that use it.
     */
    readonly check: (reference: SecretReference) => Effect.Effect<SecretSourceCheckResult>;
  }
>()("goat/secrets/SecretCheck") {}

export const make = Effect.fn("SecretCheck.make")(function* (
  read: typeof readOnePassword = readOnePassword,
) {
  {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

    const check = Effect.fn("SecretCheck.check")(function* (reference: SecretReference) {
      const settings = yield* serverSettings.getSettings.pipe(Effect.option);
      if (Option.isNone(settings)) {
        return { _tag: "Failed", detail: "Could not read this environment's settings." } as const;
      }
      const label = settings.value.secretProviders[reference.provider]?.label ?? reference.provider;
      const value = yield* Effect.tryPromise(() =>
        withSecretReadAdmission(() =>
          resolveSecret(settings.value.secretProviders, reference, read),
        ),
      ).pipe(Effect.timeout(READ_TIMEOUT), Effect.option);
      if (Option.isNone(value) || value.value.trim() === "") {
        return {
          _tag: "Failed",
          detail: `Could not read this secret from "${label}". Check the reference and that 1Password is unlocked.`,
        } as const;
      }
      // Later reads elsewhere see this value; other references keep their cached values.
      cachedResolveSecret.prime(settings.value.secretProviders, reference, value.value);
      const reload = providerRegistry.reloadSecretsAndRefresh;
      if (reload !== undefined) {
        const readers = Object.entries(deriveProviderInstanceConfigMap(settings.value)).flatMap(
          ([id, entry]) =>
            providerSecretReferences(entry).some(
              (candidate) =>
                candidate.provider === reference.provider &&
                candidate.reference === reference.reference,
            )
              ? [ProviderInstanceId.make(id)]
              : [],
        );
        // The reload uses the value just read, so the reference is not read (or prompted) again.
        const checked = { reference, value: value.value };
        yield* Effect.forEach(readers, (id) => reload(id, checked), { discard: true });
      }
      return { _tag: "Resolved" } as const;
    });

    return SecretCheck.of({ check });
  }
});

export const layer = Layer.effect(SecretCheck, make());
