import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RepositoryInventoryKey } from "./repositoryInventory.ts";

export const REFERENCE_FILE_BYTES = 16 * 1024;
export const REFERENCE_SNAPSHOT_BYTES = 32 * 1024;
export const REFERENCE_BRIEF_BYTES = 64 * 1024;

export const RepositoryReferencePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.makeFilter(
    (value) =>
      !/[\\:]/u.test(value) &&
      Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
      value
        .split("/")
        .every(
          (part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
        ),
  ),
);
export const RepositoryReferenceOid = Schema.String.check(
  Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
);

export const RepositoryReferenceSource = Schema.Struct({
  mode: Schema.Literal("snapshot").annotate({
    description:
      "Read committed content only. Runtime filesystem/root grants are not supported; existing ambient permissions are unchanged.",
  }),
  repositoryKey: RepositoryInventoryKey,
  checkout: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))).annotate({
    description:
      "Exact registered inventory path when several checkouts match. Never an arbitrary source directory.",
  }),
  revision: Schema.optional(RepositoryReferenceOid).annotate({
    description:
      "Exact local commit, including unpushed commits. Omit to pin current HEAD. No fetch; uncommitted changes are excluded.",
  }),
  files: Schema.Array(RepositoryReferencePath).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type RepositoryReferenceSource = typeof RepositoryReferenceSource.Type;

export const RepositoryReferenceRequest = Schema.Struct({
  ...RepositoryReferenceSource.fields,
  host: Schema.optional(
    Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  ).annotate({
    description:
      "Source host through the caller's existing read authority. Null means this environment. Omitted uses this environment for a read/local launch, or the selected SSH launch host.",
  }),
});
export type RepositoryReferenceRequest = typeof RepositoryReferenceRequest.Type;
export const RepositoryReferences = Schema.Array(RepositoryReferenceRequest).check(
  Schema.isMaxLength(4),
);

export const RepositoryReferenceSnapshot = Schema.Struct({
  repositoryKey: RepositoryInventoryKey,
  revision: RepositoryReferenceOid,
  files: Schema.Array(
    Schema.Struct({
      path: RepositoryReferencePath,
      blob: RepositoryReferenceOid,
      text: Schema.String.check(Schema.isMaxLength(REFERENCE_FILE_BYTES)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  totalBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(REFERENCE_SNAPSHOT_BYTES)),
  uncommittedChangesExcluded: Schema.Literal(true),
});
export type RepositoryReferenceSnapshot = typeof RepositoryReferenceSnapshot.Type;
