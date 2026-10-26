import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import * as HostProcess from "@goat/shared/HostProcess";

import { bypassesOsKeyStore } from "../app/DesktopDevSecretStorage.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const DEV_PLAINTEXT_SECRET_PREFIX = "goat-dev-plaintext:v1:";

const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
// Distinct prefix so development-plaintext blobs cannot collide with OS-encrypted blobs.
const devPlaintextPrefixBytes = textEncoder.encode(DEV_PLAINTEXT_SECRET_PREFIX);

const hasDevPlaintextPrefix = (value: Uint8Array): boolean =>
  value.byteLength >= devPlaintextPrefixBytes.byteLength &&
  devPlaintextPrefixBytes.every((byte, index) => value[index] === byte);

const encodeDevPlaintextSecret = (value: string): Uint8Array =>
  textEncoder.encode(`${DEV_PLAINTEXT_SECRET_PREFIX}${Base64.encode(textEncoder.encode(value))}`);

const decodeDevPlaintextSecret = (
  value: Uint8Array,
): Effect.Effect<string, ElectronSafeStorageDecryptError> =>
  Effect.gen(function* () {
    const encodedPayload = yield* Effect.try({
      try: () => utf8Decoder.decode(value.subarray(devPlaintextPrefixBytes.byteLength)),
      catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
    });
    const decodedBytes = yield* Effect.fromResult(Base64.decode(encodedPayload)).pipe(
      Effect.mapError((cause) => new ElectronSafeStorageDecryptError({ cause })),
    );
    return yield* Effect.try({
      try: () => utf8Decoder.decode(decodedBytes),
      catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
    });
  });

const electronSafeStorageErrorFields = {
  cause: Schema.Defect(),
};

export class ElectronSafeStorageAvailabilityError extends Schema.TaggedError<ElectronSafeStorageAvailabilityError>()(
  "ElectronSafeStorageAvailabilityError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to check encryption availability.";
  }
}

export class ElectronSafeStorageEncryptError extends Schema.TaggedError<ElectronSafeStorageEncryptError>()(
  "ElectronSafeStorageEncryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to encrypt a string.";
  }
}

export class ElectronSafeStorageDecryptError extends Schema.TaggedError<ElectronSafeStorageDecryptError>()(
  "ElectronSafeStorageDecryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to decrypt a string.";
  }
}

export const ElectronSafeStorageError = Schema.Union([
  ElectronSafeStorageAvailabilityError,
  ElectronSafeStorageEncryptError,
  ElectronSafeStorageDecryptError,
]);
export type ElectronSafeStorageError = typeof ElectronSafeStorageError.Type;

export class ElectronSafeStorage extends Context.Service<
  ElectronSafeStorage,
  {
    readonly isEncryptionAvailable: Effect.Effect<boolean, ElectronSafeStorageAvailabilityError>;
    readonly encryptString: (
      value: string,
    ) => Effect.Effect<Uint8Array, ElectronSafeStorageEncryptError>;
    readonly decryptString: (
      value: Uint8Array,
    ) => Effect.Effect<string, ElectronSafeStorageDecryptError>;
    readonly selectedStorageBackend: Effect.Effect<Option.Option<string>>;
  }
>()("@goat/desktop/electron/ElectronSafeStorage") {}

/** @public */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const desktopEnvironment = yield* Effect.serviceOption(DesktopEnvironment.DesktopEnvironment);
  // Never calls Electron.safeStorage when bypassed: any call can open the Keychain item.
  const bypassOsKeyStore = Option.isNone(desktopEnvironment)
    ? false
    : yield* bypassesOsKeyStore(desktopEnvironment.value);
  const warnedRef = yield* Ref.make(false);
  const warnBypassOnce = Ref.getAndSet(warnedRef, true).pipe(
    Effect.flatMap((alreadyWarned) =>
      alreadyWarned
        ? Effect.void
        : Effect.logWarning(
            "Storing desktop secrets with development-plaintext encoding instead of the OS keychain because GOAT_DEV_INSECURE_SECRET_STORAGE is enabled for an isolated home.",
          ),
    ),
  );

  return ElectronSafeStorage.of({
    isEncryptionAvailable: bypassOsKeyStore
      ? warnBypassOnce.pipe(Effect.as(true))
      : Effect.try({
          try: () => Electron.safeStorage.isEncryptionAvailable(),
          catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
        }),
    encryptString: (value) =>
      bypassOsKeyStore
        ? warnBypassOnce.pipe(Effect.as(encodeDevPlaintextSecret(value)))
        : Effect.try({
            try: () => Electron.safeStorage.encryptString(value),
            catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
          }),
    decryptString: (value) =>
      Effect.gen(function* () {
        if (hasDevPlaintextPrefix(value)) {
          if (!bypassOsKeyStore) {
            return yield* new ElectronSafeStorageDecryptError({
              cause: new Error(
                "Refusing to decrypt a development plaintext secret while insecure development secret storage is inactive.",
              ),
            });
          }
          yield* warnBypassOnce;
          return yield* decodeDevPlaintextSecret(value);
        }
        if (bypassOsKeyStore) {
          // Saved under the OS keychain before the opt-in. It stays on disk untouched; unset the
          // flag to read it, or enter the credential again to store a development copy.
          return yield* new ElectronSafeStorageDecryptError({
            cause: new Error(
              "This secret was encrypted with the OS keychain, which GOAT_DEV_INSECURE_SECRET_STORAGE bypasses. Unset it to read the secret, or enter the credential again.",
            ),
          });
        }
        return yield* Effect.try({
          try: () => Electron.safeStorage.decryptString(Buffer.from(value)),
          catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
        });
      }),
    selectedStorageBackend: Effect.sync(() => {
      if (platform !== "linux" || bypassOsKeyStore) {
        return Option.none();
      }
      try {
        return Option.fromNullishOr(Electron.safeStorage.getSelectedStorageBackend());
      } catch {
        return Option.none();
      }
    }),
  });
});

export const layer = Layer.effect(ElectronSafeStorage, make);
