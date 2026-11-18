import type { OrchestrationV2DomainEvent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "./ProjectionStore.ts";
import { EventSinkWriteError, type EventSinkV2Shape } from "./EventSinkShape.ts";

export function makeEventSinkComparePayloadWrites<A, E>(
  sql: SqlClient.SqlClient["Service"],
  writeIfStoredPayloadMatches: <ReadError>(
    read: Effect.Effect<ReadonlyArray<{ readonly payload_json: string }>, ReadError>,
    expected: string,
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<A, E | ReadError>,
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

  const writeIfReleasedSubagentUnchanged = Effect.fn(
    "orchestrationV2.EventSink.writeIfReleasedSubagentUnchanged",
  )(function* (input: Parameters<EventSinkV2Shape["writeIfReleasedSubagentUnchanged"]>[0]) {
    const expected = yield* ProjectionStore.encodeSubagentPayload(input.expected);
    const matches = Effect.gen(function* () {
      const owner = yield* sql<{ readonly payload_json: string }>`
        SELECT s.payload_json
        FROM orchestration_v2_projection_subagents s
        JOIN orchestration_v2_projection_provider_threads p ON p.thread_id = s.thread_id
        WHERE s.subagent_id = ${input.expected.id}
          AND p.provider_thread_id = ${input.providerThreadId}
          AND p.provider_session_id = ${input.providerSessionId}
      `;
      if (owner[0]?.payload_json !== expected) return [];
      for (const node of input.nodes) {
        const rows = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id = ${node.id}
        `;
        if (rows[0]?.payload_json !== (yield* ProjectionStore.encodeNodePayload(node))) return [];
      }
      for (const turn of input.turns) {
        const rows = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_provider_turns
          WHERE provider_turn_id = ${turn.id}
        `;
        if (rows[0]?.payload_json !== (yield* ProjectionStore.encodeProviderTurnPayload(turn)))
          return [];
      }
      for (const item of input.items) {
        const rows = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${item.id}
        `;
        if (rows[0]?.payload_json !== (yield* ProjectionStore.encodeTurnItemPayload(item)))
          return [];
      }
      return owner;
    });
    return yield* writeIfStoredPayloadMatches(matches, expected, input.events);
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
    writeIfReleasedSubagentUnchanged: (
      input: Parameters<EventSinkV2Shape["writeIfReleasedSubagentUnchanged"]>[0],
    ) =>
      writeIfReleasedSubagentUnchanged(input).pipe(
        Effect.mapError(
          (cause) => new EventSinkWriteError({ eventCount: input.events.length, cause }),
        ),
      ),
  };
}
