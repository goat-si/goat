/**
 * Fakes and fixtures shared by the Slack channel tests: a recording gateway, an in-memory
 * transport registry, a connection owner, and Events API payloads.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ChannelBindingId,
  ChannelConversationId,
  ChannelDeliveryId,
  ChannelInputId,
  type ChannelGatewayError,
  type ChannelIdentityLinkConsumeInput,
  type ChannelIdentityLinkConsumeResult,
  type ChannelIngestInput,
  type ChannelIngestResult,
  type ChannelKind,
  type ChannelNoticeInput,
  type ChannelNoticeReceipt,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ChannelGateway from "../ChannelGateway.ts";
import type { ChannelIngressContext } from "../ChannelIngressContext.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import type { ChannelConnectionOwner } from "../ChannelIngressContext.ts";

export const owner: ChannelConnectionOwner = {
  ownerId: "owner-1",
  principalId: "principal-owner",
  displayName: "Host Owner",
  grantedScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  runtimeModeCeiling: "auto-accept-edits",
};

export type GatewayCall =
  | {
      readonly method: "ingest";
      readonly input: ChannelIngestInput;
      readonly context: ChannelIngressContext;
    }
  | {
      readonly method: "linkIdentity";
      readonly input: ChannelIdentityLinkConsumeInput;
      readonly context: ChannelIngressContext;
    }
  | {
      readonly method: "requestNotice";
      readonly input: ChannelNoticeInput;
      readonly context: ChannelIngressContext;
    };

export const ingestResult = (
  overrides: Partial<ChannelIngestResult> = {},
): ChannelIngestResult => ({
  inputId: ChannelInputId.make("input-1"),
  conversationId: ChannelConversationId.make("conversation-1"),
  bindingId: ChannelBindingId.make("binding-1"),
  duplicate: false,
  state: "accepted",
  acceptedAt: "2026-10-12T00:00:00.000Z",
  taskIds: [],
  ...overrides,
});

export function makeFakeGateway() {
  const calls: GatewayCall[] = [];
  const script = {
    ingest: (_input: ChannelIngestInput): Effect.Effect<ChannelIngestResult, ChannelGatewayError> =>
      Effect.succeed(ingestResult()),
    linkIdentity: (
      _input: ChannelIdentityLinkConsumeInput,
    ): Effect.Effect<ChannelIdentityLinkConsumeResult, ChannelGatewayError> =>
      Effect.succeed({ principalId: "principal-alice", linkedAt: "2026-10-12T00:00:00.000Z" }),
    requestNotice: (
      _input: ChannelNoticeInput,
    ): Effect.Effect<ChannelNoticeReceipt, ChannelGatewayError> =>
      Effect.succeed({ deliveryId: ChannelDeliveryId.make("delivery-1"), duplicate: false }),
  };
  const layer = Layer.succeed(
    ChannelGateway.ChannelGateway,
    ChannelGateway.ChannelGateway.of({
      ingest: (input, context) =>
        Effect.suspend(() => {
          calls.push({ method: "ingest", input, context });
          return script.ingest(input);
        }),
      linkIdentity: (input, context) =>
        Effect.suspend(() => {
          calls.push({ method: "linkIdentity", input, context });
          return script.linkIdentity(input);
        }),
      requestNotice: (input, context) =>
        Effect.suspend(() => {
          calls.push({ method: "requestNotice", input, context });
          return script.requestNotice(input);
        }),
      send: () => Effect.die("the Slack adapter never sends through the gateway"),
      getInput: () => Effect.die("the Slack adapter never reads inputs back"),
    }),
  );
  return { layer, calls, script };
}

export function makeFakeTransportRegistry() {
  const registered = new Map<ChannelKind, ChannelTransport.ChannelTransport>();
  const layer = Layer.succeed(
    ChannelTransport.ChannelTransportRegistry,
    ChannelTransport.ChannelTransportRegistry.of({
      register: (transport) =>
        Effect.asVoid(
          Effect.acquireRelease(
            Effect.sync(() => registered.set(transport.kind, transport)),
            () => Effect.sync(() => registered.delete(transport.kind)),
          ),
        ),
      resolve: (kind) => Effect.sync(() => Option.fromNullishOr(registered.get(kind))),
    }),
  );
  return { layer, registered };
}

export const eventCallback = (
  event: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  type: "event_callback",
  team_id: "T0TEAM",
  event_id: "Ev0001AAAA",
  event,
  ...overrides,
});

export const channelMention = (overrides: Record<string, unknown> = {}) => ({
  type: "app_mention",
  channel: "C0ALLOWED",
  user: "U0ALICE",
  text: "<@U0BOT> fix the login bug",
  ts: "1760000000.000100",
  ...overrides,
});

export const directMessage = (overrides: Record<string, unknown> = {}) => ({
  type: "message",
  channel_type: "im",
  channel: "D0ALICE",
  user: "U0ALICE",
  text: "what is running?",
  ts: "1760000000.000200",
  ...overrides,
});
