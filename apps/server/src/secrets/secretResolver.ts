import {
  OnePasswordSecretProviderConfig,
  type SecretReference,
  type ServerSettings,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { readOnePassword } from "./onePassword.ts";

const isOnePasswordConfig = Schema.is(OnePasswordSecretProviderConfig);

export async function resolveSecret(
  providers: ServerSettings["secretProviders"],
  reference: SecretReference,
  read: typeof readOnePassword = readOnePassword,
): Promise<string> {
  const provider = providers[reference.provider];
  if (provider?.kind !== "one_password" || !isOnePasswordConfig(provider.config)) {
    throw new Error("Secret provider unavailable");
  }
  return read(provider.config.account, reference.reference);
}

export function makeSecretResolver(
  read: typeof readOnePassword = readOnePassword,
  // @effect-diagnostics-next-line globalDate:off -- The cache serves Promise-based callers.
  now = () => Date.now(),
) {
  const cache = new Map<string, { readonly value: string; readonly expires: number }>();
  const pending = new Map<string, Promise<string>>();
  let generation = 0;
  const resolve = async (
    providers: ServerSettings["secretProviders"],
    reference: SecretReference,
  ) => {
    const provider = providers[reference.provider];
    if (provider?.kind !== "one_password" || !isOnePasswordConfig(provider.config)) {
      throw new Error("Secret provider unavailable");
    }
    const currentGeneration = generation;
    const key = `${currentGeneration}\u0000${reference.provider}\u0000${provider.config.account}\u0000${reference.reference}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    cache.delete(key);
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 8) throw new Error("Secret provider is busy");
    const operation = resolveSecret(providers, reference, read)
      .then((value) => {
        if (currentGeneration !== generation) return value;
        if (cache.size >= 128) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { value, expires: now() + 60_000 });
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
  return Object.assign(resolve, {
    invalidate: () => {
      generation++;
      cache.clear();
    },
  });
}

export const cachedResolveSecret = makeSecretResolver();
