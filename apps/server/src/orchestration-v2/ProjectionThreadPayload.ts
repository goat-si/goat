import { OrchestrationV2AppThreadJson as OrchestrationV2AppThreadJsonSchema } from "@goat/contracts";
import * as Schema from "effect/Schema";

export const encodeThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
export const encodeThreadUpdatedAt = Schema.encodeEffect(
  OrchestrationV2AppThreadJsonSchema.fields.updatedAt,
);
export const decodeThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
