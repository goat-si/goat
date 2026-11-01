import {
  parseAggregate,
  parsePreferences,
  notificationForAggregate,
  chooseDelivery,
} from "./apnsDeliverySelection.ts";
import * as DeliveryAuthorization from "./DeliveryAuthorization.ts";
import { RelayAuthorizationUnavailableError } from "@goat/contracts/relayErrors";
import type {
  RelayAgentActivityAggregateState,
  RelayDeliveryKind,
  RelayDeliveryResult,
} from "@goat/contracts/relay";
import { RelayDeliveryKind as RelayDeliveryKindSchema } from "@goat/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  isExpiredAgentActivityState,
  isTerminalPhase,
  sanitizeAgentActivityAggregateState,
  sanitizeApnsNotificationPayload,
} from "./agentActivityPayloads.ts";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import * as Apns from "./ApnsClient.ts";
import {
  ApnsDeliveryJobLiveActivityAggregateMissing,
  ApnsDeliveryJobPushNotificationMissing,
  ApnsDeliveryJobQueuePayloadInvalid,
  type ApnsLiveActivityAlert,
  type ApnsNotificationPayload,
  SignedApnsDeliveryJob,
  isApnsDeliveryJobVerificationError,
  verifySignedApnsDeliveryJob,
  type ApnsDeliveryJobVerificationError,
} from "./apnsDeliveryJobs.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import { withSpanAttributes } from "../observability.ts";

import {
  alertForAttentionTransition,
  alertForNewlyTerminal,
  alertForTerminalAggregate,
  shouldAlertForActivity,
} from "./agentActivityAlerts.ts";
export {
  alertForAttentionTransition,
  alertForNewlyTerminal,
  alertForTerminalAggregate,
} from "./agentActivityAlerts.ts";

const PERMANENT_APNS_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

type LiveActivityDeliveryKind = Extract<
  RelayDeliveryKind,
  "live_activity_start" | "live_activity_update" | "live_activity_end"
>;

export type ApnsDeliveryError =
  | RelayAuthorizationUnavailableError
  | ApnsDeliveryQueue.ApnsDeliveryQueueError
  | ApnsDeliveryJobVerificationError
  | ApnsDeliveryJobClaimInFlight
  | DeliveryAttempts.DeliveryAttemptRecordPersistenceError
  | LiveActivities.LiveActivityTargetListPersistenceError
  | LiveActivities.LiveActivityDeliveryMarkPersistenceError;

export class ApnsDeliveryJobClaimInFlight extends Schema.TaggedError<ApnsDeliveryJobClaimInFlight>()(
  "ApnsDeliveryJobClaimInFlight",
  {
    sourceJobId: Schema.String,
  },
) {
  override get message(): string {
    return `APNs delivery job '${this.sourceJobId}' is already in flight`;
  }
}

export class ApnsDeliveryTransportError extends Schema.TaggedError<ApnsDeliveryTransportError>()(
  "ApnsDeliveryTransportError",
  {
    deviceId: Schema.String,
    kind: RelayDeliveryKindSchema,
    sourceJobId: Schema.NullOr(Schema.String),
    apnsErrorTag: Schema.Literals([
      "ApnsJwtEncodingError",
      "ApnsJwtSigningError",
      "ApnsHttpRequestError",
    ]),
    requestStage: Schema.NullOr(Schema.Literals(["send", "read-response"])),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `APNs ${this.kind} delivery failed for device ${this.deviceId}.`;
  }
}

export const isApnsDeliveryTransportError = Schema.is(ApnsDeliveryTransportError);
const decodeSignedApnsDeliveryJob = Schema.decodeUnknownEffect(SignedApnsDeliveryJob);

function deliveryEvent(kind: LiveActivityDeliveryKind): Apns.ApnsLiveActivityEvent {
  switch (kind) {
    case "live_activity_start":
      return "start";
    case "live_activity_update":
      return "update";
    case "live_activity_end":
      return "end";
  }
}

function isPermanentApnsTokenFailure(result: Apns.ApnsDeliveryResult): boolean {
  return (
    !result.ok &&
    (result.status === 410 ||
      (result.status === 400 &&
        result.reason !== undefined &&
        PERMANENT_APNS_TOKEN_REASONS.has(result.reason)))
  );
}

