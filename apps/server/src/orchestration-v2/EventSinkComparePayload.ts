import type { OrchestrationV2DomainEvent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as ProjectionStore from "./ProjectionStore.ts";
import { EventSinkWriteError, type EventSinkV2Shape } from "./EventSinkShape.ts";

export function makeEventSinkComparePayloadWrites<A, E>(
  sql: SqlClient.SqlClient["Service"],
  writeIfStoredPayloadMatches: (
    read: Effect.Effect<ReadonlyArray<{ readonly payload_json: string }>, SqlError.SqlError>,
    expected: string,
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<A, E>,
) {
  const writeIfProviderThreadUnchangedEffect = Effect.fn(
    "orchestrationV2.EventSink.writeIfProviderThreadUnchanged",
  )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadUnchanged"]>[0]) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.event_count": input.events.length,
      "orchestration_v2.provider_thread_id": input.expected.id,
    });
    const expectedJson = yield* ProjectionStore.encodeProviderThreadPayload(input.expected);
    return yield* writeIfStoredPayloadMatches(
      sql<{ readonly payload_json: string }>`
          SELECT payload_json
          FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${input.expected.id}
          LIMIT 1
        `,
      expectedJson,
      input.events,
    );
  });

  const writeIfTurnItemUnchangedEffect = Effect.fn(
    "orchestrationV2.EventSink.writeIfTurnItemUnchanged",
  )(function* (input: Parameters<EventSinkV2Shape["writeIfTurnItemUnchanged"]>[0]) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.event_count": input.events.length,
      "orchestration_v2.turn_item_id": input.expected.id,
    });
    const expectedJson = yield* ProjectionStore.encodeTurnItemPayload(input.expected);
    return yield* writeIfStoredPayloadMatches(
      sql<{ readonly payload_json: string }>`
          SELECT payload_json
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${input.expected.id}
          LIMIT 1
        `,
      expectedJson,
      input.events,
    );
  });

  return {
    writeIfProviderThreadUnchanged: (input) =>
      writeIfProviderThreadUnchangedEffect(input).pipe(
        Effect.mapError(
          (cause) => new EventSinkWriteError({ eventCount: input.events.length, cause }),
        ),
      ),
    writeIfTurnItemUnchanged: (input) =>
      writeIfTurnItemUnchangedEffect(input).pipe(
        Effect.mapError(
          (cause) => new EventSinkWriteError({ eventCount: input.events.length, cause }),
        ),
      ),
  };
}
