import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@goat/client-runtime/connection";
import {
  ConnectionCatalogDocument as RuntimeConnectionCatalogDocument,
  type ConnectionCatalogDocument as RuntimeConnectionCatalogDocumentType,
} from "@goat/client-runtime/platform";
import type {
  DesktopConnectionCatalogUnreadable,
  PersistedSavedEnvironmentRecord,
} from "@goat/contracts";
import { fromLenientJson } from "@goat/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopSafeStorageSiblingKeys from "./DesktopSafeStorageSiblingKeys.ts";

const EncryptedConnectionCatalogDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedCatalog: Schema.String,
});
type EncryptedConnectionCatalogDocument = typeof EncryptedConnectionCatalogDocument.Type;

const EncryptedConnectionCatalogDocumentJson = fromLenientJson(EncryptedConnectionCatalogDocument);
const decodeEncryptedConnectionCatalogDocumentJson = Schema.decodeEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const encodeEncryptedConnectionCatalogDocumentJson = Schema.encodeEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const RuntimeConnectionCatalogDocumentJson = Schema.fromJsonString(
  RuntimeConnectionCatalogDocument,
);
const encodeRuntimeConnectionCatalogDocumentJson = Schema.encodeEffect(
  RuntimeConnectionCatalogDocumentJson,
);
const decodeRuntimeConnectionCatalogDocumentJsonOption = Schema.decodeUnknownOption(
  RuntimeConnectionCatalogDocumentJson,
);
/** A wrong key can decrypt to valid padding; only a real catalog counts as recovered. */
const isConnectionCatalog = (plaintext: string) =>
  Option.isSome(decodeRuntimeConnectionCatalogDocumentJsonOption(plaintext));

const DesktopConnectionCatalogStoreWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-catalog-file",
  "back-up-catalog",
]);

const DesktopConnectionCatalogStoreMigrationOperation = Schema.Literals([
  "read-legacy-registry",
  "read-legacy-secret",
  "encode-catalog",
  "persist-catalog",
]);

const DesktopConnectionCatalogStoreProtectionOperation = Schema.Literals([
  "check-encryption-availability",
  "encrypt-catalog",
  "decrypt-catalog",
]);

export class DesktopConnectionCatalogStoreWriteError extends Schema.TaggedError<DesktopConnectionCatalogStoreWriteError>()(
  "DesktopConnectionCatalogStoreWriteError",
  {
    operation: DesktopConnectionCatalogStoreWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopConnectionCatalogStoreDecodeError extends Schema.TaggedError<DesktopConnectionCatalogStoreDecodeError>()(
  "DesktopConnectionCatalogStoreDecodeError",
  {
    resource: Schema.Literal("encryptedCatalog"),
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource} for the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreReadError extends Schema.TaggedError<DesktopConnectionCatalogStoreReadError>()(
  "DesktopConnectionCatalogStoreReadError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreDocumentDecodeError extends Schema.TaggedError<DesktopConnectionCatalogStoreDocumentDecodeError>()(
  "DesktopConnectionCatalogStoreDocumentDecodeError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode the desktop connection catalog document at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreMigrationError extends Schema.TaggedError<DesktopConnectionCatalogStoreMigrationError>()(
  "DesktopConnectionCatalogStoreMigrationError",
  {
    operation: DesktopConnectionCatalogStoreMigrationOperation,
    catalogPath: Schema.String,
    environmentId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const environment =
      this.environmentId === undefined ? "" : ` for environment ${this.environmentId}`;
    return `Legacy desktop saved-environment migration failed during ${this.operation}${environment} into ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreProtectionError extends Schema.TaggedError<DesktopConnectionCatalogStoreProtectionError>()(
  "DesktopConnectionCatalogStoreProtectionError",
  {
    operation: DesktopConnectionCatalogStoreProtectionOperation,
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog protection failed during ${this.operation} at ${this.catalogPath}.`;
  }
}

/**
 * The saved connection catalog, encrypted with this app's safeStorage key in the shared GOAT home.
 * Another channel (GOAT, GOAT (Nightly), a dev build) may have written it under its own key. Then
 * `get` decrypts it with that channel's key, keeps a copy of the original, and re-encrypts it
 * under this app's key. When no key opens it, `get` fails, the file stays in place with a copy
 * beside it, and `unreadable` describes it for the UI until `clear` removes it.
 */
export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  {
    readonly get: Effect.Effect<
      Option.Option<string>,
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreDecodeError
      | DesktopConnectionCatalogStoreMigrationError
      | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly set: (
      catalog: string,
    ) => Effect.Effect<
      boolean,
      DesktopConnectionCatalogStoreWriteError | DesktopConnectionCatalogStoreProtectionError
    >;
    /** Reads the catalog first, so it is current without an earlier `get`. */
    readonly unreadable: Effect.Effect<Option.Option<DesktopConnectionCatalogUnreadable>>;
    /** Refuses to remove an unreadable catalog that has no backup copy. */
    readonly clear: Effect.Effect<void, DesktopConnectionCatalogStoreWriteError>;
  }
>()("@goat/desktop/app/DesktopConnectionCatalogStore") {}

function decodeSecretBytes(
  catalogPath: string,
  encoded: string,
): Effect.Effect<Uint8Array, DesktopConnectionCatalogStoreDecodeError> {
  return Effect.fromResult(Base64.decode(encoded)).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreDecodeError({
          resource: "encryptedCatalog",
          catalogPath,
          cause,
        }),
    ),
  );
}

const readCatalogFile = (
  fileSystem: FileSystem.FileSystem,
  catalogPath: string,
): Effect.Effect<Option.Option<string>, DesktopConnectionCatalogStoreReadError> =>
  fileSystem.readFileString(catalogPath).pipe(
    Effect.asSome,
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeedNone
        : Effect.fail(
            new DesktopConnectionCatalogStoreReadError({
              catalogPath,
              cause: error,
            }),
          ),
    ),
  );