function duplicateJobResult(input: {
  readonly deviceId: string;
  readonly kind: RelayDeliveryKind;
}): RelayDeliveryResult {
  return {
    deviceId: input.deviceId,
    kind: input.kind,
    ok: true,
    apnsStatus: null,
    apnsReason: "Duplicate APNs delivery job skipped.",
    apnsId: null,
  };
}

function staleJobResult(input: {
  readonly deviceId: string;
  readonly kind: RelayDeliveryKind;
}): RelayDeliveryResult {
  return {
    deviceId: input.deviceId,
    kind: input.kind,
    ok: true,
    apnsStatus: null,
    apnsReason: "Stale APNs delivery job skipped.",
    apnsId: null,
  };
}

function deliveryAttemptOutcome(result: Apns.ApnsDeliveryResult) {
  return {
    ...(result.status === 0 ? {} : { apnsStatus: result.status }),
    ...(result.reason === undefined ? {} : { apnsReason: result.reason }),
    apnsId: result.apnsId,
    ...(result.status === 0 ? { transportError: result.reason ?? "APNs request failed." } : {}),
  };
}

const recoverApnsDeliveryTransportError = (
  input: {
    readonly deviceId: string;
    readonly kind: RelayDeliveryKind;
    readonly sourceJobId: string | null;
  },
  cause: Apns.ApnsError,
): Effect.Effect<Apns.ApnsDeliveryResult> => {
  const error = new ApnsDeliveryTransportError({
    deviceId: input.deviceId,
    kind: input.kind,
    sourceJobId: input.sourceJobId,
    apnsErrorTag: cause._tag,
    requestStage: cause._tag === "ApnsHttpRequestError" ? cause.stage : null,
    cause,
  });
  return Effect.logError(error.message).pipe(
    Effect.annotateLogs({
      error: Redacted.make(error, { label: error._tag }),
      "error.type": error._tag,
      "error.apns_error_tag": error.apnsErrorTag,
      ...(error.requestStage === null ? {} : { "error.request_stage": error.requestStage }),
      ...(error.stack === undefined ? {} : { "error.stack": error.stack }),
      "relay.mobile.device_id": error.deviceId,
      "relay.delivery.kind": error.kind,
      ...(error.sourceJobId === null ? {} : { "relay.delivery.job_id": error.sourceJobId }),
    }),
    Effect.as({
      ok: false,
      status: 0,
      reason: cause.message,
      apnsId: null,
    }),
  );
};

interface LiveActivityDeliveryTarget {
  readonly account_epoch: number | null;
  readonly user_id: string;
  readonly device_id: string;
  readonly bundle_id?: string | null;
  readonly aps_environment?: "sandbox" | "production" | null;
}

// Bundle ids and APS environments vary by build; route per device to avoid DeviceTokenNotForTopic/BadDeviceToken.
function credentialsForTarget(
  credentials: RelayConfiguration.ApnsCredentials,
  target: LiveActivityDeliveryTarget,
): RelayConfiguration.ApnsCredentials {
  return {
    ...credentials,
    ...(target.bundle_id ? { bundleId: target.bundle_id } : {}),
    ...(target.aps_environment ? { environment: target.aps_environment } : {}),
  };
}

function expectedCurrentToken(input: {
  readonly target: LiveActivities.TargetRow;
  readonly kind: RelayDeliveryKind;
}): string | null {
  switch (input.kind) {
    case "live_activity_start":
      return input.target.push_to_start_token;
    case "live_activity_update":
    case "live_activity_end":
      return input.target.activity_push_token;
    case "push_notification":
      return input.target.push_token;
  }
}

interface SendLiveActivityDeliveryInputBase {
  readonly target: LiveActivityDeliveryTarget;
  readonly token: string;
  readonly sourceJobId?: string | null;
}

