import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PullRequestListResult } from "./pullRequest.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

/**
 * The names keep their `cli-` prefix for wire compatibility; for a host read with a credential
 * rather than a tool they mean "no credential" and "a refused credential".
 */
export const PullRequestUnavailableReason = Schema.Literals([
  "cli-missing",
  "cli-unauthenticated",
  "provider-unsupported",
]);
export type PullRequestUnavailableReason = typeof PullRequestUnavailableReason.Type;

export class PullRequestUnavailableError extends Schema.TaggedError<PullRequestUnavailableError>()(
  "PullRequestUnavailableError",
  {
    reason: PullRequestUnavailableReason,
    provider: Schema.optional(SourceControlProviderKind),
    listResult: Schema.optional(PullRequestListResult),
    /**
     * What the host needs on the server, in its own words. Absent from older servers, which
     * shipped no such field, and for a host that names nothing.
     */
    requirement: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PullRequestUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    switch (this.reason) {
      case "cli-missing":
        return this.requirement ?? "The tool this host is read through is not installed or set up.";
      case "cli-unauthenticated":
        return this.requirement ?? "This host has no working credentials.";
      case "provider-unsupported":
        return "Change requests cannot be browsed for this project's host yet.";
    }
  }
}

export class PullRequestOperationError extends Schema.TaggedError<PullRequestOperationError>()(
  "PullRequestOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    reason: Schema.optional(Schema.Literal("not-found")),
    listResult: Schema.optional(PullRequestListResult),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PullRequestOperationError)(this, { status: 502 });
  }

  override get message(): string {
    return `Pull request operation ${this.operation} failed: ${this.detail}`;
  }
}
