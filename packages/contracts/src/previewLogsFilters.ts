import { Schema } from "effect";

export const DiagnosticFilter = Schema.String.check(Schema.isMaxLength(256));
export const DiagnosticSince = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
);
