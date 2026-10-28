import type {
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
} from "@goat/contracts/relay";
import {
  RelayAgentActivityAggregateState as RelayAgentActivityAggregateStateSchema,
  RelayAgentAwarenessPreferences as RelayAgentAwarenessPreferencesSchema,
} from "@goat/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as LiveActivities from "./LiveActivities.ts";
import type { ApnsLiveActivityAlert, ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";
import { notificationForActivity } from "./agentActivityPayloads.ts";
import {
  alertForAttentionTransition,
  alertForNewlyTerminal,
  rowPhasesChanged,
  shouldAlertForActivity,
} from "./agentActivityAlerts.ts";
const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
const FRESHLY_ARMED_GRACE_MS = 2 * 60 * 1000;

type ChosenLiveActivityDelivery =
  | {
      readonly kind: "live_activity_start" | "live_activity_update";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState;
      readonly alert: ApnsLiveActivityAlert | null;
    }
  | {
      readonly kind: "live_activity_end";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly alert: ApnsLiveActivityAlert | null;
    };

type ChosenPushNotificationDelivery = {
  readonly kind: "push_notification";
  readonly token: string;
  readonly notification: ApnsNotificationPayload;
};

type ChosenDelivery = ChosenLiveActivityDelivery | ChosenPushNotificationDelivery;

const decodeRelayAgentActivityAggregateStateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivityAggregateStateSchema),
);
const decodeRelayAgentAwarenessPreferencesJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferencesSchema),
);
export function parseAggregate(value: string | null): RelayAgentActivityAggregateState | null {
  if (!value) {
    return null;
  }
  return Option.getOrNull(decodeRelayAgentActivityAggregateStateJson(value));
}

export function parsePreferences(value: string): RelayAgentAwarenessPreferences | null {
  return Option.getOrNull(decodeRelayAgentAwarenessPreferencesJson(value));
}

function aggregateNeedsAttention(aggregate: RelayAgentActivityAggregateState): boolean {
  return aggregate.activities.some(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
}

function shouldUpdateLiveActivity(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly lastDeliveryAt: string | null;
  readonly nowMs: number;
}): boolean {
  if (!input.previousAggregate) {
    return true;
  }
  if (JSON.stringify(input.previousAggregate) === JSON.stringify(input.nextAggregate)) {
    return false;
  }
  if (input.previousAggregate.activeCount !== input.nextAggregate.activeCount) {
    return true;
  }
  if (aggregateNeedsAttention(input.nextAggregate)) {
    return true;
  }
  // Phase and row changes may be the last update until the next transition.
  // Throttling them would leave the card showing a stale state indefinitely.
  if (rowPhasesChanged(input.previousAggregate, input.nextAggregate)) {
    return true;
  }
  const lastDeliveryAtMs =
    input.lastDeliveryAt === null
      ? null
      : Option.match(DateTime.make(input.lastDeliveryAt), {
          onNone: () => Number.NaN,
          onSome: (dt) => dt.epochMilliseconds,
        });
  return (
    lastDeliveryAtMs === null ||
    Number.isNaN(lastDeliveryAtMs) ||
    input.nowMs - lastDeliveryAtMs >= MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS
  );
}

// Restart replays of old completions must not ring again.

export function notificationForAggregate(input: {
  readonly target: LiveActivities.TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
}): ApnsNotificationPayload | null {
  if (!input.target.push_token || input.aggregate === null) {
    return null;
  }
  const preferences = parsePreferences(input.target.preferences_json);
  if (!preferences?.notificationsEnabled) {
    return null;
  }
  const activity = input.aggregate.activities[0];
  if (!activity) {
    return null;
  }
  if (!shouldAlertForActivity({ ...activity, preferences, nowMs: input.nowMs })) return null;
  return notificationForActivity(activity);
}

// Suppressed Live Activity updates must not fall back to alert pushes or unchanged replays would ring.
function chooseLiveActivityDelivery(input: {
  readonly target: LiveActivities.TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
  readonly replay?: boolean;
}): ChosenLiveActivityDelivery | "suppressed" | null {
  const preferences = parsePreferences(input.target.preferences_json);
  if (preferences?.liveActivitiesEnabled === false) {
    return input.target.activity_push_token
      ? {
          kind: "live_activity_end",
          token: input.target.activity_push_token,
          aggregate: null,
          alert: null,
        }
      : null;
  }
  if (!input.target.activity_push_token) {
    return null;
  }
  if (input.aggregate === null) {
    // Registration replay can precede a new thread's first publish; preserve a freshly armed card until state arrives.
    const armedAtMs = Option.match(
      input.target.remote_started_at === null
        ? Option.none()
        : DateTime.make(input.target.remote_started_at),
      { onNone: () => null, onSome: (dt) => dt.epochMilliseconds },
    );
    if (armedAtMs !== null && input.nowMs - armedAtMs < FRESHLY_ARMED_GRACE_MS) {
      return null;
    }
    return {
      kind: "live_activity_end",
      token: input.target.activity_push_token,
      aggregate: null,
      alert: null,
    };
  }
  const nextAggregate = input.aggregate;
  const previousAggregate = parseAggregate(input.target.last_aggregate_json);
  return shouldUpdateLiveActivity({
    previousAggregate,
    nextAggregate,
    lastDeliveryAt: input.target.last_live_activity_delivery_at,
    nowMs: input.nowMs,
  })
    ? {
        kind: "live_activity_update",
        token: input.target.activity_push_token,
        aggregate: nextAggregate,
        alert: input.replay
          ? null
          : (alertForAttentionTransition({
              previousAggregate,
              nextAggregate,
              preferences,
            }) ??
            alertForNewlyTerminal({
              previousAggregate,
              nextAggregate,
              preferences,
              nowMs: input.nowMs,
              includeUnobserved: true,
            })),
      }
    : "suppressed";
}

export function chooseDelivery(input: {
  readonly target: LiveActivities.TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
  readonly replay?: boolean;
}): ChosenDelivery | null {
  const liveActivityDelivery = chooseLiveActivityDelivery(input);
  if (liveActivityDelivery === "suppressed") {
    return null;
  }
  if (liveActivityDelivery) {
    return liveActivityDelivery;
  }
  const notification = input.replay ? null : notificationForAggregate(input);
  return notification && input.target.push_token
    ? {
        kind: "push_notification" as const,
        token: input.target.push_token,
        notification,
      }
    : null;
}