export type SendLiveActivityDeliveryInput =
  | (SendLiveActivityDeliveryInputBase & {
      readonly kind: "live_activity_start" | "live_activity_update";
      readonly aggregate: RelayAgentActivityAggregateState;
      readonly alert?: ApnsLiveActivityAlert | null;
    })
  | (SendLiveActivityDeliveryInputBase & {
      readonly kind: "live_activity_end";
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly alert?: ApnsLiveActivityAlert | null;
    });

function makeLiveActivityDeliveryRequest(
  apns: Apns.ApnsClient["Service"],
  input: SendLiveActivityDeliveryInput,
  now: DateTime.DateTime,
) {
  const epochSeconds = Math.floor(now.epochMilliseconds / 1_000);
  const base = {
    token: input.token,
    nowEpochSeconds: epochSeconds,
    nowIso: DateTime.formatIso(now),
  };
  switch (input.kind) {
    case "live_activity_start":
    case "live_activity_update":
      return {
        epochSeconds,
        iso: base.nowIso,
        request: apns.makeLiveActivityRequest({
          ...base,
          event: deliveryEvent(input.kind),
          state: input.aggregate,
          alert: input.alert ?? null,
        }),
      };
    case "live_activity_end":
      return {
        epochSeconds,
        iso: base.nowIso,
        request: apns.makeLiveActivityRequest({
          ...base,
          event: "end",
          state: input.aggregate,
          alert: input.alert ?? null,
        }),
      };
  }
}

export class ApnsDeliveries extends Context.Service<
  ApnsDeliveries,
  {
    readonly sendForTarget: (input: {
      readonly target: LiveActivities.TargetRow;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly nowMs: number;
      readonly replay?: boolean;
    }) => Effect.Effect<RelayDeliveryResult | null, ApnsDeliveryError>;
    readonly sendPushNotificationForTarget: (input: {
      readonly target: LiveActivities.TargetRow;
      readonly aggregate: RelayAgentActivityAggregateState | null;
    }) => Effect.Effect<RelayDeliveryResult | null, ApnsDeliveryError>;
    readonly sendLiveActivity: (
      input: SendLiveActivityDeliveryInput,
    ) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
    readonly processSignedJob: (
      body: unknown,
    ) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
    readonly sendPushNotification: (input: {
      readonly target: LiveActivityDeliveryTarget;
      readonly token: string;
      readonly sourceJobId?: string | null;
      readonly notification: ApnsNotificationPayload;
    }) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
  }
>()("goat-relay/agentActivity/ApnsDeliveries") {}

