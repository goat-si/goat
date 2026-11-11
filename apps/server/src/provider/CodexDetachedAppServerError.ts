import * as Schema from "effect/Schema";

export class CodexDetachedAppServerError extends Schema.TaggedError<CodexDetachedAppServerError>()(
  "CodexDetachedAppServerError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}
