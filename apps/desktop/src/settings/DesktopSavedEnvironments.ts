import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@goat/contracts";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import { fromLenientJson } from "@goat/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSafeStorageSiblingKeys from "../app/DesktopSafeStorageSiblingKeys.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

type PersistedSavedEnvironmentDesktopSsh = NonNullable<
  PersistedSavedEnvironmentRecord["desktopSsh"]
>;

interface PersistedSavedEnvironmentStorageRecord extends Omit<
  PersistedSavedEnvironmentRecord,
  "desktopSsh"
> {
  readonly desktopSsh?: PersistedSavedEnvironmentDesktopSsh;
  readonly encryptedBearerToken?: string;
}

interface SavedEnvironmentRegistryDocument {
  readonly version: number;
  readonly records: readonly PersistedSavedEnvironmentStorageRecord[];
}

interface SavedEnvironmentRegistryStorageDocument {
  readonly version?: number;
  readonly records?: readonly PersistedSavedEnvironmentStorageRecord[];
}

const DesktopSshTargetSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
});

const PersistedSavedEnvironmentStorageRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(DesktopSshTargetSchema),
  relayManaged: Schema.optionalKey(Schema.Struct({ relayUrl: Schema.String })),
  encryptedBearerToken: Schema.optionalKey(Schema.String),
});

const SavedEnvironmentRegistryDocumentSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  records: Schema.optionalKey(Schema.Array(PersistedSavedEnvironmentStorageRecordSchema)),
});

const SavedEnvironmentRegistryDocumentJson = fromLenientJson(
  SavedEnvironmentRegistryDocumentSchema,
);
const decodeSavedEnvironmentRegistryDocumentJson = Schema.decodeEffect(
  SavedEnvironmentRegistryDocumentJson,
);
const encodeSavedEnvironmentRegistryDocumentJson = Schema.encodeEffect(
  SavedEnvironmentRegistryDocumentJson,
);

// RFC 6750 b64token: CBC padding alone cannot establish that a sibling key recovered a token.
const isBearerToken = (plaintext: string) => /^[A-Za-z0-9\-._~+/]+=*$/.test(plaintext);

const DesktopSavedEnvironmentSecretProtectionOperation = Schema.Literals([
  "check-encryption-availability",
  "decrypt-secret",
]);

export class DesktopSavedEnvironmentsReadError extends Schema.TaggedError<DesktopSavedEnvironmentsReadError>()(
  "DesktopSavedEnvironmentsReadError",
  {
    registryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read desktop saved environments at ${this.registryPath}.`;
  }
}

export class DesktopSavedEnvironmentsDocumentDecodeError extends Schema.TaggedError<DesktopSavedEnvironmentsDocumentDecodeError>()(
  "DesktopSavedEnvironmentsDocumentDecodeError",
  {
    registryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode desktop saved environments at ${this.registryPath}.`;
  }
}

export class DesktopSavedEnvironmentSecretDecodeError extends Schema.TaggedError<DesktopSavedEnvironmentSecretDecodeError>()(
  "DesktopSavedEnvironmentSecretDecodeError",
  {
    environmentId: Schema.String,
    registryPath: Schema.String,
    field: Schema.Literal("encryptedBearerToken"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.field} for environment ${this.environmentId} at ${this.registryPath}.`;
  }
}

export class DesktopSavedEnvironmentSecretProtectionError extends Schema.TaggedError<DesktopSavedEnvironmentSecretProtectionError>()(
  "DesktopSavedEnvironmentSecretProtectionError",
  {
    operation: DesktopSavedEnvironmentSecretProtectionOperation,
    environmentId: Schema.String,
    registryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop saved-environment secret protection failed during ${this.operation} for environment ${this.environmentId} at ${this.registryPath}.`;
  }
}

export type DesktopSavedEnvironmentsReadRegistryError =
  | DesktopSavedEnvironmentsReadError
  | DesktopSavedEnvironmentsDocumentDecodeError;

export type DesktopSavedEnvironmentsGetSecretError =
  | DesktopSavedEnvironmentsReadRegistryError
  | DesktopSavedEnvironmentSecretDecodeError
  | DesktopSavedEnvironmentSecretProtectionError;

export class DesktopSavedEnvironments extends Context.Service<
  DesktopSavedEnvironments,
  {
    readonly getRegistry: Effect.Effect<
      readonly PersistedSavedEnvironmentRecord[],
      DesktopSavedEnvironmentsReadRegistryError
    >;

    readonly getSecret: (
      environmentId: string,
    ) => Effect.Effect<Option.Option<string>, DesktopSavedEnvironmentsGetSecretError>;
  }
>()("@goat/desktop/settings/DesktopSavedEnvironments") {}

function toPersistedSavedEnvironmentRecord(
  record: PersistedSavedEnvironmentStorageRecord,
): PersistedSavedEnvironmentRecord {
  const nextRecord = {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
  return {
    ...nextRecord,
    ...(record.desktopSsh ? { desktopSsh: record.desktopSsh } : {}),
    ...(record.relayManaged ? { relayManaged: record.relayManaged } : {}),
  };
}

function normalizeSavedEnvironmentRegistryDocument(
  document: SavedEnvironmentRegistryStorageDocument,
): SavedEnvironmentRegistryDocument {
  return {
    version: document.version ?? 1,
    records: document.records ?? [],
  };
}

function readRegistryDocument(
  fileSystem: FileSystem.FileSystem,
  registryPath: string,
): Effect.Effect<SavedEnvironmentRegistryDocument, DesktopSavedEnvironmentsReadRegistryError> {
  return fileSystem.readFileString(registryPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<string | null>(null)
        : Effect.fail(
            new DesktopSavedEnvironmentsReadError({
              registryPath,
              cause: error,
            }),
          ),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed({ version: 1, records: [] })
        : decodeSavedEnvironmentRegistryDocumentJson(raw).pipe(
            Effect.map(normalizeSavedEnvironmentRegistryDocument),
            Effect.mapError(
              (cause) =>
                new DesktopSavedEnvironmentsDocumentDecodeError({
                  registryPath,
                  cause,
                }),
            ),
          ),
    ),
  );
}

