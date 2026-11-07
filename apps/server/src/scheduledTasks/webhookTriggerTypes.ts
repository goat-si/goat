import type { ScheduledTaskWebhookDeliveryId } from "@goat/contracts";
import type { WebhookRequest } from "./webhookTemplate.ts";

export interface WebhookTriggerRequest extends WebhookRequest {
  readonly hookId: string;
  readonly token: string;
  readonly body: Uint8Array;
  readonly relayDeliveryId?: string;
  readonly receivedAt?: string;
}

export type WebhookDeliveryOutcome =
  | "accepted"
  | "duplicate"
  | "coalesced"
  | "prompt_too_long"
  | "queue_full"
  | "rate_limited"
  | "disabled"
  | "rejected_signature"
  | "expired"
  | "filtered"
  | "not_found"
  | "error";

export type WebhookTriggerResult =
  | {
      readonly _tag: "accepted";
      readonly deliveryId: ScheduledTaskWebhookDeliveryId;
      readonly outcome: "accepted" | "duplicate" | "coalesced" | "prompt_too_long" | "filtered";
    }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "rejected_signature" }
  | { readonly _tag: "disabled" }
  | {
      readonly _tag: "rate_limited";
      readonly outcome: "rate_limited" | "queue_full";
    }
  | { readonly _tag: "expired" };
