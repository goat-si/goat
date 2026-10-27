import { policyUnitLayer } from "../accounts/test/PolicyUnitLayers.ts";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@goat/contracts/relay";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { type SignedApnsDeliveryJob } from "./apnsDeliveryJobs.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as ApnsClient from "./ApnsClient.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";

export const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("not-a-private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-signing-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "goat-relay",
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

const apnsSigningKeyPair = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

export const signingConfig = RelayConfiguration.RelayConfiguration.of({
  ...config,
  apns: {
    ...config.apns!,
    privateKey: Redacted.make(apnsSigningKeyPair.privateKey),
  },
});

export const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/",
};

export const aggregate: RelayAgentActivityAggregateState = {
  title: "GOAT",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: state.updatedAt,
  activities: [
    {
      environmentId: state.environmentId,
      threadId: state.threadId,
      projectTitle: state.projectTitle,
      threadTitle: state.threadTitle,
      modelTitle: state.modelTitle,
      phase: state.phase,
      status: "Working",
      updatedAt: state.updatedAt,
      deepLink: state.deepLink,
    },
  ],
};

export const enabledPreferences = JSON.stringify({
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

export const disabledPreferences = JSON.stringify({
  liveActivitiesEnabled: false,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

export const notificationsDisabledPreferences = JSON.stringify({
  liveActivitiesEnabled: false,
  notificationsEnabled: false,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

export const target: LiveActivities.TargetRow = {
  account_epoch: 1,
  user_id: "dev:alex",
  device_id: "device-1",
  platform: "ios",
  ios_major_version: 18,
  app_version: "1.0.0",
  bundle_id: null,
  aps_environment: null,
  push_token: null,
  push_to_start_token: "start-token",
  preferences_json: enabledPreferences,
  activity_push_token: "activity-token",
  remote_start_queued_at: null,
  remote_started_at: "1970-01-01T00:00:00.000Z",
  ended_at: null,
  last_aggregate_json: null,
  last_live_activity_delivery_at: null,
};

export function layerFor(input: {
  readonly attempts: Array<DeliveryAttempts.DeliveryAttemptInput>;
  readonly sourceJobClaims?: ReadonlyMap<string, DeliveryAttempts.DeliverySourceJobClaimResult>;
  readonly queuedJobs?: Array<SignedApnsDeliveryJob>;
  readonly queuedStarts?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["markStartQueued"]>[0]
  >;
  readonly clearedStarts?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["clearStartQueued"]>[0]
  >;
  readonly markedDeliveries?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["markDelivery"]>[0]
  >;
  readonly invalidatedTokens?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
  >;
  readonly currentTargets?: ReadonlyArray<LiveActivities.TargetRow>;
  readonly config?: RelayConfiguration.RelayConfiguration["Service"];
  readonly activityStates?: ReadonlyArray<RelayAgentActivityState>;
  readonly currentActivityStates?: ReadonlyArray<RelayAgentActivityState>;
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}) {
  return ApnsDeliveries.layer.pipe(
    Layer.provide(policyUnitLayer),
    Layer.provide(ApnsClient.layer),
    Layer.provide(ApnsProviderTokens.layer),
    Layer.provide(
      ApnsDeliveryQueue.layer.pipe(
        Layer.provide(policyUnitLayer),
        Layer.provide(NodeCryptoLayer.layer),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentActivityRows.AgentActivityRows, {
          upsert: () => Effect.void,
          remove: () => Effect.void,
          pruneTerminal: () => Effect.void,
          listForUser: () =>
            input.activityStates !== undefined
              ? Effect.succeed([...input.activityStates])
              : Effect.succeed([state]),
          getForUserThread: ({ environmentId, threadId }) =>
            Effect.succeed(
              (input.currentActivityStates ?? input.activityStates ?? [state]).find(
                (current) =>
                  current.environmentId === environmentId && current.threadId === threadId,
              ) ?? null,
            ),
        } satisfies AgentActivityRows.AgentActivityRows["Service"]),
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
          send: (body) =>
            Effect.sync(() => {
              input.queuedJobs?.push(body);
            }),
        }),
        Layer.succeed(DeliveryAttempts.DeliveryAttempts, {
          record: (attempt) =>
            Effect.sync(() => {
              input.attempts.push(attempt);
            }),
          claimSourceJob: (attempt) =>
            Effect.sync(() => {
              const claim = input.sourceJobClaims?.get(attempt.sourceJobId);
              if (claim) {
                return claim;
              }
              input.attempts.push(attempt);
              return "claimed";
            }),
          completeSourceJob: (completion) =>
            Effect.sync(() => {
              const attempt = input.attempts.find(
                (row) => row.sourceJobId === completion.sourceJobId,
              );
              if (attempt) {
                Object.assign(attempt, completion);
              }
            }),
        }),
        Layer.succeed(LiveActivities.LiveActivities, {
          register: () => Effect.void,
          listTargets: () => Effect.succeed(input.currentTargets ?? [target]),
          listIdleArmedTargets: () => Effect.succeed([]),
          markStartQueued: (queued) =>
            Effect.sync(() => {
              input.queuedStarts?.push(queued);
            }),
          clearStartQueued: (cleared) =>
            Effect.sync(() => {
              input.clearedStarts?.push(cleared);
            }),
          markDelivery: (delivery) =>
            Effect.sync(() => {
              input.markedDeliveries?.push(delivery);
            }),
          invalidateDeliveryToken: (invalidated) =>
            Effect.sync(() => {
              input.invalidatedTokens?.push(invalidated);
            }),
        }),
        RelayConfiguration.layer(input.config ?? config),
        input.execute
          ? Layer.succeed(HttpClient.HttpClient, HttpClient.make(input.execute))
          : FetchHttpClient.layer,
      ),
    ),
  );
}