function decodeSecretBytes(
  environmentId: string,
  registryPath: string,
  encoded: string,
): Effect.Effect<Uint8Array, DesktopSavedEnvironmentSecretDecodeError> {
  return Effect.fromResult(Base64.decode(encoded)).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSavedEnvironmentSecretDecodeError({
          environmentId,
          registryPath,
          field: "encryptedBearerToken",
          cause,
        }),
    ),
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const siblingKeys = yield* DesktopSafeStorageSiblingKeys.DesktopSafeStorageSiblingKeys;
  const lock = yield* Semaphore.make(1);
  // If persistence fails, retain the recovered value so a read does not repeat Keychain prompts.
  const recoveredSecrets = new Map<
    string,
    { readonly plaintext: string; readonly runtimeName: string }
  >();

  const recoverSecret = Effect.fn("desktop.savedEnvironments.recoverSecret")(function* (
    environmentId: string,
    encoded: string,
    secretBytes: Uint8Array,
    originalError: ElectronSafeStorage.ElectronSafeStorageDecryptError,
  ) {
    const registryPath = environment.savedEnvironmentRegistryPath;
    const recover = Effect.gen(function* () {
      const raw = yield* fileSystem.readFileString(registryPath);
      const current = yield* decodeSavedEnvironmentRegistryDocumentJson(raw);
      if (
        !current.records?.some(
          (record) =>
            record.environmentId === environmentId && record.encryptedBearerToken === encoded,
        )
      ) {
        return yield* originalError;
      }
      const remembered = recoveredSecrets.get(encoded);
      const recovered =
        remembered === undefined
          ? yield* siblingKeys.decrypt(secretBytes, isBearerToken)
          : Option.some(remembered);
      if (Option.isNone(recovered)) return yield* originalError;
      const { plaintext, runtimeName } = recovered.value;
      recoveredSecrets.set(encoded, recovered.value);
      yield* Effect.gen(function* () {
        const encryptedBearerToken = Base64.encode(yield* safeStorage.encryptString(plaintext));
        const slug = runtimeName.replace(/[^A-Za-z0-9._-]/g, "-");
        yield* writeFileStringAtomically({
          filePath: `${registryPath}.${slug}.backup`,
          contents: raw,
        });
        // A key prompt can outlive another writer's save; never replace that newer document.
        if ((yield* fileSystem.readFileString(registryPath)) !== raw) return;
        const contents = yield* encodeSavedEnvironmentRegistryDocumentJson({
          ...current,
          records: (current.records ?? []).map((record) =>
            record.environmentId === environmentId ? { ...record, encryptedBearerToken } : record,
          ),
        });
        yield* writeFileStringAtomically({
          filePath: registryPath,
          contents: `${contents}\n`,
        });
        recoveredSecrets.delete(encoded);
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning(
            "Could not re-encrypt a recovered saved-environment token; kept its original file",
            {
              registryPath,
              environmentId,
            },
          ),
        ),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, environment.path),
      );
      return plaintext;
    });
    return yield* recover.pipe(Effect.mapError(() => originalError));
  });

  return DesktopSavedEnvironments.of({
    getRegistry: readRegistryDocument(fileSystem, environment.savedEnvironmentRegistryPath).pipe(
      Effect.map((document) =>
        document.records.map((record) => toPersistedSavedEnvironmentRecord(record)),
      ),
      Effect.withSpan("desktop.savedEnvironments.getRegistry"),
    ),

    getSecret: Effect.fn("desktop.savedEnvironments.getSecret")(function* (environmentId) {
      yield* Effect.annotateCurrentSpan({ environmentId });
      const document = yield* readRegistryDocument(
        fileSystem,
        environment.savedEnvironmentRegistryPath,
      );
      const encoded = Option.fromNullishOr(
        document.records.find((record) => record.environmentId === environmentId)
          ?.encryptedBearerToken,
      );
      if (Option.isNone(encoded)) {
        return Option.none<string>();
      }
      const encryptionAvailable = yield* safeStorage.isEncryptionAvailable.pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSavedEnvironmentSecretProtectionError({
              operation: "check-encryption-availability",
              environmentId,
              registryPath: environment.savedEnvironmentRegistryPath,
              cause,
            }),
        ),
      );
      if (!encryptionAvailable) {
        return Option.none<string>();
      }

      const secretBytes = yield* decodeSecretBytes(
        environmentId,
        environment.savedEnvironmentRegistryPath,
        encoded.value,
      );
      return Option.some(
        yield* safeStorage.decryptString(secretBytes).pipe(
          Effect.catch((error) => recoverSecret(environmentId, encoded.value, secretBytes, error)),
          Effect.mapError(
            (cause) =>
              new DesktopSavedEnvironmentSecretProtectionError({
                operation: "decrypt-secret",
                environmentId,
                registryPath: environment.savedEnvironmentRegistryPath,
                cause,
              }),
          ),
        ),
      );
    }, lock.withPermits(1)),
  });
});

export const layer = Layer.effect(DesktopSavedEnvironments, make);
