import {
  ChildReadyStep,
  EnvironmentId,
  OpenCodexChildSetup,
  ProviderInstanceConfig,
  ProviderInstanceId,
  TrimmedNonEmptyString,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- temporary file names only, no secrets.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

const FILE = "opencodex-child-ready.json";

/**
 * One Home's setup operation on this Child. `running` names a stage in progress; a restart turns
 * it into an interrupted failure. `ownedFingerprint` is the bootstrap instance envelope this
 * journal wrote, so retries adopt only that exact instance; `deleted` records a user's removal.
 */
export const ChildReadyOperation = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  homeEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId,
  running: Schema.optional(ChildReadyStep),
  instanceId: Schema.optional(ProviderInstanceId),
  desiredFingerprint: Schema.optional(Schema.String),
  ownedFingerprint: Schema.optional(Schema.String),
  /** The owned envelope as stored, the expectedInstance of the next settings commit. */
  ownedInstance: Schema.optional(ProviderInstanceConfig),
  deleted: Schema.optional(Schema.Boolean),
  /**
   * The operation whose one paid request began. That operation never requests again, whatever
   * became of its outcome or proof; a new operation id starts clean.
   */
  probeRequestedFor: Schema.optional(TrimmedNonEmptyString),
  catalog: Schema.optional(
    Schema.Struct({
      home: Schema.String,
      binaryPath: Schema.String,
      digest: Schema.String,
    }),
  ),
  setup: Schema.optional(OpenCodexChildSetup),
});
export type ChildReadyOperation = typeof ChildReadyOperation.Type;
const Records = Schema.Struct({
  version: Schema.Literal(1),
  operations: Schema.Record(Schema.String, ChildReadyOperation),
});
type Records = typeof Records.Type;
const decodeRecords = Schema.decodeUnknownEffect(Schema.fromJsonString(Records));
const encodeRecords = Schema.encodeEffect(Schema.fromJsonString(Records));

/** The journal could not be read or written; Ready is never published past it. */
export class ChildReadyJournalError extends Schema.TaggedError<ChildReadyJournalError>()(
  "ChildReadyJournalError",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.optional(Schema.Defect()) },
) {}

export class ChildReadyJournal extends Context.Service<
  ChildReadyJournal,
  {
    readonly read: (
      home: EnvironmentId,
    ) => Effect.Effect<ChildReadyOperation | undefined, ChildReadyJournalError>;
    readonly put: (
      home: EnvironmentId,
      operation: ChildReadyOperation,
    ) => Effect.Effect<void, ChildReadyJournalError>;
    /** Drops a proof whose binding changed; the operation and its ownership stay. */
    readonly removeProof: (home: EnvironmentId) => Effect.Effect<void, ChildReadyJournalError>;
  }
>()("goat/opencodex/ChildReadyJournal") {}

const interrupted = (operation: ChildReadyOperation): ChildReadyOperation => {
  if (operation.running === undefined) return operation;
  const { running, ...rest } = operation;
  return rest.setup === undefined
    ? rest
    : {
        ...rest,
        setup: {
          ...rest.setup,
          readiness: rest.setup.proof === undefined ? "invalid" : rest.setup.readiness,
          failure: {
            code: "interrupted",
            step: running,
            message: "GOAT restarted during setup. Retry setup.",
            retryable: true,
          },
          nextAction: "retry",
        },
      };
};

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const file = path.join(config.stateDir, FILE);
  const writing = yield* Semaphore.make(1);
  // ENOENT alone starts empty; any other read or decode failure keeps the file and refuses work.
  const loaded = yield* fs.readFileString(file).pipe(
    Effect.flatMap((text) => decodeRecords(text).pipe(Effect.asSome)),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeedSome<Records>({ version: 1, operations: {} })
          : Effect.succeed(Option.none<Records>()),
    }),
    Effect.orElseSucceed(() => Option.none<Records>()),
  );
  const records = yield* Ref.make(
    Option.map(loaded, (current) => ({
      version: 1 as const,
      operations: Object.fromEntries(
        Object.entries(current.operations).map(([home, operation]) => [
          home,
          interrupted(operation),
        ]),
      ),
    })),
  );
  const current = Ref.get(records).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new ChildReadyJournalError({ operation: "read" })),
        onSome: Effect.succeed,
      }),
    ),
  );
  const persist = Effect.fn("ChildReadyJournal.persist")(function* (next: Records) {
    const tmp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(tmp, yield* encodeRecords(next), { mode: 0o600 });
      yield* fs.rename(tmp, file);
    }).pipe(Effect.mapError((cause) => new ChildReadyJournalError({ operation: "write", cause })));
    yield* Ref.set(records, Option.some(next));
  });
  const update = (change: (operations: Records["operations"]) => Records["operations"]) =>
    writing.withPermits(1)(
      current.pipe(
        Effect.flatMap((value) => persist({ version: 1, operations: change(value.operations) })),
      ),
    );
  return ChildReadyJournal.of({
    read: Effect.fn("ChildReadyJournal.read")(function* (home) {
      return (yield* current).operations[home];
    }),
    put: Effect.fn("ChildReadyJournal.put")(function* (home, operation) {
      yield* update((operations) => ({ ...operations, [home]: operation }));
    }),
    removeProof: Effect.fn("ChildReadyJournal.removeProof")(function* (home) {
      yield* update((operations) => {
        const operation = operations[home];
        if (operation?.setup?.proof === undefined) return operations;
        const { proof: _proof, ...setup } = operation.setup;
        return {
          ...operations,
          [home]: { ...operation, setup: { ...setup, readiness: "invalid" } },
        };
      });
    }),
  });
});

export const layer = Layer.effect(ChildReadyJournal, make);
