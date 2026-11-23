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
