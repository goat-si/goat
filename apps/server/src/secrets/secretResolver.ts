import {
  OnePasswordSecretProviderConfig,
  type SecretReference,
  type ServerSettings,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { readOnePassword } from "./onePassword.ts";

const isOnePasswordConfig = Schema.is(OnePasswordSecretProviderConfig);

const MAX_ACTIVE_READS = 8;
const MAX_WAITING_READS = 128;
let activeReads = 0;
const waitingReads: Array<() => void> = [];

export function withSecretReadAdmission<A>(
  read: () => Promise<A>,
  signal?: AbortSignal,
): Promise<A> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Secret read cancelled"));
    const abort = () => {
      const index = waitingReads.indexOf(start);
      if (index < 0) return;
      waitingReads.splice(index, 1);
      reject(new Error("Secret read cancelled"));
    };
    const start = () => {
      signal?.removeEventListener("abort", abort);
      activeReads++;
      let operation: Promise<A>;
      try {
        operation = read();
      } catch (error) {
        operation = Promise.reject(error);
      }
      operation.then(resolve, reject).finally(() => {
        activeReads--;
        waitingReads.shift()?.();
      });
    };
    if (activeReads < MAX_ACTIVE_READS) return start();
    if (waitingReads.length >= MAX_WAITING_READS)
      return reject(new Error("Secret provider is busy"));
    waitingReads.push(start);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

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

export function makeSecretResolver(read: typeof readOnePassword = readOnePassword) {
  const cache = new Map<
    string,
    { readonly ok: true; readonly value: string } | { readonly ok: false }
  >();
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
    if (cached) {
      if (cached.ok) return cached.value;
      throw new Error("Could not read secret from 1Password");
    }
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= MAX_ACTIVE_READS) throw new Error("Secret provider is busy");
    if (cache.size + pending.size >= 128) throw new Error("Secret provider cache is full");
    const operation = withSecretReadAdmission(() => resolveSecret(providers, reference, read))
      .then((value) => {
        if (currentGeneration !== generation) return value;
        cache.set(key, { ok: true, value });
        return value;
      })
      .catch(() => {
        if (currentGeneration === generation) cache.set(key, { ok: false });
        throw new Error("Could not read secret from 1Password");
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
