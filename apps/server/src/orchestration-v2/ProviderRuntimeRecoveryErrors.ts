import { ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";

export class ProviderRuntimeRecoveryError extends Schema.TaggedError<ProviderRuntimeRecoveryError>()(
  "ProviderRuntimeRecoveryError",
  {
    operation: Schema.Literals(["read-projections", "reconcile", "drain-outbox"]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider runtime recovery failed during ${this.operation}.`;
  }
}
export const drainOutboxError = (cause: unknown) =>
  new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause });

export const isProviderRuntimeRecoveryError = Schema.is(ProviderRuntimeRecoveryError);
