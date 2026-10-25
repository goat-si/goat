import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { bypassesOsKeyStore } from "./DesktopDevSecretStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * Electron keeps one random safeStorage key per runtime name: the macOS Keychain item and the
 * Linux Secret Service entry are named after `app.name` as it stands before the event loop starts.
 * Builds before D13 set their name too late for that, so their key sits under the initial package
 * name (`productName`, for example "GOAT" or "T3 Code (Alpha)"); `T3 Code <stage>` is checked too.
 * Now that `main.ts` sets `GOAT <stage>` in time, Electron would otherwise create a fresh key and
 * lose every secret encrypted under the old one: saved connections, the connection catalog, Clerk
 * tokens. Before Electron first uses the key, this copies the old key to the new name, so all
 * existing ciphertext decrypts unchanged and no file is rewritten. The old entry stays, so a
 * rolled-back build still finds its key, and both builds read everything either one writes.
 *
 * Windows needs nothing: its key lives in the profile's `Local State`, protected by DPAPI for the
 * user, and the profile directory does not depend on the runtime name.
 */
export class DesktopSafeStorageKeyMigration extends Context.Service<
  DesktopSafeStorageKeyMigration,
  {
    /** Must run before anything uses safeStorage. Never fails; a failure retries next launch. */
    readonly run: (input: {
      readonly userDataPath: string;
      /** Checked after the process's initial `app.name`. */
      readonly legacyRuntimeName: string;
      readonly runtimeName: string;
    }) => Effect.Effect<void>;
  }
>()("@goat/desktop/app/DesktopSafeStorageKeyMigration") {}

export const MARKER_FILE_NAME = "safe-storage-key-migrated";

/** Where one platform keeps safeStorage keys, by Electron runtime name. */
export interface SafeStorageKeyStore {
  /** The key, or null when the runtime name has none. Rejects when the store cannot answer. */
  readonly read: (runtimeName: string) => Promise<string | null>;
  readonly write: (runtimeName: string, key: string) => Promise<void>;
}

export class SafeStorageKeyMigrationError extends Schema.TaggedError<SafeStorageKeyMigrationError>()(
  "SafeStorageKeyMigrationError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not copy the safeStorage key to the GOAT runtime name.";
  }
}

/**
 * Copies the first legacy name's key unless the new name already has one. A different key under
 * the new name is a `conflict`: ciphertext may exist under both, so neither is replaced.
 */
export const copySafeStorageKey = async (
  store: SafeStorageKeyStore,
  legacyRuntimeNames: readonly string[],
  runtimeName: string,
): Promise<"present" | "copied" | "no-legacy-key" | "conflict"> => {
  const current = await store.read(runtimeName);
  let legacy: string | null = null;
  for (const name of new Set(legacyRuntimeNames)) {
    if (name === runtimeName) continue;
    legacy = await store.read(name);
    if (legacy !== null) break;
  }
  if (current !== null) return legacy === null || legacy === current ? "present" : "conflict";
  if (legacy === null) return "no-legacy-key";
  await store.write(runtimeName, legacy);
  return "copied";
};

/**
 * Electron's Keychain item: service `<name> Safe Storage`, account `<name> Key` (Chromium's own
 * builds use `<name>`; Electron appends " Key"). Read in process, so macOS checks the same app
 * identity it checks for Electron's own access.
 */
export const macKeychainItem = (name: string) => ({
  service: `${name} Safe Storage`,
  account: `${name} Key`,
});

const macKeychainStore = async (): Promise<SafeStorageKeyStore> => {
  const { Entry } = await import("@napi-rs/keyring");
  const entry = (name: string) => {
    const item = macKeychainItem(name);
    return new Entry(item.service, item.account);
  };
  return {
    read: async (name) => {
      try {
        const key = entry(name).getPassword();
        return key === null || key === "" ? null : key;
      } catch (cause) {
        if (/no (matching )?entry|not found/i.test(String((cause as Error | undefined)?.message))) {
          return null;
        }
        throw cause;
      }
    },
    write: async (name, key) => entry(name).setPassword(key),
  };
};

const SECRET_SERVICE = "org.freedesktop.secrets";
/** Chromium's libsecret schema; it matches on `application`, which Electron sets to `app.name`. */
const CHROMIUM_LIBSECRET_SCHEMA = "chrome_libsecret_os_crypt_password_v2";
const DBUS_CALL_TIMEOUT_MS = 5_000;

interface SecretServiceInterface {
  OpenSession(algorithm: string, input: unknown): Promise<[unknown, string]>;
  SearchItems(attributes: Record<string, string>): Promise<[string[], string[]]>;
  GetSecrets(
    items: string[],
    session: string,
  ): Promise<Record<string, [string, Buffer, Buffer, string]>>;
}
interface SecretCollectionInterface {
  CreateItem(
    properties: Record<string, unknown>,
    secret: [string, Buffer, Buffer, string],
    replace: boolean,
  ): Promise<[string, string]>;
}

/**
 * The Secret Service (GNOME Keyring, KeePassXC, ...) over D-Bus. Chromium's KWallet backend and
 * the keyring-free `basic` store are not covered: `basic` uses a fixed key, and KWallet keeps its
 * own folder. Locked items count as a failure, so the copy retries once the keyring is unlocked.
 */
