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
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
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
  "lock-catalog",
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

const isWriteError = Schema.is(DesktopConnectionCatalogStoreWriteError);
const isDocumentDecodeError = Schema.is(DesktopConnectionCatalogStoreDocumentDecodeError);
const isDecodeError = Schema.is(DesktopConnectionCatalogStoreDecodeError);
const isProtectionError = Schema.is(DesktopConnectionCatalogStoreProtectionError);

/**
 * The saved connection catalog, encrypted with this app's safeStorage key in the shared GOAT home.
 * Another channel (GOAT, GOAT (Nightly), a dev build) may have written it under its own key. Then
 * `get` decrypts it with that channel's key, keeps a copy of the original, and re-encrypts it
 * under this app's key. When no key opens it as a valid catalog, `get` fails, the file stays in
 * place with a copy beside it, and `unreadable` describes it for the UI. `set` and `clear` copy
 * any file this app cannot open before replacing it, and refuse when no copy can be made.
 */
export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  {
    readonly get: Effect.Effect<
      Option.Option<string>,
      | DesktopConnectionCatalogStoreWriteError
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreDecodeError
      | DesktopConnectionCatalogStoreMigrationError
      | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly set: (
      catalog: string,
      expectedCatalog: string | null,
    ) => Effect.Effect<
      boolean | "conflict",
      DesktopConnectionCatalogStoreWriteError | DesktopConnectionCatalogStoreProtectionError
    >;
    /** Reads the catalog first, so it is current without an earlier `get`. */
    readonly unreadable: Effect.Effect<Option.Option<DesktopConnectionCatalogUnreadable>>;
    /** Refuses to remove a catalog this app cannot open unless a copy of it exists. */
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
): Effect.Effect<Option.Option<Uint8Array>, DesktopConnectionCatalogStoreReadError> =>
  // Bytes, so backups match the file exactly, including invalid UTF-8 and a BOM.
  fileSystem.readFile(catalogPath).pipe(
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

const decodeDocument = (catalogPath: string, raw: Uint8Array) =>
  decodeEncryptedConnectionCatalogDocumentJson(new TextDecoder().decode(raw)).pipe(
    Effect.mapError(
      (cause) => new DesktopConnectionCatalogStoreDocumentDecodeError({ catalogPath, cause }),
    ),
  );

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

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
    readonly contents: string | Uint8Array;
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
      yield* (
        typeof input.contents === "string"
          ? input.fileSystem.writeFileString(tempPath, input.contents)
          : input.fileSystem.writeFile(tempPath, input.contents)
      ).pipe(
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

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
  const siblingKeys = yield* DesktopSafeStorageSiblingKeys.DesktopSafeStorageSiblingKeys;
  const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
  /** Set while the file on disk cannot be served; `contentHash` stops repeat key prompts. */
  const unreadableState = yield* Ref.make(
    Option.none<
      DesktopConnectionCatalogUnreadable & {
        readonly contentHash: string;
        readonly error:
          | DesktopConnectionCatalogStoreDocumentDecodeError
          | DesktopConnectionCatalogStoreDecodeError
          | DesktopConnectionCatalogStoreProtectionError;
      }
    >(),
  );
  /**
   * A catalog a sibling key opened but that is still under that key, because the backup or the
   * re-encryption failed. Serving it again by `contentHash` stops repeat key prompts.
   */
  const recoveredState = yield* Ref.make(
    Option.none<{ readonly contentHash: string; readonly plaintext: string }>(),
  );
  // One operation at a time: concurrent reads would each run recovery and prompt for keys.
  const lock = yield* Semaphore.make(1);
  const lockPath = path.join(environment.stateDir, "connection-catalog.lock");
  const reclaimPath = `${lockPath}.reclaim`;
  const staleLockThresholdMs = 60_000;
  // A keychain prompt can outlive the timeout. Never evict an owner that is still alive.
  const ownerAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !(error instanceof Error && "code" in error && error.code === "ESRCH");
    }
  };
  const acquireFileLock = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "create-directory",
            path: environment.stateDir,
            cause,
          }),
      ),
    );
    const token = `${process.pid}:${yield* crypto.randomUUIDv4()}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const acquired = yield* fileSystem
        .writeFileString(lockPath, token, { flag: "wx", mode: 0o600 })
        .pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            () => Effect.succeed(false),
          ),
        );
      if (acquired) return token;
      const info = yield* fileSystem.stat(lockPath).pipe(Effect.option);
      const owner = yield* fileSystem.readFileString(lockPath).pipe(Effect.option);
      const modified = Option.flatMap(info, (value) => value.mtime);
      if (
        Option.isSome(modified) &&
        (yield* Clock.currentTimeMillis) - modified.value.getTime() > staleLockThresholdMs
      ) {
        const pid = Option.isSome(owner) ? Number(owner.value.split(":")[0]) : NaN;
        if (!Number.isSafeInteger(pid) || pid <= 0 || !ownerAlive(pid)) {
          // Serialize stale removers too: two removers must not unlink a new owner's lock.
          // A crash can leave the short-lived guard behind; only expired guards are abandoned.
          const reclaimed = yield* Effect.scoped(
            Effect.acquireRelease(
              fileSystem.writeFileString(reclaimPath, token, { flag: "wx", mode: 0o600 }),
              () => fileSystem.remove(reclaimPath, { force: true }).pipe(Effect.ignore),
            ).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const current = yield* fileSystem.readFileString(lockPath).pipe(Effect.option);
                  if (
                    Option.isSome(owner) &&
                    Option.isSome(current) &&
                    current.value === owner.value
                  ) {
                    yield* fileSystem.remove(lockPath, { force: true });
                    return true;
                  }
                  return false;
                }),
              ),
              Effect.catchIf(
                (error) => error.reason._tag === "AlreadyExists",
                () =>
                  Effect.gen(function* () {
                    const guard = yield* fileSystem.stat(reclaimPath).pipe(Effect.option);
                    const guardModified = Option.flatMap(guard, (value) => value.mtime);
                    if (
                      Option.isSome(guardModified) &&
                      (yield* Clock.currentTimeMillis) - guardModified.value.getTime() >
                        staleLockThresholdMs
                    ) {
                      yield* fileSystem.remove(reclaimPath, { force: true });
                      return true;
                    }
                    return false;
                  }),
              ),
            ),
          );
          if (reclaimed) continue;
        }
      }
      yield* Effect.sleep("50 millis").pipe(Effect.interruptible);
    }
    return yield* new DesktopConnectionCatalogStoreWriteError({
      operation: "lock-catalog",
      path: lockPath,
      cause: "Another app is using the connection catalog.",
    });
  }).pipe(
    Effect.mapError((cause) =>
      isWriteError(cause)
        ? cause
        : new DesktopConnectionCatalogStoreWriteError({
            operation: "lock-catalog",
            path: lockPath,
            cause,
          }),
    ),
  );
  const withFileLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.acquireRelease(acquireFileLock, (token) =>
        fileSystem.readFileString(lockPath).pipe(
          Effect.flatMap((current) =>
            current === token ? fileSystem.remove(lockPath, { force: true }) : Effect.void,
          ),
          Effect.ignore,
        ),
      ).pipe(Effect.andThen(effect)),
    );
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

  const temporarySuffix = crypto.randomUUIDv4().pipe(
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

  const contentHash = (raw: Uint8Array) =>
    crypto.digest("SHA-256", raw).pipe(
      Effect.map((digest) => Hex.encode(digest).slice(0, 16)),
      Effect.mapError(backupError(catalogPath)),
    );

  /**
   * Copies the file a sibling channel wrote before it is re-encrypted. One copy per source channel;
   * a later recovery from the same channel replaces it, since the catalog it held was recovered.
   */
  const backUpRecoveredCatalog = Effect.fn("desktop.connectionCatalogStore.backUpRecovered")(
    function* (raw: Uint8Array, runtimeName: string) {
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
    function* (raw: Uint8Array, hash: string) {
      const backupPath = path.join(
        path.dirname(catalogPath),
        `connection-catalog.unreadable-${hash}.backup.json`,
      );
      const copied = yield* fileSystem.writeFile(backupPath, raw, { flag: "wx" }).pipe(
        Effect.as(true),
        // An earlier launch copied this same file; anything else at that path is not our copy.
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () =>
            fileSystem
              .readFile(backupPath)
              .pipe(Effect.map((existing) => sameBytes(existing, raw))),
        ),
        Effect.mapError(backupError(backupPath)),
      );
      if (!copied) {
        return yield* backupError(backupPath)("A different file already has the backup name.");
      }
      return backupPath;
    },
  );

  type CatalogFault = DesktopConnectionCatalogUnreadable["reason"];
  type GetError =
    | DesktopConnectionCatalogStoreDocumentDecodeError
    | DesktopConnectionCatalogStoreDecodeError
    | DesktopConnectionCatalogStoreProtectionError;

  /**
   * Records that the file on disk cannot be served and copies it first, so nothing that replaces
   * it later can lose it. Fails with `error` so callers can `return yield*` it.
   */
  const markUnreadable = Effect.fn("desktop.connectionCatalogStore.markUnreadable")(function* (
    raw: Uint8Array,
    reason: CatalogFault,
    error: GetError,
  ) {
    const hash = yield* contentHash(raw).pipe(Effect.option);
    const backupPath = Option.isNone(hash)
      ? Option.none<string>()
      : yield* backUpUnreadableCatalog(raw, hash.value).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Could not copy the unreadable connection catalog", { cause }),
          ),
          Effect.option,
        );
    yield* Ref.set(
      unreadableState,
      Option.some({
        catalogPath,
        backupPath: Option.getOrNull(backupPath),
        reason,
        contentHash: Option.getOrElse(hash, () => ""),
        error,
      }),
    );
    yield* Effect.logWarning("The connection catalog cannot be read", {
      catalogPath,
      reason,
      backupPath: Option.getOrNull(backupPath),
      error,
    });
    return yield* Effect.fail(error);
  });

  const recoverCatalog = Effect.fn("desktop.connectionCatalogStore.recover")(function* (
    raw: Uint8Array,
    encryptedCatalog: Uint8Array,
    /** What to report when no sibling key yields a catalog either. */
    noMatch: { readonly reason: CatalogFault; readonly error: GetError },
  ) {
    // No sibling key opened this same file earlier this launch; asking again would re-prompt.
    const known = yield* Ref.get(unreadableState);
    const hash = yield* contentHash(raw).pipe(Effect.option);
    if (Option.isSome(known) && Option.contains(hash, known.value.contentHash)) {
      return yield* Effect.fail(known.value.error);
    }
    // A sibling key already opened this same file earlier this launch.
    const remembered = yield* Ref.get(recoveredState);
    if (Option.isSome(remembered) && Option.contains(hash, remembered.value.contentHash)) {
      return Option.some(remembered.value.plaintext);
    }
    const recovered = yield* siblingKeys.decrypt(encryptedCatalog, isConnectionCatalog);
    if (Option.isNone(recovered)) {
      return yield* markUnreadable(raw, noMatch.reason, noMatch.error);
    }
    const { plaintext, runtimeName } = recovered.value;
    yield* Ref.set(unreadableState, Option.none());
    // Re-encrypt only once the original is safe on disk; until then the sibling key still works,
    // and `set` copies the file before replacing it.
    const backupPath = yield* backUpRecoveredCatalog(raw, runtimeName).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Kept the connection catalog under its original key", { error }),
      ),
      Effect.option,
    );
    // The other channel may be running and have saved while the key prompt was open. Its newer
    // catalog wins: none tells the caller to read the file again.
    const current = yield* readCatalogFile(fileSystem, catalogPath).pipe(Effect.option);
    if (
      !(
        Option.isSome(current) &&
        Option.isSome(current.value) &&
        sameBytes(current.value.value, raw)
      )
    ) {
      yield* Effect.logInfo("The connection catalog changed during recovery; reading it again");
      return Option.none<string>();
    }
    const reencrypted = Option.isSome(backupPath)
      ? yield* writeCatalog(plaintext).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Could not re-encrypt the recovered connection catalog", {
              error,
            }).pipe(Effect.as(false)),
          ),
        )
      : false;
    yield* Ref.set(
      recoveredState,
      !reencrypted && Option.isSome(hash)
        ? Option.some({ contentHash: hash.value, plaintext })
        : Option.none(),
    );
    yield* Effect.logInfo("Recovered the connection catalog with a sibling channel's key", {
      catalogPath,
      from: runtimeName,
      backupPath: Option.getOrNull(backupPath),
      reencrypted,
    });
    return Option.some(plaintext);
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

  /** Each attempt reads the file again; recovery asks for another when the file changed meanwhile. */
  const readAttempt = (
    attemptsLeft: number,
  ): Effect.Effect<
    Option.Option<string>,
    | DesktopConnectionCatalogStoreReadError
    | DesktopConnectionCatalogStoreMigrationError
    | DesktopConnectionCatalogStoreDocumentDecodeError
    | DesktopConnectionCatalogStoreDecodeError
    | DesktopConnectionCatalogStoreProtectionError
  > =>
    Effect.gen(function* () {
      const raw = yield* readCatalogFile(fileSystem, catalogPath);
      if (Option.isNone(raw)) {
        yield* Ref.set(unreadableState, Option.none());
        return yield* migrateLegacyCatalog;
      }
      const document = yield* decodeDocument(catalogPath, raw.value).pipe(
        Effect.catch((error) => markUnreadable(raw.value, "damaged", error)),
      );
      if (!(yield* encryptionAvailable)) {
        return Option.none<string>();
      }
      const encryptedCatalog = yield* decodeSecretBytes(
        catalogPath,
        document.encryptedCatalog,
      ).pipe(Effect.catch((error) => markUnreadable(raw.value, "damaged", error)));
      const ownKey = yield* safeStorage.decryptString(encryptedCatalog).pipe(Effect.result);
      // The renderer replaces a catalog it cannot parse, so only a valid one leaves this store.
      // A wrong key can still decrypt to valid padding, so a non-catalog also tries sibling keys.
      let decrypted: string;
      if (Result.isSuccess(ownKey) && isConnectionCatalog(ownKey.success)) {
        decrypted = ownKey.success;
      } else {
        const recovered = yield* recoverCatalog(
          raw.value,
          encryptedCatalog,
          Result.isSuccess(ownKey)
            ? {
                reason: "damaged",
                error: new DesktopConnectionCatalogStoreDocumentDecodeError({
                  catalogPath,
                  cause: new Error("The decrypted connection catalog is not a valid catalog."),
                }),
              }
            : {
                reason: "locked",
                error: new DesktopConnectionCatalogStoreProtectionError({
                  operation: "decrypt-catalog",
                  catalogPath,
                  cause: ownKey.failure,
                }),
              },
        );
        if (Option.isNone(recovered)) {
          if (attemptsLeft > 0) return yield* readAttempt(attemptsLeft - 1);
          return yield* new DesktopConnectionCatalogStoreProtectionError({
            operation: "decrypt-catalog",
            catalogPath,
            cause: new Error("The connection catalog kept changing during recovery."),
          });
        }
        decrypted = recovered.value;
      }
      yield* Ref.set(unreadableState, Option.none());
      return Option.some(decrypted);
    });
  const get = lock
    .withPermits(1)(withFileLock(readAttempt(2)))
    .pipe(Effect.withSpan("desktop.connectionCatalogStore.get"));

  /** True when this app's key opens the file as a valid catalog. */
  const opensWithOwnKey = (raw: Uint8Array) =>
    decodeDocument(catalogPath, raw).pipe(
      Effect.flatMap((document) => decodeSecretBytes(catalogPath, document.encryptedCatalog)),
      Effect.flatMap(safeStorage.decryptString),
      Effect.map(isConnectionCatalog),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Checks the file on disk right before it is replaced or removed: one this app cannot open is
   * copied first, and when no copy can be made the change is refused.
   */
  const preserveBeforeReplace = Effect.gen(function* () {
    const raw = yield* readCatalogFile(fileSystem, catalogPath).pipe(
      Effect.mapError((error) => backupError(catalogPath)(error)),
    );
    if (Option.isNone(raw) || (yield* opensWithOwnKey(raw.value))) return;
    yield* backUpUnreadableCatalog(raw.value, yield* contentHash(raw.value));
  });

  return DesktopConnectionCatalogStore.of({
    get,
    set: Effect.fn("desktop.connectionCatalogStore.set")(
      function* (catalog, expectedCatalog) {
        if (!(yield* encryptionAvailable)) {
          return false;
        }
        yield* preserveBeforeReplace;
        const current = yield* readAttempt(2).pipe(
          Effect.catchIf(
            (error) =>
              isDocumentDecodeError(error) || isDecodeError(error) || isProtectionError(error),
            () => Effect.succeedNone,
          ),
          Effect.mapError((cause) => backupError(catalogPath)(cause)),
        );
        if (Option.getOrNull(current) !== expectedCatalog) return "conflict" as const;
        yield* writeCatalog(catalog);
        yield* Ref.set(unreadableState, Option.none());
        return true;
      },
      withFileLock,
      lock.withPermits(1),
    ),
    unreadable: get.pipe(
      Effect.ignore,
      Effect.andThen(Ref.get(unreadableState)),
      Effect.map(
        Option.map(({ catalogPath, backupPath, reason }) => ({ catalogPath, backupPath, reason })),
      ),
      Effect.withSpan("desktop.connectionCatalogStore.unreadable"),
    ),
    clear: Effect.gen(function* () {
      yield* preserveBeforeReplace;
      yield* fileSystem.remove(catalogPath, { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not clear the desktop connection catalog.", {
            catalogPath,
            error,
          }),
        ),
      );
      yield* Ref.set(unreadableState, Option.none());
    }).pipe(
      withFileLock,
      lock.withPermits(1),
      Effect.withSpan("desktop.connectionCatalogStore.clear"),
    ),
  });
});

export const layer = Layer.effect(DesktopConnectionCatalogStore, make);
