import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A normalized origin identity, never a remote URL containing credentials. */
export const RepositoryInventoryKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[a-z0-9.-]+\/[a-z0-9._/-]+$/),
  Schema.makeFilter((key) =>
    key.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  ),
);

export const RepositoryInventoryEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  originKey: Schema.NullOr(RepositoryInventoryKey),
  state: Schema.Literals(["available", "missing", "not_repository", "unavailable"]),
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  upstream: Schema.NullOr(Schema.String),
  /** Local tracking refs only; no fetch is performed. Null means unknown, not zero. */
  ahead: Schema.NullOr(NonNegativeInt),
  behind: Schema.NullOr(NonNegativeInt),
  dirty: Schema.NullOr(Schema.Boolean),
  /** Directory mtimes and node_modules presence do not prove a successful install. */
  dependencies: Schema.Struct({ state: Schema.Literal("unknown"), installedAt: Schema.Null }),
});
export type RepositoryInventoryEntry = typeof RepositoryInventoryEntry.Type;

export const RepositoryInventorySnapshot = Schema.Struct({
  sampledAt: NonNegativeInt,
  entries: Schema.Array(RepositoryInventoryEntry).check(Schema.isMaxLength(128)),
  truncated: Schema.Boolean,
});
export type RepositoryInventorySnapshot = typeof RepositoryInventorySnapshot.Type;

export const RepositoryLaunchSelection = Schema.Struct({
  key: RepositoryInventoryKey,
  /** Explicit candidates avoid expanding host discovery or choosing a placement policy. */
  candidateHosts: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(255))).check(Schema.isMaxLength(8)),
  ),
});
export type RepositoryLaunchSelection = typeof RepositoryLaunchSelection.Type;
