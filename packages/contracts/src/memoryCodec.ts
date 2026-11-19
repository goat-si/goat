import type { MemoryImportLineageRecord, MemoryProjectKey, MemoryScope } from "./memory.ts";
import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const utf8 = (s: string) => new TextEncoder().encode(s).length;
export const jsonBytes = (value: unknown) => utf8(JSON.stringify(value));
export const unique = (values: readonly unknown[]) =>
  new Set(values.map((v) => JSON.stringify(v))).size === values.length;
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v) => b.includes(v));
export const bounded = <S extends Schema.Top>(schema: S, max: number) =>
  schema.check(
    Schema.makeFilter((value) => jsonBytes(value) <= max, {
      expected: `at most ${max} encoded UTF-8 bytes`,
    }),
  );
export const array = <S extends Schema.Top>(schema: S, max = 100, min = 0) =>
  Schema.Array(schema).check(
    Schema.makeFilter((values) => values.length >= min && values.length <= max),
  );
export const distinct = <S extends Schema.Top>(schema: S, max = 100, min = 0) =>
  array(schema, max, min).check(Schema.makeFilter(unique));
// Effect 4 annotations cannot set parse options. A declaration keeps strict parsing
// at the schema boundary, including flipped (encode) and type-only (.make) codecs.
export const strictSchema = <S extends Schema.Constraint>(schema: S) =>
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
export const struct = <F extends Schema.Struct.Fields>(fields: F) => {
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
// TaggedError construction uses its internal struct rather than the overridden ast.
export const strictMakeOptions = (options?: Schema.MakeOptions): Schema.MakeOptions => ({
  ...options,
  disableChecks: false,
  parseOptions: { ...options?.parseOptions, onExcessProperty: "error", disableChecks: false },
});

// Explicit tuples make duplicate identity independent of JSON property insertion order.
const importProjectKey = (v: MemoryProjectKey) =>
  v.kind === "repository" ? [v.kind, v.groupingKey] : [v.kind, v.sharedProjectId];
export const importScopeKey = (v: MemoryScope) =>
  v.kind === "user"
    ? [v.kind]
    : v.kind === "project"
      ? [v.kind, importProjectKey(v.projectKey)]
      : [
          v.kind,
          v.thread.environmentId,
          v.thread.threadId,
          v.projectKey === undefined ? null : importProjectKey(v.projectKey),
        ];
/** Shared canonical key for ledger union, duplicate validation and checkpoint pagination. */

export const memoryImportLineageRecordKey = (v: MemoryImportLineageRecord): string =>
  JSON.stringify([
    v.memorySpaceId,
    v.memoryId,
    v.kind,
    v.kind === "sourceKey"
      ? [v.sourceKey.environmentId, v.sourceKey.sourceId, v.sourceKey.sourceItemKey]
      : [importScopeKey(v.content.scope), v.content.assertionKind, v.content.contentFingerprint],
  ]);