const decodeDocument = (catalogPath: string, raw: string) =>
  decodeEncryptedConnectionCatalogDocumentJson(raw).pipe(
    Effect.mapError(
      (cause) => new DesktopConnectionCatalogStoreDocumentDecodeError({ catalogPath, cause }),
    ),
  );

/** `GOAT Nightly` becomes `goat-nightly`, for backup file names. */
const fileNameSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const writeDocument = Effect.fn("desktop.connectionCatalogStore.writeDocument")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly catalogPath: string;
  readonly document: EncryptedConnectionCatalogDocument;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopConnectionCatalogStoreWriteError> {
  const encoded = yield* encodeEncryptedConnectionCatalogDocumentJson(input.document).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "encode-document",
          path: input.catalogPath,
          cause,
        }),
    ),
  );
  yield* writeFileAtomically({
    fileSystem: input.fileSystem,
    path: input.path,
    filePath: input.catalogPath,
    contents: `${encoded}\n`,
    suffix: input.suffix,
  });
});

const writeFileAtomically = Effect.fn("desktop.connectionCatalogStore.writeFileAtomically")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly filePath: string;
    readonly contents: string;
    readonly suffix: string;
  }): Effect.fn.Return<void, DesktopConnectionCatalogStoreWriteError> {
    const directory = input.path.dirname(input.filePath);
    const tempPath = `${input.filePath}.${process.pid}.${input.suffix}.tmp`;
    yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "create-directory",
            path: directory,
            cause,
          }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* input.fileSystem.writeFileString(tempPath, input.contents).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreWriteError({
              operation: "write-temporary-file",
              path: tempPath,
              cause,
            }),
        ),
      );
      yield* input.fileSystem.rename(tempPath, input.filePath).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreWriteError({
              operation: "replace-catalog-file",
              path: input.filePath,
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.ensuring(
        input.fileSystem.remove(tempPath, { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not remove a temporary connection catalog file.", {
              tempPath,
              error,
            }),
          ),
        ),
      ),
    );
  },
);

function connectionId(prefix: "bearer" | "ssh", environmentId: string): string {
  return `${prefix}:${environmentId}`;
}

