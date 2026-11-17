import * as Schema from "effect/Schema";

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
  readonly error: string | null;
}
