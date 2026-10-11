/**
 * Turns Socket Mode envelopes into gateway calls, and gateway deliveries into Slack posts.
 *
 * Envelopes are acknowledged only after the gateway has durably stored the input (or its
 * notice). When the gateway reports `persistence_failed` the envelope is left unacknowledged
 * so Slack redelivers it; the dedupe key keeps that redelivery from running twice.
 *
 * @module SlackChannelAdapter
 */
import { ChannelGatewayError, type ChannelDeliveryErrorCode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as ChannelGateway from "../ChannelGateway.ts";
import type { ChannelIngressContext } from "../ChannelIngressContext.ts";
import type * as ChannelTransport from "../ChannelTransport.ts";
import {
  classifySlackEvent,
  slackActor,
  slackReplyAddress,
  toSlackInboundMessage,
  type SlackClassifierConfig,
} from "./slackEventMapping.ts";
import { formatSlackOutboundText } from "./slackMessageFormatting.ts";
import {
  slackCall,
  type SlackBotApi,
  type SlackSdkFailure,
  type SlackSocketEnvelope,
} from "./SlackSdk.ts";

/** Who a Slack connection acts for: the host owner who configured it, with its ceiling. */
export type SlackConnectionOwner = Omit<ChannelIngressContext, "caller">;

function slackIngressContext(
  owner: SlackConnectionOwner,
  connectionId: string,
): ChannelIngressContext {
  return { ...owner, caller: { type: "transport", kind: "slack", connectionId } };
}

export type SlackEnvelopeHandling =
  | "ignored"
  | "team_mismatch"
  | "ingested"
  | "linked"
  | "noticed"
  | "redeliver";

export interface SlackEnvelopeOutcome {
  /** Whether Slack was told the envelope arrived. */
  readonly acked: boolean;
  readonly handling: SlackEnvelopeHandling;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Only a storage failure leaves the envelope for Slack to redeliver. */
const shouldRedeliver = (exit: Exit.Exit<unknown, ChannelGatewayError>) =>
  Exit.isFailure(exit) &&
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => true,
    onSome: (error) => error.reason === "persistence_failed",
  });

export const handleSlackEnvelope = (
  envelope: SlackSocketEnvelope,
  input: {
    readonly connectionId: string;
    readonly classifier: SlackClassifierConfig;
    readonly owner: SlackConnectionOwner;
  },
): Effect.Effect<SlackEnvelopeOutcome, never, ChannelGateway.ChannelGateway> =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const context = slackIngressContext(input.owner, input.connectionId);
    const classification =
      envelope.type === "events_api"
        ? classifySlackEvent(envelope.body, input.classifier)
        : ({ _tag: "ignored", reason: "not_event_callback" } as const);

    let handling: SlackEnvelopeHandling;
    let exit: Exit.Exit<unknown, ChannelGatewayError> = Exit.void;
    switch (classification._tag) {
      case "ignored":
        handling = classification.reason === "team_mismatch" ? "team_mismatch" : "ignored";
        break;
      case "message": {
        const receivedAt = yield* nowIso;
        handling = "ingested";
        exit = yield* Effect.exit(
          gateway.ingest(
            toSlackInboundMessage(classification.event, {
              connectionId: input.connectionId,
              receivedAt,
            }),
            context,
          ),
        );
        break;
      }
      case "link":
        handling = "linked";
        exit = yield* Effect.exit(
          gateway.linkIdentity(
            {
              connectionId: input.connectionId,
              externalActorId: classification.event.userId,
              code: classification.code,
              idempotencyKey: classification.event.dedupeKey,
              replyAddress: slackReplyAddress(classification.event, input.connectionId),
            },
            context,
          ),
        );
        break;
      case "link_notice":
        handling = "noticed";
        exit = yield* Effect.exit(
          gateway.requestNotice(
            {
              connectionId: input.connectionId,
              idempotencyKey: classification.event.dedupeKey,
              replyAddress: slackReplyAddress(classification.event, input.connectionId),
              actor: slackActor(classification.event),
              notice: classification.notice,
            },
            context,
          ),
        );
        break;
    }

    if (shouldRedeliver(exit)) {
      yield* Effect.logWarning("Slack event not stored; leaving it for Slack to redeliver.");
      return { acked: false, handling: "redeliver" } satisfies SlackEnvelopeOutcome;
    }
    if (Exit.isFailure(exit)) {
      const reason = Option.match(Exit.findErrorOption(exit), {
        onNone: () => "unknown",
        onSome: (error) => error.reason,
      });
      yield* Effect.logInfo("Slack event rejected by the gateway.").pipe(
        Effect.annotateLogs({ reason }),
      );
    }
    const acked = yield* Effect.tryPromise(() => envelope.ack()).pipe(
      Effect.as(true),
      Effect.catch(() =>
        Effect.logWarning("Could not acknowledge a Slack event; Slack will redeliver it.").pipe(
          Effect.as(false),
        ),
      ),
    );
    return { acked, handling } satisfies SlackEnvelopeOutcome;
  }).pipe(Effect.annotateLogs({ connectionId: input.connectionId }));

