// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` implements Chromium's OSCrypt
// decryption (PBKDF2 + AES-128-CBC); Effect has no equivalent.
import * as NodeCrypto from "node:crypto";

import type { DesktopAppStageLabel } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { bypassesOsKeyStore } from "./DesktopDevSecretStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  platformSafeStorageKeyStore,
  type SafeStorageKeyStore,
} from "./DesktopSafeStorageKeyMigration.ts";

/**
 * GOAT, GOAT (Nightly), and dev builds share one GOAT home, but each keeps its own safeStorage key
 * under its runtime name, so `safeStorage` in one channel cannot open a file another channel
 * encrypted. This reads a sibling channel's key from the same OS key store and decrypts with
 * Chromium's OSCrypt scheme directly, so shared files can be recovered and re-encrypted under this
 * channel's key.
 *
 * The sibling's macOS Keychain item belongs to another app, so macOS asks the user once before
 * this app may read it. Windows needs nothing: its key lives in the shared profile's Local State.
 */
export class DesktopSafeStorageSiblingKeys extends Context.Service<
  DesktopSafeStorageSiblingKeys,
  {
    /**
     * Tries each sibling channel's key in order and returns the first plaintext `accept` takes.
     * A wrong key can still yield valid padding, so callers must check the plaintext's shape.
     * Never fails; an unreadable key store or a refused prompt counts as no match.
     */
    readonly decrypt: (
      ciphertext: Uint8Array,
      accept: (plaintext: string) => boolean,
    ) => Effect.Effect<Option.Option<SiblingDecryption>>;
  }
>()("@goat/desktop/app/DesktopSafeStorageSiblingKeys") {}

interface SiblingDecryption {
  readonly plaintext: string;
  /** The runtime name whose key decrypted the value. */
  readonly runtimeName: string;
}

const STAGE_LABELS: readonly DesktopAppStageLabel[] = ["Nightly", "Alpha", "Dev"];
/**
 * Initial runtime names that keyed safeStorage in builds that set the runtime name too late.
 * Packaged builds take it from the staged package.json `name`, which is `t3code` on every
 * channel (scripts/build-desktop-artifact.ts).
 */
const PRODUCT_NAMES = ["t3code", "GOAT", "GOAT (Nightly)"];

/**
 * Runtime names that may hold a sibling channel's key, most likely first. Each existing item a
 * read reaches can prompt on macOS, so the current channel names come before legacy ones.
 */
const siblingRuntimeNames = (runtimeName: string): readonly string[] =>
  [
    ...new Set([
      ...STAGE_LABELS.map(DesktopEnvironment.desktopRuntimeAppName),
      ...STAGE_LABELS.map(DesktopEnvironment.legacyDesktopRuntimeAppName),
      ...PRODUCT_NAMES,
    ]),
  ].filter((name) => name !== runtimeName);

const OS_CRYPT_SALT = "saltysalt";
const OS_CRYPT_KEY_LENGTH = 16;
const OS_CRYPT_IV = Buffer.alloc(16, " ");
/** Version prefix and PBKDF2 rounds of keyring-backed safeStorage values, per platform. */
const OS_CRYPT_SCHEMES: Partial<
  Record<NodeJS.Platform, { readonly prefix: string; readonly iterations: number }>
> = {
  darwin: { prefix: "v10", iterations: 1003 },
  linux: { prefix: "v11", iterations: 1 },
};
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Decrypts one safeStorage value with a raw keyring secret, or null when the key does not fit. */
const decryptSafeStorageValue = (
  ciphertext: Uint8Array,
  secret: string,
  platform: NodeJS.Platform,
): string | null => {
  const scheme = OS_CRYPT_SCHEMES[platform];
  const buffer = Buffer.from(ciphertext);
  if (scheme === undefined || buffer.subarray(0, 3).toString("latin1") !== scheme.prefix) {
    return null;
  }
  try {
    const key = NodeCrypto.pbkdf2Sync(
      secret,
      OS_CRYPT_SALT,
      scheme.iterations,
      OS_CRYPT_KEY_LENGTH,
      "sha1",
    );
    const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", key, OS_CRYPT_IV);
    return utf8.decode(Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]));
  } catch {
    return null;
  }
};

export const makeWith = (
  openStore: (
    platform: NodeJS.Platform,
  ) => Promise<(SafeStorageKeyStore & { close?: () => void }) | null>,
  platform: NodeJS.Platform,
  runtimeName: string,
) =>
  DesktopSafeStorageSiblingKeys.of({
    decrypt: Effect.fn("desktop.safeStorageSiblingKeys.decrypt")(
      function* (ciphertext, accept) {
        const outcome = yield* Effect.tryPromise(async () => {
          const unreadable: Array<{ readonly runtimeName: string; readonly cause: unknown }> = [];
          const store = await openStore(platform);
          if (store === null) return { match: null, unreadable };
          try {
            for (const name of siblingRuntimeNames(runtimeName)) {
              let secret: string | null;
              try {
                secret = await store.read(name);
              } catch (cause) {
                unreadable.push({ runtimeName: name, cause });
                continue;
              }
              if (secret === null) continue;
              const plaintext = decryptSafeStorageValue(ciphertext, secret, platform);
              if (plaintext !== null && accept(plaintext)) {
                return { match: { plaintext, runtimeName: name }, unreadable };
              }
            }
            return { match: null, unreadable };
          } finally {
            store.close?.();
          }
        });
        for (const failure of outcome.unreadable) {
          yield* Effect.logWarning("Could not read a sibling GOAT safeStorage key", failure);
        }
        return Option.fromNullishOr(outcome.match);
      },
      Effect.catch((error) =>
        Effect.logWarning("Could not open the safeStorage key store", { error }).pipe(
          Effect.as(Option.none<SiblingDecryption>()),
        ),
      ),
    ),
  });

export const layer = Layer.effect(
  DesktopSafeStorageSiblingKeys,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return makeWith(
      // Bypassed runs never read the key store; an unreadable file is still backed up, not lost.
      (yield* bypassesOsKeyStore(environment)) ? async () => null : platformSafeStorageKeyStore,
      environment.platform,
      DesktopEnvironment.desktopRuntimeAppName(environment.branding.stageLabel),
    );
  }),
);
