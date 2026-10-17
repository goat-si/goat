import {
  HandoffError,
  isHandoffPending,
  type Handoff,
  type HandoffActor,
  type HandoffState,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export const itemHandoff = (item: OrchestrationV2TurnItem) =>
  item.type === "human_handoff" || item.type === "secret_request" ? item.handoff : undefined;

/** Expiry wins a race with a late answer; a terminal decision is immutable. */
export function transitionHandoff(
  record: Handoff,
  state: HandoffState,
  actor: HandoffActor,
  now: DateTime.Utc,
  runEnded: boolean,
) {
  if (!isHandoffPending(record.state)) {
    return record.state === state
      ? Effect.succeed(record)
      : Effect.fail(
          new HandoffError({ reason: record.state === "expired" ? "expired" : "conflict" }),
        );
  }
  const expired =
    (record.expiresAt !== null &&
      DateTime.toEpochMillis(record.expiresAt) <= DateTime.toEpochMillis(now)) ||
    (record.kind === "approval" && !record.target.path.startsWith("ssh.") && runEnded);
  const next = expired ? "expired" : state;
  if (next === "pending" || (next === "expired" && !expired))
    return Effect.fail(new HandoffError({ reason: "conflict" }));
  if ((next === "opened" || next === "completed" || next === "declined") && actor.type !== "client")
    return Effect.fail(new HandoffError({ reason: "conflict" }));
  if (next === record.state) return Effect.succeed(record);
  const resolved = !isHandoffPending(next);
  return Effect.succeed({
    ...record,
    state: next,
    actor: expired ? { type: "server" as const } : actor,
    ...(resolved
      ? {
          resolvedAt: now,
          ...(!expired && actor.type === "client" ? { resolvedBy: actor.label } : {}),
        }
      : {}),
  });
}
