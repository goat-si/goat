import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";

export class AcpModelSelectionError extends Schema.TaggedError<AcpModelSelectionError>()(
  "AcpModelSelectionError",
  {
    model: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The agent did not accept the model "${this.model}". Choose another model for this provider, then retry.`;
  }
}

const isAcpModelSelectionError = Schema.is(AcpModelSelectionError);
const isProviderCompactionUnsupportedError = Schema.is(
  ProviderAdapter.ProviderCompactionUnsupportedError,
);

/**
 * Turn-start refusals that leave the session usable. Other start failures, such as a session that
 * cannot be reopened or a setup step that fails, can mean the agent lost the session, so the
 * server keeps its recovery for them.
 */
export const refusedWithSessionIntact = (cause: unknown): boolean =>
  isAcpModelSelectionError(cause) || isProviderCompactionUnsupportedError(cause);