const migrateSavedEnvironmentRecords = Effect.fn(
  "desktop.connectionCatalogStore.migrateSavedEnvironmentRecords",
)(function* (
  records: readonly PersistedSavedEnvironmentRecord[],
  savedEnvironments: DesktopSavedEnvironments.DesktopSavedEnvironments["Service"],
  catalogPath: string,
): Effect.fn.Return<
  RuntimeConnectionCatalogDocumentType,
  DesktopConnectionCatalogStoreMigrationError
> {
  const targets: Array<RuntimeConnectionCatalogDocumentType["targets"][number]> = [];
  const profiles: Array<RuntimeConnectionCatalogDocumentType["profiles"][number]> = [];
  const credentials: Array<RuntimeConnectionCatalogDocumentType["credentials"][number]> = [];

  for (const record of records) {
    if (record.relayManaged !== undefined) {
      targets.push(
        new RelayConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
        }),
      );
      continue;
    }

    if (record.desktopSsh !== undefined) {
      const id = connectionId("ssh", record.environmentId);
      targets.push(
        new SshConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
          connectionId: id,
        }),
      );
      profiles.push(
        new SshConnectionProfile({
          connectionId: id,
          environmentId: record.environmentId,
          label: record.label,
          target: record.desktopSsh,
        }),
      );
      continue;
    }

    const id = connectionId("bearer", record.environmentId);
    targets.push(
      new BearerConnectionTarget({
        environmentId: record.environmentId,
        label: record.label,
        connectionId: id,
      }),
    );
    profiles.push(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
      }),
    );
    const token = yield* savedEnvironments.getSecret(record.environmentId).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-secret",
            catalogPath,
            environmentId: record.environmentId,
            cause,
          }),
      ),
    );
    if (Option.isSome(token)) {
      credentials.push({
        connectionId: id,
        credential: new BearerConnectionCredential({ token: token.value }),
      });
    }
  }

  return {
    schemaVersion: 1,
    targets,
    profiles,
    credentials,
    remoteDpopTokens: [],
    disabledEnvironmentIds: [],
  };
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
  const siblingKeys = yield* DesktopSafeStorageSiblingKeys.DesktopSafeStorageSiblingKeys;
  const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
  /** Set while the file on disk opens with no key; `contentHash` stops repeat key prompts. */
  const unreadableState = yield* Ref.make(
    Option.none<DesktopConnectionCatalogUnreadable & { readonly contentHash: string }>(),
  );
  // One operation at a time: concurrent reads would each run recovery and prompt for keys.
  const lock = yield* Semaphore.make(1);
  const encryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreProtectionError({
          operation: "check-encryption-availability",
          catalogPath,
          cause,
        }),
    ),
  );

  const temporarySuffix = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => uuid.replace(/-/g, "")),
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "create-temporary-file-name",
          path: catalogPath,
          cause,
        }),
    ),
  );

  const writeCatalog = Effect.fn("desktop.connectionCatalogStore.writeCatalog")(function* (
    catalog: string,
  ) {
    const encryptedCatalog = Base64.encode(
      yield* safeStorage.encryptString(catalog).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreProtectionError({
              operation: "encrypt-catalog",
              catalogPath,
              cause,
            }),
        ),
      ),
    );
    yield* writeDocument({
      fileSystem,
      path,
      catalogPath,
      document: { version: 1, encryptedCatalog },
      suffix: yield* temporarySuffix,
    });
  });

  const backupError = (backupPath: string) => (cause: unknown) =>
    new DesktopConnectionCatalogStoreWriteError({
      operation: "back-up-catalog",
      path: backupPath,
      cause,
    });

  const contentHash = (raw: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(raw)).pipe(
      Effect.map((digest) => Hex.encode(digest).slice(0, 16)),
      Effect.mapError(backupError(catalogPath)),
    );

  /**
   * Copies the file a sibling channel wrote before it is re-encrypted. One copy per source channel;
   * a later recovery from the same channel replaces it, since the catalog it held was recovered.
   */
  const backUpRecoveredCatalog = Effect.fn("desktop.connectionCatalogStore.backUpRecovered")(
    function* (raw: string, runtimeName: string) {
      const backupPath = path.join(
        path.dirname(catalogPath),
        `connection-catalog.${fileNameSlug(runtimeName)}.backup.json`,
      );
      yield* writeFileAtomically({
        fileSystem,
        path,
        filePath: backupPath,
        contents: raw,
        suffix: yield* temporarySuffix,
      });
      return backupPath;
    },
  );

  /** Copies an unreadable file under a name derived from its contents, never replacing a copy. */
  const backUpUnreadableCatalog = Effect.fn("desktop.connectionCatalogStore.backUpUnreadable")(
    function* (raw: string, hash: string) {
      const backupPath = path.join(
        path.dirname(catalogPath),
        `connection-catalog.unreadable-${hash}.backup.json`,
      );
      const copied = yield* fileSystem.writeFileString(backupPath, raw, { flag: "wx" }).pipe(
        Effect.as(true),
        // An earlier launch copied this same file; anything else at that path is not our copy.
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () =>
            fileSystem.readFileString(backupPath).pipe(Effect.map((existing) => existing === raw)),
        ),
        Effect.mapError(backupError(backupPath)),
      );
      if (!copied) {
        return yield* backupError(backupPath)("A different file already has the backup name.");
      }
      return backupPath;
    },
  );

  const recoverCatalog = Effect.fn("desktop.connectionCatalogStore.recover")(function* (
    raw: string,
    encryptedCatalog: Uint8Array,
    decryptError: ElectronSafeStorage.ElectronSafeStorageDecryptError,
  ) {
    const hash = yield* contentHash(raw).pipe(Effect.option);
    const known = yield* Ref.get(unreadableState);
    const decryptFailure = new DesktopConnectionCatalogStoreProtectionError({
      operation: "decrypt-catalog",
      catalogPath,
      cause: decryptError,
    });
    // The same file already failed every key this launch; asking again would re-prompt.
    if (Option.isSome(known) && Option.isSome(hash) && known.value.contentHash === hash.value) {
      return yield* decryptFailure;
    }

    const recovered = yield* siblingKeys.decrypt(encryptedCatalog, isConnectionCatalog);
    if (Option.isSome(recovered)) {
      const { plaintext, runtimeName } = recovered.value;
      yield* Ref.set(unreadableState, Option.none());
      // Re-encrypt only once the original is safe on disk; until then the sibling key still works.
      const backupPath = yield* backUpRecoveredCatalog(raw, runtimeName).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Kept the connection catalog under its original key", { error }),
        ),
        Effect.option,
      );
      if (Option.isSome(backupPath)) {
        yield* writeCatalog(plaintext).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not re-encrypt the recovered connection catalog", { error }),
          ),
        );
      }
      yield* Effect.logInfo("Recovered the connection catalog with a sibling channel's key", {
        catalogPath,
        from: runtimeName,
        backupPath: Option.getOrNull(backupPath),
      });
      return plaintext;
    }

    const backupPath = Option.isNone(hash)
      ? Option.none<string>()
      : yield* backUpUnreadableCatalog(raw, hash.value).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not copy the unreadable connection catalog", { error }),
          ),
          Effect.option,
        );
    yield* Ref.set(
      unreadableState,
      Option.some({
        catalogPath,
        backupPath: Option.getOrNull(backupPath),
        contentHash: Option.getOrElse(hash, () => ""),
      }),
    );
    yield* Effect.logWarning("No safeStorage key opens the connection catalog", {
      catalogPath,
      backupPath: Option.getOrNull(backupPath),
    });
    return yield* decryptFailure;
  });

  const migrateLegacyCatalog = Effect.gen(function* () {
    if (!(yield* encryptionAvailable)) {
      return Option.none<string>();
    }
    const records = yield* savedEnvironments.getRegistry.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-registry",
            catalogPath,
            cause,
          }),
      ),
    );
    if (records.length === 0) {
      return Option.none<string>();
    }
    const catalog = yield* migrateSavedEnvironmentRecords(records, savedEnvironments, catalogPath);
    const encoded = yield* encodeRuntimeConnectionCatalogDocumentJson(catalog).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "encode-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    yield* writeCatalog(encoded).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "persist-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    return Option.some(encoded);
  });

  const getUnlocked = Effect.gen(function* () {
    const raw = yield* readCatalogFile(fileSystem, catalogPath);
    if (Option.isNone(raw)) {
      yield* Ref.set(unreadableState, Option.none());
      return yield* migrateLegacyCatalog;
    }
    const document = yield* decodeDocument(catalogPath, raw.value);
    if (!(yield* encryptionAvailable)) {
      return Option.none<string>();
    }
    const encryptedCatalog = yield* decodeSecretBytes(catalogPath, document.encryptedCatalog);
    const decrypted = yield* safeStorage.decryptString(encryptedCatalog).pipe(
      Effect.tap(() => Ref.set(unreadableState, Option.none())),
      Effect.catch((error) => recoverCatalog(raw.value, encryptedCatalog, error)),
    );
    return Option.some(decrypted);
  });
  const get = lock
    .withPermits(1)(getUnlocked)
    .pipe(Effect.withSpan("desktop.connectionCatalogStore.get"));

  /** An unreadable catalog may only be replaced once a copy of it exists. */
  const requireUnreadableBackup = Effect.gen(function* () {
    const unreadable = yield* Ref.get(unreadableState);
    if (Option.isSome(unreadable) && unreadable.value.backupPath === null) {
      return yield* new DesktopConnectionCatalogStoreWriteError({
        operation: "back-up-catalog",
        path: catalogPath,
        cause: new Error("The unreadable connection catalog has no backup copy."),
      });
    }
  });

  return DesktopConnectionCatalogStore.of({
    get,
    set: Effect.fn("desktop.connectionCatalogStore.set")(function* (catalog) {
      if (!(yield* encryptionAvailable)) {
        return false;
      }
      yield* requireUnreadableBackup;
      yield* writeCatalog(catalog);
      yield* Ref.set(unreadableState, Option.none());
      return true;
    }, lock.withPermits(1)),
    unreadable: get.pipe(
      Effect.ignore,
      Effect.andThen(Ref.get(unreadableState)),
      Effect.map(Option.map(({ catalogPath, backupPath }) => ({ catalogPath, backupPath }))),
      Effect.withSpan("desktop.connectionCatalogStore.unreadable"),
    ),
    clear: Effect.gen(function* () {
      yield* requireUnreadableBackup;
      yield* fileSystem.remove(catalogPath, { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not clear the desktop connection catalog.", {
            catalogPath,
            error,
          }),
        ),
      );
      yield* Ref.set(unreadableState, Option.none());
    }).pipe(lock.withPermits(1), Effect.withSpan("desktop.connectionCatalogStore.clear")),
  });
});

export const layer = Layer.effect(DesktopConnectionCatalogStore, make);
