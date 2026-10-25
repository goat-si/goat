import type { ScheduledTaskWebhookSignature } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AutomationHold from "../automationHold.ts";
import { verifyWebhookSignature } from "./webhookVerification.ts";

export class WebhookAutomationHeldError extends Schema.TaggedError<WebhookAutomationHeldError>()(
  "WebhookAutomationHeldError",
  {},
) {
  readonly retryable = true;
  override get message() {
    return "Automation is held on this server. Retry after automation resumes.";
  }
}

export const rejectWebhookWhileHeld = Effect.fn("ScheduledTaskService.rejectWebhookWhileHeld")(
  function* (
    signature: ScheduledTaskWebhookSignature | null,
    secret: string | null,
    input: {
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
    },
  ) {
    if (!(yield* AutomationHold.isHeld)) return;
    // Authenticate before refusing, without consuming a relay or replay claim.
    if (
      signature !== null &&
      !(secret !== null && verifyWebhookSignature({ ...input, signature, secret }))
    )
      return { _tag: "rejected_signature" as const };
    return yield* new WebhookAutomationHeldError({});
  },
);