const linuxSecretServiceStore = async (): Promise<SafeStorageKeyStore & { close(): void }> => {
  const dbus = await import("dbus-next");
  const bus = dbus.sessionBus();
  // A connection failure arrives as an `error` event, never as a rejection; unhandled, it would
  // crash the main process. Every call races it and a timeout.
  let failBus: (cause: unknown) => void = () => {};
  const busFailed = new Promise<never>((_, reject) => {
    failBus = reject;
  });
  busFailed.catch(() => {});
  bus.on("error", (cause: unknown) => failBus(cause));
  const call = <A>(pending: Promise<A>): Promise<A> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      // @effect-diagnostics-next-line globalTimers:off - Plain promise code around dbus-next.
      timer = setTimeout(
        () => reject(new Error("Secret Service timed out.")),
        DBUS_CALL_TIMEOUT_MS,
      );
    });
    return Promise.race([pending, busFailed, timeout]).finally(() => clearTimeout(timer));
  };
  try {
    const serviceObject = await call(
      bus.getProxyObject(SECRET_SERVICE, "/org/freedesktop/secrets"),
    );
    const service = serviceObject.getInterface(
      "org.freedesktop.Secret.Service",
    ) as unknown as SecretServiceInterface;
    const [, session] = await call(service.OpenSession("plain", new dbus.Variant("s", "")));
    const attributes = (name: string) => ({
      "xdg:schema": CHROMIUM_LIBSECRET_SCHEMA,
      application: name,
    });
    return {
      read: async (name) => {
        const [unlocked, locked] = await call(service.SearchItems(attributes(name)));
        if (unlocked.length === 0) {
          if (locked.length > 0) throw new Error("The keyring item is locked.");
          return null;
        }
        const secrets = await call(service.GetSecrets(unlocked, session));
        const secret = secrets[unlocked[0]!];
        return secret === undefined ? null : secret[2].toString("utf8");
      },
      write: async (name, key) => {
        const collectionObject = await call(
          bus.getProxyObject(SECRET_SERVICE, "/org/freedesktop/secrets/aliases/default"),
        );
        const collection = collectionObject.getInterface(
          "org.freedesktop.Secret.Collection",
        ) as unknown as SecretCollectionInterface;
        const [, prompt] = await call(
          collection.CreateItem(
            {
              "org.freedesktop.Secret.Item.Label": new dbus.Variant("s", `${name} Safe Storage`),
              "org.freedesktop.Secret.Item.Attributes": new dbus.Variant("a{ss}", attributes(name)),
            },
            [session, Buffer.alloc(0), Buffer.from(key, "utf8"), "text/plain"],
            false,
          ),
        );
        if (prompt !== "/") throw new Error("The default keyring is locked.");
      },
      close: () => bus.disconnect(),
    };
  } catch (cause) {
    bus.disconnect();
    throw cause;
  }
};

/** The key store for this platform, or null where the runtime name does not key safeStorage. */
export const platformSafeStorageKeyStore = async (
  platform: NodeJS.Platform,
): Promise<(SafeStorageKeyStore & { close?: () => void }) | null> => {
  if (platform === "darwin") return macKeychainStore();
  if (platform === "linux") return linuxSecretServiceStore();
  return null;
};

export const makeWith = (
  openStore: typeof platformSafeStorageKeyStore,
  platform: NodeJS.Platform,
  initialRuntimeName: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const run = Effect.fn("desktop.safeStorageKeyMigration.run")(
      function* (input: {
        readonly userDataPath: string;
        readonly legacyRuntimeName: string;
        readonly runtimeName: string;
      }) {
        const markerPath = path.join(input.userDataPath, MARKER_FILE_NAME);
        if (yield* fs.exists(markerPath).pipe(Effect.orElseSucceed(() => false))) return;
        const legacyRuntimeNames = [initialRuntimeName, input.legacyRuntimeName];
        const result = yield* Effect.tryPromise({
          try: async () => {
            const store = await openStore(platform);
            if (store === null) return "unkeyed" as const;
            try {
              return await copySafeStorageKey(store, legacyRuntimeNames, input.runtimeName);
            } finally {
              store.close?.();
            }
          },
          catch: (cause) => new SafeStorageKeyMigrationError({ cause }),
        });
        if (result === "unkeyed") return;
        const details = { result, from: legacyRuntimeNames, to: input.runtimeName };
        if (result === "conflict") {
          // An earlier launch ran without the copy (a locked keyring, say) and Electron created a
          // fresh key. Secrets written under the old key need re-entry; neither key is replaced.
          yield* Effect.logWarning("safeStorage keys differ between runtime names", details);
        } else {
          yield* Effect.logInfo("safeStorage key migration", details);
        }
        yield* fs.makeDirectory(input.userDataPath, { recursive: true });
        yield* fs.writeFileString(
          markerPath,
          `${legacyRuntimeNames.join(", ")} -> ${input.runtimeName}: ${result}\n`,
        );
      },
      Effect.catch((error) =>
        Effect.logWarning("Could not migrate the safeStorage key; will retry next launch", error),
      ),
    );

    return DesktopSafeStorageKeyMigration.of({ run });
  });

/** `initialRuntimeName` is `app.name` as `main.ts` found it, before setting the GOAT name. */
export const layer = (input: { readonly initialRuntimeName: string }) =>
  Layer.effect(
    DesktopSafeStorageKeyMigration,
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      return yield* makeWith(
        // Unkeyed when bypassed: nothing is read and no marker is written, so the copy still runs
        // on the first launch without the opt-in.
        (yield* bypassesOsKeyStore(environment)) ? async () => null : platformSafeStorageKeyStore,
        environment.platform,
        input.initialRuntimeName,
      );
    }),
  );
