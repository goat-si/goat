// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` implements Chromium's OSCrypt
// decryption (PBKDF2 + AES-CBC/GCM); Effect has no equivalent.
import * as NodeCrypto from "node:crypto";

import type { DesktopAppStageLabel } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import {
  decodeWindowsWrappedKey,
  unwrapWindowsDpapiKey,
  type ChromiumKeyError,
} from "../preview/BrowserImport/ChromiumKeys.ts";
import { bypassesOsKeyStore } from "./DesktopDevSecretStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  platformSafeStorageKeyStore,
  type SafeStorageKeyStore,
} from "./DesktopSafeStorageKeyMigration.ts";

/**
 * Stable, nightly, and dev builds have separate GOAT homes and Chromium profiles. macOS/Linux
 * key safeStorage by runtime name; Windows keeps a DPAPI-wrapped key in each profile's Local
 * State. A channel copy retains ciphertext from its source, so recovery reads the sibling's key
 * and decrypts with Chromium's OSCrypt scheme before re-encrypting under this channel's key.
 *
 * The sibling's macOS Keychain item belongs to another app, so macOS asks the user once before
 * this app may read it. Windows unwraps the sibling profile's key as the current OS user.
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

interface WindowsSiblingKeys {
  readonly readLocalState: (
    profile: string,
  ) => Effect.Effect<string, PlatformError.PlatformError | ChromiumKeyError>;
  /** Injectable OS boundary; production uses PowerShell DPAPI with bytes on stdin, never argv. */
  readonly unprotect: (wrapped: Buffer) => Effect.Effect<Uint8Array, ChromiumKeyError>;
}

const WINDOWS_PROFILES = [
  { profile: "goat-desktop-nightly", runtimeName: "GOAT Nightly" },
  { profile: "goat-desktop", runtimeName: "GOAT Alpha" },
  { profile: "goat-desktop-dev", runtimeName: "GOAT Dev" },
];

const decryptWindowsValue = (ciphertext: Uint8Array, key: Uint8Array): string | null => {
  const buffer = Buffer.from(ciphertext);
  // Chromium v10: three-byte version, twelve-byte nonce, ciphertext, sixteen-byte GCM tag.
  if (key.length !== 32 || buffer.length < 31 || buffer.subarray(0, 3).toString() !== "v10") {
    return null;
  }
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, buffer.subarray(3, 15));
    decipher.setAuthTag(buffer.subarray(-16));
    return utf8.decode(
      Buffer.concat([decipher.update(buffer.subarray(15, -16)), decipher.final()]),
    );
  } catch {
    return null;
  }
};

const decryptWindows = Effect.fn("desktop.safeStorageSiblingKeys.decryptWindows")(function* (
  windows: WindowsSiblingKeys,
  runtimeName: string,
  ciphertext: Uint8Array,
  accept: (plaintext: string) => boolean,
) {
  for (const sibling of WINDOWS_PROFILES) {
    if (sibling.runtimeName === runtimeName) continue;
    const key = yield* windows.readLocalState(sibling.profile).pipe(
      Effect.flatMap(decodeWindowsWrappedKey),
      Effect.flatMap(windows.unprotect),
      // A missing profile or refused DPAPI access must not prevent trying another channel.
      Effect.option,
    );
    if (Option.isNone(key)) continue;
    const plaintext = decryptWindowsValue(ciphertext, key.value);
    if (plaintext !== null && accept(plaintext)) {
      return Option.some({ plaintext, runtimeName: sibling.runtimeName });
    }
  }
  return Option.none<SiblingDecryption>();
});

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
  windows?: WindowsSiblingKeys,
) =>
  DesktopSafeStorageSiblingKeys.of({
    decrypt: Effect.fn("desktop.safeStorageSiblingKeys.decrypt")(
      function* (ciphertext, accept) {
        if (platform === "win32") {
          return windows === undefined
            ? Option.none<SiblingDecryption>()
            : yield* decryptWindows(windows, runtimeName, ciphertext, accept);
        }
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
    const fs = yield* FileSystem.FileSystem;
    const bypass = yield* bypassesOsKeyStore(environment);
    // Browser imports use the same Chromium DPAPI wrapper and stdin-only PowerShell boundary.
    let windows: WindowsSiblingKeys | undefined;
    if (environment.platform === "win32" && !bypass) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      windows = {
        readLocalState: (profile: string) =>
          fs.readFileString(
            environment.path.join(environment.appDataDirectory, profile, "Local State"),
          ),
        unprotect: (wrapped: Buffer) =>
          unwrapWindowsDpapiKey(wrapped).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
      };
    }
    return makeWith(
      // Bypassed runs never read the key store; an unreadable file is still backed up, not lost.
      bypass ? async () => null : platformSafeStorageKeyStore,
      environment.platform,
      DesktopEnvironment.desktopRuntimeAppName(environment.branding.stageLabel),
      windows,
    );
  }),
);
