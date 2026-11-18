import {
  OrchestrationV2RunAttemptJson,
  type EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunAttempt,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { EventSinkWriteError, type EventSinkV2Shape } from "./EventSinkShape.ts";

export type InputDelivery = NonNullable<OrchestrationV2RunAttempt["inputDelivery"]>;

export interface AttemptDeliveryUpdate {
  readonly id: EventId;
  readonly occurredAt: DateTime.Utc;
  readonly delivery: Exclude<InputDelivery, "unsent">;
}

const decodeAttempt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJson),
);

export function initializeAttemptDelivery(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent {
  return event.type === "run-attempt.created" &&
    event.payload.status === "pending" &&
    event.payload.inputDelivery === undefined
    ? { ...event, payload: { ...event.payload, inputDelivery: "unsent" } }
    : event;
}

export const withAttemptDeliveryEvent = Effect.fn("EventSink.withAttemptDeliveryEvent")(function* (
  sql: SqlClient.SqlClient,
  input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0],
) {
  const update = input.attemptDelivery;
  if (update === undefined) return input.events;
  const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_run_attempts
      WHERE thread_id = ${input.threadId} AND run_id = ${input.runId} AND attempt_id = ${input.activeAttemptId}
    `;
  const row = rows[0];
  if (row === undefined)
    return yield* new EventSinkWriteError({
      eventCount: 0,
      cause: "Active attempt missing at provider input admission.",
    });
  const attempt = yield* decodeAttempt(row.payload_json);
  if (
    attempt.inputDelivery === "accepted" ||
    attempt.inputDelivery === update.delivery ||
    (update.delivery === "accepted" && attempt.inputDelivery !== "ambiguous")
  )
    return input.events;
  return [
    ...input.events,
    {
      id: update.id,
      type: "run-attempt.updated",
      threadId: input.threadId,
      runId: attempt.runId,
      nodeId: attempt.rootNodeId,
      providerInstanceId: attempt.providerInstanceId,
      occurredAt: update.occurredAt,
      payload: { ...attempt, inputDelivery: update.delivery },
    } satisfies OrchestrationV2DomainEvent,
  ];
});

export const preserveAttemptDeliveryJson = (sql: SqlClient.SqlClient) => sql`
  CASE
    WHEN json_extract(excluded.payload_json, '$.inputDelivery') = 'accepted'
      THEN excluded.payload_json
    WHEN json_extract(payload_json, '$.inputDelivery') = 'unsent'
      AND json_extract(excluded.payload_json, '$.inputDelivery') IS NULL
      AND (excluded.status <> 'pending'
        OR json_extract(excluded.payload_json, '$.startedAt') IS NOT NULL
        OR excluded.provider_turn_id IS NOT NULL)
      THEN json_set(excluded.payload_json, '$.inputDelivery', 'ambiguous')
    WHEN json_extract(payload_json, '$.inputDelivery') IN ('accepted', 'ambiguous')
      OR (json_extract(payload_json, '$.inputDelivery') IS NOT NULL
        AND json_extract(excluded.payload_json, '$.inputDelivery') IS NULL)
      THEN json_set(excluded.payload_json, '$.inputDelivery', json_extract(payload_json, '$.inputDelivery'))
    ELSE excluded.payload_json
  END
`;

export function preserveAttemptDelivery(
  attempts: ReadonlyArray<OrchestrationV2RunAttempt>,
  next: OrchestrationV2RunAttempt,
) {
  const current = attempts.find(({ id }) => id === next.id)?.inputDelivery;
  // An older server can execute a new attempt without recording a submit fence.
  if (
    current === "unsent" &&
    next.inputDelivery === undefined &&
    (next.status !== "pending" || next.startedAt !== null || next.providerTurnId !== null)
  )
    return { ...next, inputDelivery: "ambiguous" as const };
  return current !== undefined &&
    next.inputDelivery !== "accepted" &&
    (current !== "unsent" || next.inputDelivery === undefined)
    ? { ...next, inputDelivery: current }
    : next;
}
