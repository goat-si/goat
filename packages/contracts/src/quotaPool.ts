import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Encoding recovery validates raw nested arrays too early; recover only while decoding unknown entries.
const quotaArray = <Element extends Schema.Top>(element: Element) =>
  Schema.Array(
    Schema.UndefinedOr(element).pipe(Schema.catchDecoding(() => Effect.succeedSome(undefined))),
  ).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(element)),
      SchemaTransformation.transform<
        ReadonlyArray<Element["Type"]>,
        ReadonlyArray<Element["Type"] | undefined>
      >({
        decode: (values) => values.filter((value) => value !== undefined),
        encode: (values) => values,
      }),
    ),
  );

export const QuotaWindowKind = Schema.Literals([
  "burst_5h",
  "daily",
  "weekly",
  "monthly",
  "credits",
  "custom",
]);
export type QuotaWindowKind = typeof QuotaWindowKind.Type;

export const QuotaSource = Schema.Literals(["measured", "header", "estimated"]);
export type QuotaSource = typeof QuotaSource.Type;

export const QuotaWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: QuotaWindowKind,
  label: TrimmedNonEmptyString,
  usedPercent: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  used: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  unit: Schema.optional(Schema.Literals(["requests", "tokens", "credits", "usd"])),
  resetsAt: Schema.optional(IsoDateTime),
  windowSeconds: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  scopeModel: Schema.optional(TrimmedNonEmptyString),
  source: QuotaSource,
  observedAt: IsoDateTime,
  exhausted: Schema.optional(Schema.Boolean),
});
export type QuotaWindow = typeof QuotaWindow.Type;

export const QuotaAccount = Schema.Struct({
  provider: TrimmedNonEmptyString,
  driver: Schema.optional(TrimmedNonEmptyString),
  // OpenCodex owns this opaque reference; decoding must not normalize its identity.
  accountRef: Schema.String.check(Schema.isNonEmpty()),
  label: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  state: Schema.Literals(["available", "exhausted", "paused", "reauth", "unknown"]),
  windows: quotaArray(QuotaWindow),
  failure: Schema.optional(TrimmedNonEmptyString),
});
export type QuotaAccount = typeof QuotaAccount.Type;

export const QuotaPool = Schema.Struct({
  schema: Schema.Literal("ocx.quota-pool/1"),
  producer: Schema.Struct({
    version: TrimmedNonEmptyString,
    role: Schema.Literals(["standalone", "hub", "client"]),
    homeId: TrimmedNonEmptyString,
  }),
  generatedAt: IsoDateTime,
  providers: quotaArray(
    Schema.Struct({
      provider: TrimmedNonEmptyString,
      accounts: quotaArray(QuotaAccount),
      pooled: Schema.Struct({
        windows: quotaArray(QuotaWindow),
        headroom: Schema.optional(Schema.Number),
        nextResetAt: Schema.optional(IsoDateTime),
      }),
    }),
  ),
});
export type QuotaPool = typeof QuotaPool.Type;
