import { ProviderInstanceId, ProviderSessionId } from "@goat/contracts";
import * as Schema from "effect/Schema";

import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";

export const ProviderSessionReleaseReason = Schema.Literals([
  "idle_timeout",
  "runtime_error",
  "manual_shutdown",
  "server_shutdown",
]);
export type ProviderSessionReleaseReason = typeof ProviderSessionReleaseReason.Type;

export class ProviderSessionOpenError extends Schema.TaggedError<ProviderSessionOpenError>()(
  "ProviderSessionOpenError",
  {
    instanceId: ProviderInstanceId,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to open provider instance ${this.instanceId} session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionLookupError extends Schema.TaggedError<ProviderSessionLookupError>()(
  "ProviderSessionLookupError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to look up provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionCloseError extends Schema.TaggedError<ProviderSessionCloseError>()(
  "ProviderSessionCloseError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to close provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionReleaseError extends Schema.TaggedError<ProviderSessionReleaseError>()(
  "ProviderSessionReleaseError",
  {
    providerSessionId: ProviderSessionId,
    reason: ProviderSessionReleaseReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to release provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionActivityError extends Schema.TaggedError<ProviderSessionActivityError>()(
  "ProviderSessionActivityError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to update provider session activity for ${this.providerSessionId}.`;
  }
}

export const ProviderSessionManagerV2Error = Schema.Union([
  ProviderSessionOpenError,
  ProviderWorkspaceMissingError,
  ProviderSessionLookupError,
  ProviderSessionCloseError,
  ProviderSessionReleaseError,
  ProviderSessionActivityError,
]);
export type ProviderSessionManagerV2Error = typeof ProviderSessionManagerV2Error.Type;
