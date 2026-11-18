import type { ModelSelection } from "@goat/contracts";
import * as Schema from "effect/Schema";

import type * as CursorAgentSdk from "./CursorAgentSdk.ts";
import { isCursorSdkError } from "./sdk.ts";

class CursorModelUnavailableError extends Schema.TaggedError<CursorModelUnavailableError>()(
  "CursorModelUnavailableError",
  {
    model: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cursor cannot run the model "${this.model}". Cursor only runs models from your Cursor account. Choose one of those, or use OpenCode for OpenRouter and other API-key models.`;
  }
}

// Uncoded SDK model rejections are identifiable only by message prefix.
export const classifyCursorModelRejection =
  (modelSelection: ModelSelection) => (error: CursorAgentSdk.CursorAgentSdkRunnerError) =>
    isCursorSdkError(error.cause, "ConfigurationError") &&
    error.cause.message.startsWith("Cannot use this model:")
      ? new CursorModelUnavailableError({ model: modelSelection.model, cause: error.cause })
      : error;
