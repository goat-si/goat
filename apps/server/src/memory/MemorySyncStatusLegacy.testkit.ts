// Frozen outer contract and strict JSON codec from c7685f40a. Nested schemas are
// unchanged by A3; intentionally do not derive the old shape from MemorySyncStatus.
import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Rpc from "effect/rpc/Rpc";
const strictSchema = <S extends Schema.Constraint>(schema: S) =>
  Schema.declareConstructor<S["Type"], S["Encoded"]>()(
    [schema],
    ([codec]) => {
      const decode = SchemaParser.decodeUnknownEffect(codec);
      return (input, _ast, options) => decode(input, { ...options, onExcessProperty: "error" });
    },
    {
      toCodec: ([codec]) => new SchemaAST.Link(codec.ast, SchemaTransformation.passthrough()),
      // All memory Encoded values already use JSON. Do not insert a permissive
      // struct parser ahead of this declaration when RPC derives its JSON codec.
      toCodecJson: () => undefined,
    },
  );
const struct = <F extends Schema.Struct.Fields>(fields: F) => {
  const schema = Schema.Struct(fields);
  // Effect's empty struct parser only rejects nullish values and preserves all others.
  return strictSchema(
    Object.keys(fields).length === 0
      ? schema.check(
          Schema.makeFilter(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              !Array.isArray(value) &&
              Reflect.ownKeys(value).length === 0,
            { expected: "an object with no own keys" },
          ),
        )
      : schema,
  );
};
const LegacyMemorySyncStatus = struct({
  memorySpaceId: Schema.NullOr(M.MemorySpaceId),
  state: Schema.Literals(["disabled", "bootstrapping", "online", "offline", "error"]),
  pendingSync: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  quarantined: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  parked: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastSuccessfulSyncAtUtc: Schema.NullOr(M.MemoryUtcTimestamp),
  lastHubSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failureCode: Schema.optionalKey(M.MemoryFailureCode),
  storage: M.MemoryStorageStatus,
  processing: M.MemoryProcessingStatus,
}).check(Schema.makeFilter((v) => v.lastHubSequence === v.processing.lastReceivedHubSequence));
export const legacySyncStatusRpc = Rpc.make("memory.syncStatus", {
  payload: struct({}),
  success: LegacyMemorySyncStatus,
  error: Schema.Union([M.MemoryRpcError, M.EnvironmentAuthorizationError]),
});
