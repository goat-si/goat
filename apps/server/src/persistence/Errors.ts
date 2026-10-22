import { SERVER_EXIT_CODE_DATABASE_AHEAD } from "@goat/contracts";
import * as Predicate from "effect/Predicate";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import packageJson from "../../package.json" with { type: "json" };

const databaseAheadBuildVersion = packageJson.version.trim() || "this build";

function summarizeSchemaIssue(issue: SchemaIssue.Issue): string {
  switch (issue._tag) {
    case "Filter":
    case "Encoding":
    case "Pointer":
      return `${issue._tag}(${summarizeSchemaIssue(issue.issue)})`;
    case "Composite":
    case "AnyOf":
      return `${issue._tag}(${issue.issues.map(summarizeSchemaIssue).join(",")})`;
    default:
      return issue._tag;
  }
}

export const PersistenceErrorCorrelation = Schema.Union([
  Schema.Struct({ sessionId: Schema.String }),
  Schema.Struct({ currentSessionId: Schema.String }),
  Schema.Struct({ pairingLinkId: Schema.String }),
  Schema.Struct({ threadId: Schema.String }),
]);
export type PersistenceErrorCorrelation = typeof PersistenceErrorCorrelation.Type;

export class PersistenceSqlError extends Schema.TaggedError<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail === undefined
      ? `SQL error in ${this.operation}`
      : `SQL error in ${this.operation}: ${this.detail}`;
  }
}

export class PersistenceDecodeError extends Schema.TaggedError<PersistenceDecodeError>()(
  "PersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  static fromSchemaError(
    operation: string,
    cause: Schema.SchemaError,
    correlation?: PersistenceErrorCorrelation,
  ): PersistenceDecodeError {
    return new PersistenceDecodeError({
      operation,
      issue: summarizeSchemaIssue(cause.issue),
      ...(correlation === undefined ? {} : { correlation }),
      cause,
    });
  }

  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}

export class DatabaseNewerThanBuildError extends Schema.TaggedError<DatabaseNewerThanBuildError>()(
  "DatabaseNewerThanBuildError",
  {
    unknownMigrations: Schema.Array(Schema.String),
    originalMessage: Schema.String,
  },
) {
  // Distinct process exit code so a supervisor can tell "a newer build migrated
  // this database" apart from a crash and stop restarting.
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_DATABASE_AHEAD;

  override get message(): string {
    return `This database was upgraded by a newer GOAT build; GOAT ${databaseAheadBuildVersion} cannot open it. Start that newer build, or update GOAT. Unknown migrations: ${this.unknownMigrations.join(", ")}.`;
  }
}

function sqliteCondition(cause: unknown): string | undefined {
  let value = cause;
  for (let depth = 0; depth < 4 && Predicate.isObject(value); depth += 1) {
    if (
      "errcode" in value &&
      typeof value.errcode === "number" &&
      "errstr" in value &&
      typeof value.errstr === "string"
    ) {
      return `SQLITE(${value.errcode}) ${value.errstr}`;
    }
    value = "cause" in value ? value.cause : undefined;
  }
  return undefined;
}

/**
 * A rejected payload must never reach diagnostics, so a schema failure contributes only its
 * issue tags, and a driver failure only its normalized condition.
 */
function describeSqlCause(cause: unknown): string | undefined {
  if (Schema.isSchemaError(cause)) return summarizeSchemaIssue(cause.issue);
  return sqliteCondition(cause);
}

export function toPersistenceSqlError(operation: string) {
  return (cause: unknown): PersistenceSqlError => {
    const detail = describeSqlCause(cause);
    return new PersistenceSqlError({
      operation,
      ...(detail === undefined ? {} : { detail }),
      cause,
    });
  };
}

export function toPersistenceDecodeError(operation: string) {
  return (cause: Schema.SchemaError): PersistenceDecodeError =>
    PersistenceDecodeError.fromSchemaError(operation, cause);
}

export type OrchestrationEventStoreError = PersistenceSqlError | PersistenceDecodeError;

export type OrchestrationCommandReceiptRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export type ProviderSessionRuntimeRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type AuthPairingLinkRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type AuthSessionRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type PullRequestFilesViewedRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type PullRequestReviewGuideRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type ProjectionRepositoryError = PersistenceSqlError | PersistenceDecodeError;
