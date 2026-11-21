import type { OrchestrationV2DomainEvent, OrchestrationV2TurnItem } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../ProjectionStore.ts";

export const guardLostToolEvents = Effect.fn("EventSink.guardLostToolEvents")(function* (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  expected: ReadonlyArray<OrchestrationV2TurnItem>,
) {
  const stale = new Set<string>();
  for (const item of expected) {
    const rows = yield* sql<{
      readonly payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${item.id} LIMIT 1`;
    if (rows[0]?.payload_json !== (yield* ProjectionStore.encodeTurnItemPayload(item)))
      stale.add(item.id);
  }
  return events.filter(
    (event) => event.type !== "turn-item.updated" || !stale.has(event.payload.id),
  );
});
