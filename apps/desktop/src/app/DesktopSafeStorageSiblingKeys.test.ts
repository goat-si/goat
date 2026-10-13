// @effect-diagnostics nodeBuiltinImport:off - Builds OSCrypt fixtures the way Chromium writes them.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { SafeStorageKeyStore } from "./DesktopSafeStorageKeyMigration.ts";
import * as DesktopSafeStorageSiblingKeys from "./DesktopSafeStorageSiblingKeys.ts";

/** Chromium OSCrypt: PBKDF2-SHA1 over "saltysalt", AES-128-CBC with a space-filled IV. */
const osCryptEncrypt = (plaintext: string, secret: string, prefix: string, iterations: number) => {
  const key = NodeCrypto.pbkdf2Sync(secret, "saltysalt", iterations, 16, "sha1");
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return new Uint8Array(
    Buffer.concat([Buffer.from(prefix), cipher.update(plaintext, "utf8"), cipher.final()]),
  );
};

const storeWith = (keys: Record<string, string | Error>, reads: string[] = []) =>
  Promise.resolve<SafeStorageKeyStore>({
    read: async (name) => {
      reads.push(name);
      const key = keys[name];
      if (key instanceof Error) throw key;
      return key ?? null;
    },
    write: async () => {
      throw new Error("sibling recovery never writes keys");
    },
  });

const acceptAll = () => true;

describe("DesktopSafeStorageSiblingKeys", () => {
  it.effect("decrypts with the sibling channel key that wrote the value", () =>
    Effect.gen(function* () {
      const reads: string[] = [];
      const ciphertext = osCryptEncrypt("catalog", "nightly-secret", "v10", 1003);
      const siblingKeys = DesktopSafeStorageSiblingKeys.makeWith(
        () =>
          storeWith(
            {
              "GOAT Alpha": "stable-secret",
              "GOAT Nightly": "nightly-secret",
            },
            reads,
          ),
        "darwin",
        "GOAT Alpha",
      );

      const result = yield* siblingKeys.decrypt(ciphertext, acceptAll);
      assert.deepStrictEqual(
        result,
        Option.some({ plaintext: "catalog", runtimeName: "GOAT Nightly" }),
      );
      // Its own key already failed through safeStorage, so it is never read again.
      assert.notInclude(reads, "GOAT Alpha");
    }),
  );

  it.effect("keeps trying after a refused key read and a key that does not fit", () =>
    Effect.gen(function* () {
      const reads: string[] = [];
      const ciphertext = osCryptEncrypt("catalog", "legacy-nightly-secret", "v10", 1003);
      const siblingKeys = DesktopSafeStorageSiblingKeys.makeWith(
        () =>
          storeWith(
            {
              "GOAT Nightly": new Error("User canceled the operation."),
              "GOAT Dev": "wrong-secret",
              "T3 Code Nightly": "legacy-nightly-secret",
            },
            reads,
          ),
        "darwin",
        "GOAT Alpha",
      );

      const result = yield* siblingKeys.decrypt(ciphertext, acceptAll);
      assert.deepStrictEqual(
        result,
        Option.some({ plaintext: "catalog", runtimeName: "T3 Code Nightly" }),
      );
      assert.includeMembers(reads, ["GOAT Nightly", "GOAT Dev", "T3 Code Nightly"]);
    }),
  );

  it.effect("returns none when no key yields an accepted plaintext", () =>
    Effect.gen(function* () {
      const ciphertext = osCryptEncrypt("not a catalog", "nightly-secret", "v10", 1003);
      const siblingKeys = DesktopSafeStorageSiblingKeys.makeWith(
        () => storeWith({ "GOAT Nightly": "nightly-secret" }),
        "darwin",
        "GOAT Alpha",
      );

      const result = yield* siblingKeys.decrypt(ciphertext, (plaintext) => plaintext === "catalog");
      assert.deepStrictEqual(result, Option.none());
    }),
  );

  it.effect("uses the Linux keyring scheme and treats an unavailable key store as no match", () =>
    Effect.gen(function* () {
      const ciphertext = osCryptEncrypt("catalog", "keyring-secret", "v11", 1);
      const linux = DesktopSafeStorageSiblingKeys.makeWith(
        () => storeWith({ "GOAT Nightly": "keyring-secret" }),
        "linux",
        "GOAT Alpha",
      );
      assert.deepStrictEqual(
        yield* linux.decrypt(ciphertext, acceptAll),
        Option.some({ plaintext: "catalog", runtimeName: "GOAT Nightly" }),
      );

      const noKeyring = DesktopSafeStorageSiblingKeys.makeWith(
        () => Promise.reject(new Error("Secret Service timed out.")),
        "linux",
        "GOAT Alpha",
      );
      assert.deepStrictEqual(yield* noKeyring.decrypt(ciphertext, acceptAll), Option.none());
    }),
  );
});
