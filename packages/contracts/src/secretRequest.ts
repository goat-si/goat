import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import { goatCallText } from "./agentSurface/callText.ts";

/** Server stores the value under a one-use SecretRef; the thread learns only status. */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("save"), secret: TrimmedNonEmptyString }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

const SECRET_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the secret request.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  agent_stopped: "The agent that asked has stopped, so this secret can't be used.",
  store_failed: "Could not store the secret.",
  record_failed: "Saved the secret, but could not update the request.",
  invalid_ref: "That secretRef is not valid.",
  read_failed: "Could not read the secret.",
  ref_unavailable: `That secretRef was already used or does not exist. Ask the user again with ${goatCallText("handoff.create")}.`,
  ref_expired: `That secretRef expired. Ask the user again with ${goatCallText("handoff.create")}.`,
  consume_failed: "Could not use that secretRef. Try again.",
  not_a_file_request:
    'The user did not save this secret for shell use. Ask again with goat_handoff_create and delivery: "file".',
  origin_required:
    "That secretRef was not saved for a sign-in page. Ask again with origin set to the page's origin.",
  origin_mismatch:
    "That secretRef is for another site, so nothing was filled. It still works on its own site.",
  origin_bound:
    "That secretRef is for a sign-in page. Use it with goat_preview_fill_secret on that site.",
  too_short_for_sign_in: "A sign-in password needs at least 4 characters.",
} as const;

export const SecretRequestFailureReason = Schema.Literals(
  Object.keys(SECRET_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof SECRET_REQUEST_FAILURE_MESSAGES
  >,
);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

/** The http(s) origin of a URL or origin string, or undefined for anything else. */
export const normalizeSecretOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
};

/** Shorter sign-in values are refused: exact masking of a few characters would hide unrelated text. */
export const SIGN_IN_SECRET_MIN_LENGTH = 4;

export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  {
    reason: SecretRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return SECRET_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
