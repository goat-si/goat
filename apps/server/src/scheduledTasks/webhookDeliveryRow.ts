import {
  ScheduledTaskId,
  ScheduledTaskWebhookDeliveryId,
  type ScheduledTaskWebhookDeliveryOutcome,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const HeadersJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const MissingFieldsJson = Schema.fromJsonString(Schema.Array(Schema.String));
export const decodeHeadersJson = Schema.decodeUnknownOption(HeadersJson);
export const decodeMissingFieldsJson = Schema.decodeUnknownOption(MissingFieldsJson);
export const encodeHeadersJson = Schema.encodeSync(HeadersJson);
export const encodeMissingFieldsJson = Schema.encodeSync(MissingFieldsJson);

export interface WebhookDeliveryRow {
  readonly delivery_id: string;
  readonly task_id: string;
  readonly received_at: string;
  readonly method: string;
  readonly query: string;
  readonly headers_json: string;
  readonly body: string;
  readonly body_bytes: number;
  readonly body_truncated: number;
  readonly outcome: string;
  readonly signature_verified: number;
  readonly missing_fields_json: string;
  readonly rendered_prompt: string | null;
  readonly pending_window: number;
  readonly firing_accepted: number;
  readonly error: string | null;
}

export const deliveryEvidence = (sql: SqlClient.SqlClient) => sql`
  EXISTS (SELECT 1 FROM scheduled_task_webhook_pending p
    WHERE p.delivery_id = d.delivery_id AND p.coalesce_key <> p.delivery_id
      AND p.state IN ('pending', 'dispatching')) AS pending_window,
  EXISTS (SELECT 1 FROM scheduled_task_runs r
    WHERE r.webhook_delivery_id = d.delivery_id AND r.dispatch_status = 'accepted') AS firing_accepted`;

export const deliveryHeaders = (row: WebhookDeliveryRow): Readonly<Record<string, string>> =>
  Option.getOrElse(decodeHeadersJson(row.headers_json), () => ({}));

export const decodeDeliverySummary = (row: WebhookDeliveryRow) => ({
  id: ScheduledTaskWebhookDeliveryId.make(row.delivery_id),
  taskId: ScheduledTaskId.make(row.task_id),
  receivedAt: row.received_at,
  method: row.method,
  contentType: deliveryHeaders(row)["content-type"] ?? null,
  bodyBytes: row.body_bytes,
  outcome: row.outcome as ScheduledTaskWebhookDeliveryOutcome,
  signatureVerified: row.signature_verified === 1,
  pendingWindow: row.outcome === "accepted" && row.pending_window === 1,
  firingAccepted: row.firing_accepted === 1,
  missingFields: Option.getOrElse(decodeMissingFieldsJson(row.missing_fields_json), () => []),
  error: row.error,
});
