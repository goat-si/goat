import * as Schema from "effect/Schema";

import { SecretRef, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { needsHumanFields } from "./humanStepResult.ts";

export const OrchestratorMcpRequestSecretInput = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({
    description: "Card title, such as 'GitHub webhook secret'.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description: "What it is for and where to get it.",
  }),
  placeholder: Schema.optional(TrimmedNonEmptyString),
  delivery: Schema.optional(Schema.Literals(["secretRef", "file"])).annotate({
    description:
      'secretRef (default) for a GOAT tool. file for a shell CLI: read the path in your command, e.g. TOKEN="$(cat <file>)" wrangler whoami.',
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60 * 1_000 })),
  ).annotate({ description: "Default 10 min." }),
  clientRequestId: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
      description: "Stable idempotency key to reuse when retrying this mutation.",
    }),
  ).annotate({
    description: "Retry key for this ask. New key after a timeout or cancel.",
  }),
  wait: Schema.optional(Schema.Boolean).annotate({
    description:
      "false returns at once with status pending and a handoff while the card waits; it needs clientRequestId, and calling again with the same id collects the answer. The card closes when this run ends, so collect it in this turn. Default true: wait for the answer.",
  }),
});
export type OrchestratorMcpRequestSecretInput = typeof OrchestratorMcpRequestSecretInput.Type;

export const OrchestratorMcpRequestSecretResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    secretRef: SecretRef.annotate({
      description: "One-use. Pass to a tool that accepts a secretRef. You never see the value.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("saved").annotate({ description: "file holds the value." }),
    file: Schema.String.annotate({
      description:
        "Owner-only file with the value. Read it inside commands and never print it. Deleted after 24 hours.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("pending").annotate({
      description: "wait was false and the user has not answered yet.",
    }),
    ...needsHumanFields("input", "request_secret"),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled", "timed_out"]).annotate({
      description:
        "declined: user chose not to. cancelled: ended with the run. timed_out: no answer in time. Ask again with a new `clientRequestId` if still needed.",
    }),
  }),
]);
export type OrchestratorMcpRequestSecretResult = typeof OrchestratorMcpRequestSecretResult.Type;