export const make = Effect.gen(function* () {
  const attempts = yield* DeliveryAttempts.DeliveryAttempts;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const deliveryQueue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
  const authorization = yield* DeliveryAuthorization.DeliveryAuthorization;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const apns = yield* Apns.ApnsClient;
  const activityRows = yield* AgentActivityRows.AgentActivityRows;

  // Recheck queued starts against newer terminal publishes. Fail open on database errors.
  const userStillHasLiveWork = Effect.fnUntraced(function* (userId: string) {
    const now = yield* DateTime.now;
    return yield* activityRows.listForUser({ userId }).pipe(
      Effect.map((states) =>
        states.some(
          (state) =>
            !isTerminalPhase(state) && !isExpiredAgentActivityState(state, now.epochMilliseconds),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("live-work recheck failed; allowing queued start", { cause }).pipe(
          Effect.as(true),
        ),
      ),
    );
  });

  const userHasContentToShow = Effect.fnUntraced(function* (userId: string) {
    const now = yield* DateTime.now;
    return yield* activityRows.listForUser({ userId }).pipe(
      Effect.map(
        (activeStates) =>
          makeAggregateState({
            activeStates,
            terminalState: null,
            nowMs: now.epochMilliseconds,
          }) !== null,
      ),
      // Keep the card on persistence failures; a later sweep can retry.
      Effect.catch((error) =>
        Effect.logWarning("Content recheck failed; keeping the card", { error }).pipe(
          Effect.as(true),
        ),
      ),
    );
  });

  const stateIdentityIsCurrent = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly threadId: string;
    readonly phase: RelayAgentActivityAggregateState["activities"][number]["phase"];
    readonly updatedAt: string;
  }) {
    return yield* activityRows
      .getForUserThread({
        userId: input.userId,
        environmentId: input.environmentId,
        threadId: input.threadId,
      })
      .pipe(
        Effect.map(
          (current) =>
            current !== null &&
            current.phase === input.phase &&
            current.updatedAt === input.updatedAt,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("agent-activity state recheck failed; allowing queued delivery", {
            cause,
            environmentId: input.environmentId,
            threadId: input.threadId,
          }).pipe(Effect.as(true)),
        ),
      );
  });

  const aggregateRowsAreCurrent = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly aggregate: RelayAgentActivityAggregateState;
  }) {
    return yield* activityRows.listForUser({ userId: input.userId }).pipe(
      Effect.map((currentStates) => {
        const currentByThread = new Map(
          currentStates.map((current) => [
            `${current.environmentId}\u0000${current.threadId}`,
            current,
          ]),
        );
        return input.aggregate.activities.every((row) => {
          const current = currentByThread.get(`${row.environmentId}\u0000${row.threadId}`);
          return (
            current !== undefined &&
            current.phase === row.phase &&
            current.updatedAt === row.updatedAt
          );
        });
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("agent-activity aggregate recheck failed; allowing queued delivery", {
          cause,
          userId: input.userId,
        }).pipe(Effect.as(true)),
      ),
    );
  });

  const notificationStateIsCurrent = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly notification: ApnsNotificationPayload;
  }) {
    if (input.notification.phase === undefined || input.notification.updatedAt === undefined) {
      return true;
    }
    return yield* stateIdentityIsCurrent({
      userId: input.userId,
      environmentId: input.notification.environmentId,
      threadId: input.notification.threadId,
      phase: input.notification.phase,
      updatedAt: input.notification.updatedAt,
    });
  });

  const currentSignedJobTarget = Effect.fnUntraced(function* (input: {
    readonly target: LiveActivityDeliveryTarget;
    readonly kind: RelayDeliveryKind;
    readonly token: string;
  }) {
    return yield* liveActivities.listTargets({ userId: input.target.user_id }).pipe(
      Effect.map((targets) => {
        const currentTarget = targets.find((row) => row.device_id === input.target.device_id);
        return currentTarget &&
          expectedCurrentToken({ target: currentTarget, kind: input.kind }) === input.token
          ? currentTarget
          : null;
      }),
    );
  });

  const sendLiveActivity: ApnsDeliveries["Service"]["sendLiveActivity"] = Effect.fn(
    "relay.apns_deliveries.send_live_activity",
  )(
    function* (input) {
      if (!config.apns) {
        return {
          deviceId: input.target.device_id,
          kind: input.kind,
          ok: false,
          apnsStatus: null,
          apnsReason: "APNs is disabled for this relay.",
          apnsId: null,
        };
      }
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.target.device_id,
        "relay.delivery.kind": input.kind,
        ...(input.sourceJobId ? { "relay.delivery.job_id": input.sourceJobId } : {}),
      });
      let deliveryTarget = input.target;
      const now = yield* DateTime.now;
      const aggregate =
        input.aggregate === null ? null : sanitizeAgentActivityAggregateState(input.aggregate);
      let alert = input.alert ?? null;
      const recoverTransportError = (cause: Apns.ApnsError) =>
        recoverApnsDeliveryTransportError(
          {
            deviceId: input.target.device_id,
            kind: input.kind,
            sourceJobId: input.sourceJobId ?? null,
          },
          cause,
        );
      if (input.sourceJobId) {
        const claim = yield* attempts.claimSourceJob({
          accountEpoch: input.target.account_epoch,
          userId: input.target.user_id,
          environmentId: null,
          threadId: null,
          deviceId: input.target.device_id,
          kind: input.kind,
          sourceJobId: input.sourceJobId,
          token: input.token,
        });
        if (claim === "completed") {
          return duplicateJobResult({ deviceId: input.target.device_id, kind: input.kind });
        }
        if (claim === "in_flight") {
          return yield* new ApnsDeliveryJobClaimInFlight({ sourceJobId: input.sourceJobId });
        }
        const currentTarget = yield* currentSignedJobTarget({
          target: input.target,
          kind: input.kind,
          token: input.token,
        });
        if (!currentTarget) {
          yield* attempts.completeSourceJob({
            sourceJobId: input.sourceJobId,
            apnsReason: "Stale APNs delivery job skipped.",
          });
          return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
        }
        deliveryTarget = currentTarget;
        if (alert) {
          const preferences = parsePreferences(currentTarget.preferences_json);
          const previousAggregate = parseAggregate(currentTarget.last_aggregate_json);
          alert =
            !preferences?.notificationsEnabled || !aggregate
              ? null
              : (alertForAttentionTransition({
                  previousAggregate,
                  nextAggregate: aggregate,
                  preferences,
                }) ??
                alertForNewlyTerminal({
                  previousAggregate,
                  nextAggregate: aggregate,
                  preferences,
                  nowMs: now.epochMilliseconds,
                  includeUnobserved: true,
                }));
        }
        if (
          input.kind !== "live_activity_start" &&
          aggregate !== null &&
          !(yield* aggregateRowsAreCurrent({
            userId: input.target.user_id,
            aggregate,
          }))
        ) {
          yield* attempts.completeSourceJob({
            sourceJobId: input.sourceJobId,
            apnsReason: "Stale agent activity state skipped.",
          });
          return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
        }
        // A contentless end must not retire a card that newer work now owns. An
        // end for a device that turned Live Activities off still goes out.
        if (
          input.kind === "live_activity_end" &&
          aggregate === null &&
          parsePreferences(currentTarget.preferences_json)?.liveActivitiesEnabled !== false &&
          (yield* userHasContentToShow(input.target.user_id))
        ) {
          yield* attempts.completeSourceJob({
            sourceJobId: input.sourceJobId,
            apnsReason: "Stale APNs end job skipped.",
          });
          return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
        }
      }
      if (
        input.kind === "live_activity_start" &&
        !(yield* userStillHasLiveWork(input.target.user_id))
      ) {
        yield* liveActivities.clearStartQueued({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
        });
        if (input.sourceJobId) {
          yield* attempts.completeSourceJob({
            sourceJobId: input.sourceJobId,
            apnsReason: "Stale APNs start job skipped.",
          });
        }
        return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
      }
      const { epochSeconds, iso, request } = makeLiveActivityDeliveryRequest(
        apns,
        { ...input, aggregate, alert } as SendLiveActivityDeliveryInput,
        now,
      );
      if (
        !(yield* authorization.eligible({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          accountEpoch: input.target.account_epoch,
          token: input.token,
          kind: input.kind,
        }))
      )
        return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
      const result = yield* apns
        .sendLiveActivityRequest({
          credentials: credentialsForTarget(config.apns, deliveryTarget),
          request,
          issuedAtUnixSeconds: epochSeconds,
        })
        .pipe(
          Effect.catchTags({
            ApnsJwtEncodingError: recoverTransportError,
            ApnsJwtSigningError: recoverTransportError,
            ApnsHttpRequestError: recoverTransportError,
          }),
        );
      if (result.ok) {
        yield* liveActivities.markDelivery({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          kind: input.kind,
          aggregate,
          deliveredAt: iso,
        });
      } else if (isPermanentApnsTokenFailure(result)) {
        yield* liveActivities.invalidateDeliveryToken({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          kind: input.kind,
          invalidatedAt: iso,
        });
      } else if (input.kind === "live_activity_start") {
        yield* liveActivities.clearStartQueued({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
        });
      }
      if (input.sourceJobId) {
        yield* attempts.completeSourceJob({
          sourceJobId: input.sourceJobId,
          ...deliveryAttemptOutcome(result),
        });
      } else {
        yield* attempts.record({
          accountEpoch: input.target.account_epoch,
          userId: input.target.user_id,
          environmentId: null,
          threadId: null,
          deviceId: input.target.device_id,
          kind: input.kind,
          token: input.token,
          ...deliveryAttemptOutcome(result),
        });
      }
      return {
        deviceId: input.target.device_id,
        kind: input.kind,
        ok: result.ok,
        apnsStatus: result.status === 0 ? null : result.status,
        apnsReason: result.reason ?? null,
        apnsId: result.apnsId,
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.provideService(DeliveryAuthorization.DeliveryContext, {
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          accountEpoch: input.target.account_epoch,
          token: input.token,
          kind: input.kind,
        }),
      ),
  );

  const sendPushNotification: ApnsDeliveries["Service"]["sendPushNotification"] = Effect.fn(
    "relay.apns_deliveries.send_push_notification",
  )(
    function* (input) {
      if (!config.apns) {
        return {
          deviceId: input.target.device_id,
          kind: "push_notification" as const,
          ok: false,
          apnsStatus: null,
          apnsReason: "APNs is disabled for this relay.",
          apnsId: null,
        };
      }
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.target.device_id,
        "relay.delivery.kind": "push_notification",
        ...(input.sourceJobId ? { "relay.delivery.job_id": input.sourceJobId } : {}),
      });
      let deliveryTarget = input.target;
      const now = yield* DateTime.now;
      const epochSeconds = Math.floor(now.epochMilliseconds / 1_000);
      const notification = sanitizeApnsNotificationPayload(input.notification);
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": notification.environmentId,
        "relay.thread_id": notification.threadId,
      });
      const request = apns.makePushNotificationRequest({
        token: input.token,
        notification,
      });
      const recoverTransportError = (cause: Apns.ApnsError) =>
        recoverApnsDeliveryTransportError(
          {
            deviceId: input.target.device_id,
            kind: "push_notification" as const,
            sourceJobId: input.sourceJobId ?? null,
          },
          cause,
        );
      if (input.sourceJobId) {
        const claim = yield* attempts.claimSourceJob({
          accountEpoch: input.target.account_epoch,
          userId: input.target.user_id,
          environmentId: notification.environmentId,
          threadId: notification.threadId,
          deviceId: input.target.device_id,
          kind: "push_notification" as const,
          sourceJobId: input.sourceJobId,
          token: input.token,
        });
        if (claim === "completed") {
          return duplicateJobResult({
            deviceId: input.target.device_id,
            kind: "push_notification" as const,
          });
        }
        if (claim === "in_flight") {
          return yield* new ApnsDeliveryJobClaimInFlight({ sourceJobId: input.sourceJobId });
        }
        const currentTarget = yield* currentSignedJobTarget({
          target: input.target,
          kind: "push_notification" as const,
          token: input.token,
        });
        if (!currentTarget) {
          yield* attempts.completeSourceJob({
            sourceJobId: input.sourceJobId,
            apnsReason: "Stale APNs delivery job skipped.",
          });
          return staleJobResult({
            deviceId: input.target.device_id,
            kind: "push_notification" as const,
          });
        }
        if (
          !(yield* notificationStateIsCurrent({
            userId: input.target.user_id,
            notification,
          }))
        ) {
          yield* attempts.completeSourceJob({
            sourceJobId: input.sourceJobId,
            apnsReason: "Stale agent activity state skipped.",
          });
          return staleJobResult({
            deviceId: input.target.device_id,
            kind: "push_notification" as const,
          });
        }
        deliveryTarget = currentTarget;
        const preferences = parsePreferences(currentTarget.preferences_json);
        const alertAllowed =
          notification.phase !== undefined && notification.updatedAt !== undefined
            ? shouldAlertForActivity({
                ...notification,
                phase: notification.phase,
                updatedAt: notification.updatedAt,
                preferences,
                nowMs: now.epochMilliseconds,
              })
            : preferences?.notificationsEnabled === true;
        if (!alertAllowed) {
          yield* attempts.completeSourceJob({
            sourceJobId: input.sourceJobId,
            apnsReason: "Notification is disabled or no longer fresh.",
          });
          return staleJobResult({ deviceId: input.target.device_id, kind: "push_notification" });
        }
      }
      if (
        !(yield* authorization.eligible({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          accountEpoch: input.target.account_epoch,
          token: input.token,
          kind: "push_notification" as const,
        }))
      )
        return staleJobResult({ deviceId: input.target.device_id, kind: "push_notification" });
      const result = yield* apns
        .sendPushNotificationRequest({
          credentials: credentialsForTarget(config.apns, deliveryTarget),
          request,
          issuedAtUnixSeconds: epochSeconds,
        })
        .pipe(
          Effect.catchTags({
            ApnsJwtEncodingError: recoverTransportError,
            ApnsJwtSigningError: recoverTransportError,
            ApnsHttpRequestError: recoverTransportError,
          }),
        );
      if (isPermanentApnsTokenFailure(result)) {
        yield* liveActivities.invalidateDeliveryToken({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          kind: "push_notification" as const,
          invalidatedAt: DateTime.formatIso(now),
        });
      }
      if (input.sourceJobId) {
        yield* attempts.completeSourceJob({
          sourceJobId: input.sourceJobId,
          ...deliveryAttemptOutcome(result),
        });
      } else {
        yield* attempts.record({
          accountEpoch: input.target.account_epoch,
          userId: input.target.user_id,
          environmentId: notification.environmentId,
          threadId: notification.threadId,
          deviceId: input.target.device_id,
          kind: "push_notification" as const,
          token: input.token,
          ...deliveryAttemptOutcome(result),
        });
      }
      return {
        deviceId: input.target.device_id,
        kind: "push_notification" as const,
        ok: result.ok,
        apnsStatus: result.status === 0 ? null : result.status,
        apnsReason: result.reason ?? null,
        apnsId: result.apnsId,
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.provideService(DeliveryAuthorization.DeliveryContext, {
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          accountEpoch: input.target.account_epoch,
          token: input.token,
          kind: "push_notification" as const,
        }),
      ),
  );

  const processSignedJob: ApnsDeliveries["Service"]["processSignedJob"] = Effect.fn(
    "relay.apns_deliveries.process_signed_job",
  )(function* (body) {
    const signedJob = yield* decodeSignedApnsDeliveryJob(body).pipe(
      Effect.mapError(
        (cause) =>
          new ApnsDeliveryJobQueuePayloadInvalid({
            receivedType: Array.isArray(body) ? "array" : body === null ? "null" : typeof body,
            cause,
          }),
      ),
    );
    const now = yield* DateTime.now;
    const payload = verifySignedApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      job: signedJob,
      nowMs: now.epochMilliseconds,
    });
    if (isApnsDeliveryJobVerificationError(payload)) {
      return yield* payload;
    }
    if (
      !(yield* authorization.eligible({
        userId: payload.target.userId,
        deviceId: payload.target.deviceId,
        accountEpoch: payload.target.accountEpoch,
        token: payload.target.token,
        kind: payload.kind,
      }))
    )
      return staleJobResult({ deviceId: payload.target.deviceId, kind: payload.kind });
    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": payload.target.deviceId,
      "relay.delivery.kind": payload.kind,
      "relay.delivery.job_id": payload.jobId,
    });
    return yield* Effect.suspend(() => {
      switch (payload.kind) {
        case "live_activity_start":
        case "live_activity_update":
          if (payload.aggregate === null) {
            return Effect.fail(
              new ApnsDeliveryJobLiveActivityAggregateMissing({
                jobId: payload.jobId,
                kind: payload.kind,
                userId: payload.target.userId,
                deviceId: payload.target.deviceId,
              }),
            );
          }
          return sendLiveActivity({
            target: {
              user_id: payload.target.userId,
              account_epoch: payload.target.accountEpoch,
              device_id: payload.target.deviceId,
              bundle_id: payload.target.bundleId ?? null,
              aps_environment: payload.target.apsEnvironment ?? null,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            kind: payload.kind,
            aggregate: payload.aggregate,
            alert: payload.alert ?? null,
          });
        case "live_activity_end":
          return sendLiveActivity({
            target: {
              user_id: payload.target.userId,
              account_epoch: payload.target.accountEpoch,
              device_id: payload.target.deviceId,
              bundle_id: payload.target.bundleId ?? null,
              aps_environment: payload.target.apsEnvironment ?? null,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            kind: payload.kind,
            aggregate: payload.aggregate,
            alert: payload.alert ?? null,
          });
        case "push_notification":
          if (payload.notification === null) {
            return Effect.fail(
              new ApnsDeliveryJobPushNotificationMissing({
                jobId: payload.jobId,
                userId: payload.target.userId,
                deviceId: payload.target.deviceId,
              }),
            );
          }
          return sendPushNotification({
            target: {
              user_id: payload.target.userId,
              account_epoch: payload.target.accountEpoch,
              device_id: payload.target.deviceId,
              bundle_id: payload.target.bundleId ?? null,
              aps_environment: payload.target.apsEnvironment ?? null,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            notification: payload.notification,
          });
      }
    }).pipe(withSpanAttributes({ "user.id": payload.target.userId }));
  });

  return ApnsDeliveries.of({
    sendLiveActivity,
    sendPushNotification,
    processSignedJob,
    sendPushNotificationForTarget: Effect.fnUntraced(function* (input) {
      if (!config.apns || input.target.account_epoch === null) return null;
      const now = yield* DateTime.now;
      const notification = notificationForAggregate({
        target: input.target,
        aggregate: input.aggregate,
        nowMs: now.epochMilliseconds,
      });
      const token = input.target.push_token;
      return yield* notification && token
        ? deliveryQueue.enqueuePushNotification({
            userId: input.target.user_id,
            accountEpoch: input.target.account_epoch,
            deviceId: input.target.device_id,
            token,
            bundleId: input.target.bundle_id,
            apsEnvironment: input.target.aps_environment,
            notification,
          })
        : Effect.succeed(null);
    }),
    sendForTarget: Effect.fnUntraced(function* (input) {
      if (!config.apns || input.target.account_epoch === null) return null;
      const delivery = chooseDelivery({
        target: input.target,
        aggregate: input.aggregate,
        nowMs: input.nowMs,
        replay: input.replay ?? false,
      });
      if (!delivery) {
        return null;
      }
      if (delivery.kind === "push_notification") {
        const result = yield* deliveryQueue.enqueuePushNotification({
          userId: input.target.user_id,
          accountEpoch: input.target.account_epoch,
          deviceId: input.target.device_id,
          token: delivery.token,
          bundleId: input.target.bundle_id,
          apsEnvironment: input.target.aps_environment,
          notification: delivery.notification,
        });
        return result;
      }
      const notification = input.replay
        ? null
        : notificationForAggregate({
            target: input.target,
            aggregate: input.aggregate,
            nowMs: input.nowMs,
          });
      // Use the end alert only when no companion notification will ring, preserving feedback for Live-Activity-only users.
      const alert = input.replay
        ? null
        : delivery.kind === "live_activity_end"
          ? notification && input.target.push_token
            ? null
            : alertForTerminalAggregate({
                aggregate: delivery.aggregate,
                preferences: parsePreferences(input.target.preferences_json),
              })
          : delivery.alert;
      const result = yield* deliveryQueue.enqueueLiveActivity({
        userId: input.target.user_id,
        accountEpoch: input.target.account_epoch,
        deviceId: input.target.device_id,
        kind: delivery.kind,
        token: delivery.token,
        bundleId: input.target.bundle_id,
        apsEnvironment: input.target.aps_environment,
        aggregate: delivery.aggregate,
        alert,
      });
      if (delivery.kind === "live_activity_end" && notification && input.target.push_token) {
        yield* deliveryQueue.enqueuePushNotification({
          userId: input.target.user_id,
          accountEpoch: input.target.account_epoch,
          deviceId: input.target.device_id,
          token: input.target.push_token,
          bundleId: input.target.bundle_id,
          apsEnvironment: input.target.aps_environment,
          notification,
        });
      }
      if (delivery.kind === "live_activity_start") {
        const now = yield* DateTime.now;
        yield* liveActivities
          .markStartQueued({
            userId: input.target.user_id,
            deviceId: input.target.device_id,
            queuedAt: DateTime.formatIso(now),
          })
          .pipe(
            Effect.provideService(DeliveryAuthorization.DeliveryContext, {
              userId: input.target.user_id,
              deviceId: input.target.device_id,
              accountEpoch: input.target.account_epoch,
              token: delivery.token,
              kind: delivery.kind,
            }),
          );
      }
      return result;
    }),
  });
});

export const layer = Layer.effect(ApnsDeliveries, make);
