import type { EventStoreV2 } from "./EventStore.ts";
import {
  OrchestrationV2DomainEvent,
  OrchestrationV2RunJson,
  type OrchestrationV2Run,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ScheduledTaskRuns } from "../scheduledTasks/ScheduledTaskRuns.ts";
import { redactGoatCredentialsDeep } from "../mcp/goatCredentialRedaction.ts";
import { decideScheduledTaskCompletions } from "../scheduledTasks/scheduledTaskCompletion.ts";
import { preserveThreadNotification, sameNotificationEpoch } from "./ProjectionRunNotification.ts";

type RunEvent = Extract<OrchestrationV2DomainEvent, { type: "run.created" | "run.updated" }>;
const isRun = (e: OrchestrationV2DomainEvent): e is RunEvent =>
  e.type === "run.created" || e.type === "run.updated";
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));

/** Staging and append share EventSink's SQL transaction; no provisional event is published. */
const stageScheduledTaskCompletions = Effect.fn("ScheduledTaskCompletionBatch.stage")(function* (
  input: ReadonlyArray<OrchestrationV2DomainEvent>,
  projections: ProjectionStoreV2["Service"],
  scheduledRuns: ScheduledTaskRuns["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  // Append's decoder used to fill schema defaults before projection; staging must see the same values.
  const events = yield* Effect.forEach(input, (event) =>
    decodeEvent(
      redactGoatCredentialsDeep(
        event.type === "thread.created"
          ? { ...event, payload: preserveThreadNotification(undefined, event.payload) }
          : event,
      ),
    ),
  );
  const epochs = new Map<
    string,
    { run: OrchestrationV2Run; decision: string | undefined; token: number; legacy: boolean }
  >();
  const tokens = new Map<number, number>();
  const frozen = new Map<number, string>();
  let nextToken = 0;
  const captured = new Set<string>();
  for (const event of events) {
    if (!isRun(event) || captured.has(event.payload.id)) continue;
    captured.add(event.payload.id);
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=${event.payload.id} AND thread_id=${event.threadId}`;
    if (rows[0]) {
      const run = yield* decodeRun(rows[0].payload_json);
      const decision =
        run.completedAt === null ? undefined : (run.completionNotification ?? "notify");
      const token = nextToken++;
      epochs.set(run.id, {
        run,
        decision,
        token,
        legacy: run.completedAt !== null && run.completionNotification === undefined,
      });
      if (decision !== undefined) frozen.set(token, decision);
    }
  }
  for (const [index, event] of events.entries()) {
    if (isRun(event)) {
      const previous = epochs.get(event.payload.id);
      const same = previous !== undefined && sameNotificationEpoch(previous.run, event.payload);
      const token = same ? previous.token : nextToken++;
      const decision = same ? previous.decision : undefined;
      epochs.set(event.payload.id, {
        run: event.payload,
        decision,
        token,
        legacy: same && previous.legacy,
      });
      tokens.set(index, token);
    }
    yield* projections.apply(event, { deferNotificationCursor: true });
  }
  const pending = [...epochs.values()].filter(
    (e) => e.run.completedAt !== null && e.decision === undefined,
  );
  if (pending.length > 0) {
    const firings = yield* scheduledRuns.resolveBatchAttributions(events);
    const decisions = yield* decideScheduledTaskCompletions(
      pending.map((e) => e.run),
      firings,
    );
    for (const epoch of pending) {
      const decision = decisions.get(epoch.run.id) ?? "notify";
      frozen.set(epoch.token, decision);
      if (epoch.run.completedAt !== null)
        yield* projections.setCompletionNotification({
          threadId: epoch.run.threadId,
          runId: epoch.run.id,
          expectedCompletedAt: epoch.run.completedAt,
          expectedActiveAttemptId: epoch.run.activeAttemptId,
          decision,
        });
    }
  }
  // Legacy epochs are permanently notifying; normalize a duplicate's projection to that decision.
  for (const epoch of epochs.values()) {
    if (epoch.legacy && epoch.run.completedAt !== null)
      yield* projections.setCompletionNotification({
        threadId: epoch.run.threadId,
        runId: epoch.run.id,
        expectedCompletedAt: epoch.run.completedAt,
        expectedActiveAttemptId: epoch.run.activeAttemptId,
        decision: epoch.decision ?? "notify",
      });
  }
  const decorated = events.map((event, index): OrchestrationV2DomainEvent => {
    if (!isRun(event)) return event;
    const { completionNotification: _stale, ...payload } = event.payload;
    if (payload.completedAt === null) return { ...event, payload };
    return {
      ...event,
      payload: {
        ...payload,
        completionNotification: frozen.get(tokens.get(index) ?? -1) ?? "notify",
      },
    };
  });
  yield* projections.recordNotificationCompletions(decorated);
  return decorated;
});

// The enclosing EventSink operation owns the span and SQL transaction.
export const makeScheduledTaskAppender = (
  sql: SqlClient.SqlClient,
  eventStore: EventStoreV2["Service"],
  projectionStore: ProjectionStoreV2["Service"],
  scheduledRuns: ScheduledTaskRuns["Service"],
) =>
  Effect.fnUntraced(function* (input: Parameters<typeof eventStore.append>[0]) {
    const events = yield* stageScheduledTaskCompletions(
      input.events,
      projectionStore,
      scheduledRuns,
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return yield* eventStore.append({ ...input, events });
  });