/** The authenticated bot session a connection is currently delivering with. */
export interface SlackActiveSession {
  readonly generation: number;
  readonly teamId: string;
  readonly botUserId: string;
  readonly botApi: SlackBotApi;
}

/** Delivery failures the connection's status should show, or that end the connection. */
export interface SlackDeliveryFailureReport {
  readonly code: Extract<
    ChannelDeliveryErrorCode,
    "token_revoked" | "invalid_auth" | "not_in_channel" | "channel_not_found"
  >;
  readonly channelId: string;
}

/** How the outbox should treat a failed post: retry later, give up, or record as ambiguous. */
export function slackDeliveryError(failure: SlackSdkFailure): ChannelGatewayError {
  switch (failure.category) {
    case "rate_limited":
      return new ChannelGatewayError({
        reason: "delivery_failed",
        deliveryOutcome: "not_sent",
        deliveryErrorCode: "rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil(failure.retryAfterSeconds ?? 1)),
      });
    case "auth_revoked":
      return deliveryFailed("not_sent", "token_revoked");
    case "auth_invalid":
      return deliveryFailed("not_sent", "invalid_auth");
    case "not_in_channel":
    case "channel_not_found":
      return deliveryFailed("not_sent", failure.category);
    case "platform":
      return deliveryFailed("not_sent", "unknown");
    case "network":
      return deliveryFailed("unknown", "network");
    case "http":
    case "unconfirmed":
    case "unknown":
      return deliveryFailed("unknown", "unknown");
  }
}

const deliveryFailed = (
  deliveryOutcome: "not_sent" | "unknown",
  deliveryErrorCode: ChannelDeliveryErrorCode,
) => new ChannelGatewayError({ reason: "delivery_failed", deliveryOutcome, deliveryErrorCode });

const failureReport = (
  failure: SlackSdkFailure,
  channelId: string,
): SlackDeliveryFailureReport | undefined => {
  switch (failure.category) {
    case "auth_revoked":
      return { code: "token_revoked", channelId };
    case "auth_invalid":
      return { code: "invalid_auth", channelId };
    case "not_in_channel":
    case "channel_not_found":
      return { code: failure.category, channelId };
    default:
      return undefined;
  }
};

/**
 * The one Slack transport. It routes each delivery to the connection named in its reply
 * address, posting into the original thread and tagging the requester.
 */
export function makeSlackChannelTransport(input: {
  readonly activeSession: (
    connectionId: string,
  ) => Effect.Effect<Option.Option<SlackActiveSession>>;
  /** Ignored by the runtime unless `generation` is still the connection's current one. */
  readonly reportFailure: (
    connectionId: string,
    generation: number,
    report: SlackDeliveryFailureReport,
  ) => Effect.Effect<void>;
}): ChannelTransport.ChannelTransport {
  return {
    kind: "slack",
    send: (message) =>
      Effect.gen(function* () {
        const destination = message.destination;
        if (destination.kind !== "slack") {
          return yield* new ChannelGatewayError({ reason: "invalid_input" });
        }
        const session = yield* input.activeSession(destination.connectionId);
        if (Option.isNone(session)) {
          return yield* new ChannelGatewayError({ reason: "adapter_unavailable" });
        }
        const active = session.value;
        if (destination.teamId !== active.teamId) {
          return yield* deliveryFailed("not_sent", "unknown");
        }
        const text = formatSlackOutboundText({
          text: message.text,
          mentionUserId: message.mentionActorId,
        });
        const post = { channel: destination.channelId, threadTs: destination.rootTs, text };
        const posted = yield* slackCall("chat.postMessage", () =>
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack's chat.postMessage, not window.postMessage.
          active.botApi.postMessage(post),
        ).pipe(
          Effect.catch((failure) => {
            const report = failureReport(failure, destination.channelId);
            return (
              report === undefined
                ? Effect.void
                : input.reportFailure(destination.connectionId, active.generation, report)
            ).pipe(Effect.andThen(Effect.fail(slackDeliveryError(failure))));
          }),
        );
        return {
          deliveryId: message.deliveryId,
          acceptedAt: yield* nowIso,
          externalMessageId: posted.ts,
        };
      }).pipe(Effect.annotateLogs({ channelKind: message.destination.kind })),
  };
}
