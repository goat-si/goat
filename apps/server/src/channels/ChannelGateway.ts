/**
 * ChannelGateway - the one entry point for channel input and identity links.
 *
 * `ingest` waits only for durable storage of the input and returns a receipt; reception,
 * ledger changes, and replies run afterwards. Input from an unlinked account returns
 * `state: "rejected"` with a link notice already committed.
 *
 * Acknowledging the transport: when a call fails with reason `persistence_failed`, adapters
 * do not acknowledge, so the transport redelivers. Every other result or error means any
 * notice was already committed, so adapters acknowledge. Adapters never send replies
 * themselves; the delivery worker does.
 *
 * @module ChannelGateway
 */
import {
  type ChannelDeliveryReceipt,
  ChannelGatewayError,
  type ChannelIdentityLinkConsumeInput,
  type ChannelIdentityLinkConsumeResult,
  type ChannelIngestInput,
  type ChannelIngestResult,
  type ChannelInputId,
  type ChannelInputSnapshot,
  type ChannelKind,
  type ChannelNoticeInput,
  type ChannelNoticeReceipt,
  type ChannelOutboundMessage,
  type ChannelReplyAddress,
  type ChannelRequester,
  type RuntimeMode,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ChannelBotTimeline from "./ChannelBotTimeline.ts";
import type { ChannelConnectionOwner, ChannelIngressContext } from "./ChannelIngressContext.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import * as ChannelWake from "./ChannelWake.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import {
  bindingIdFor,
  contentHashFor,
  conversationIdFor,
  deliveryIdFor,
  inputIdFor,
  linkCodeHashFor,
} from "./channelIds.ts";

/** The fixed connection id of the GOAT bot channel. */
export const GOAT_CONNECTION_ID = "goat";
/** The fixed connection id of agent input over MCP; the request namespace scopes it. */
export const MCP_CONNECTION_ID = "mcp";
/** The owner's GOAT bot is one conversation, also across a bot thread replaced after deletion. */
const GOAT_CONVERSATION_KEY = "goat-bot";

export class ChannelGateway extends Context.Service<
  ChannelGateway,
  {
    readonly ingest: (
      input: ChannelIngestInput,
      context: ChannelIngressContext,
    ) => Effect.Effect<ChannelIngestResult, ChannelGatewayError>;
    /**
     * Consumes a one-time link code and commits a success or failure notice to the input's reply
     * address. The code is never stored with message content.
     */
    readonly linkIdentity: (
      input: ChannelIdentityLinkConsumeInput,
      context: ChannelIngressContext,
    ) => Effect.Effect<ChannelIdentityLinkConsumeResult, ChannelGatewayError>;
    /** Commits a fixed notice, such as link help, for delivery to the reply address. */
    readonly requestNotice: (
      input: ChannelNoticeInput,
      context: ChannelIngressContext,
    ) => Effect.Effect<ChannelNoticeReceipt, ChannelGatewayError>;
    /**
     * Reads a stored input and its reply. Owners read their own inputs; an MCP caller reads only
     * inputs its request namespace sent, which is how agents get their answers.
     */
    readonly getInput: (
      inputId: ChannelInputId,
      context: ChannelIngressContext,
    ) => Effect.Effect<ChannelInputSnapshot, ChannelGatewayError>;
    /** Hands one delivery to the registered transport for its destination. */
    readonly send: (
      message: ChannelOutboundMessage,
    ) => Effect.Effect<ChannelDeliveryReceipt, ChannelGatewayError>;
  }
>()("goat/channels/ChannelGateway") {}

const RUNTIME_MODE_ORDER: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/** The lower of two runtime-mode ceilings. */
export const lowerRuntimeMode = (left: RuntimeMode, right: RuntimeMode): RuntimeMode =>
  RUNTIME_MODE_ORDER.indexOf(left) <= RUNTIME_MODE_ORDER.indexOf(right) ? left : right;

/**
 * Whether someone may answer a task's question. An answer steers work that runs under the asker's
 * ceiling, so the answerer needs to be allowed to run work and at least as far as the asker.
 * A linked channel account is a person, whom handoffs/HumanStepAuthority.ts lets resolve every
 * human step; this adds the channel's own owner, scope and ceiling checks for the target.
 */
export const mayAnswerFor = (answerer: ChannelRequester, asker: ChannelRequester): boolean =>
  answerer.ownerId === asker.ownerId &&
  answerer.grantedScopes.includes("orchestration:operate") &&
  lowerRuntimeMode(answerer.runtimeModeCeiling, asker.runtimeModeCeiling) ===
    asker.runtimeModeCeiling;

/** What a linked account may do: the connection's ceiling and the link's, whichever is lower. */
export const effectiveRequester = (
  owner: ChannelConnectionOwner,
  identity: ChannelLedger.ChannelIdentity,
  input: { readonly originKind: ChannelKind; readonly externalActorId: string },
): ChannelRequester => ({
  ownerId: owner.ownerId,
  principalId: identity.principalId,
  displayName: identity.displayName,
  originKind: input.originKind,
  externalActorId: input.externalActorId,
  runtimeModeCeiling: lowerRuntimeMode(owner.runtimeModeCeiling, identity.runtimeModeCeiling),
  grantedScopes: owner.grantedScopes.filter((scope) => identity.grantedScopes.includes(scope)),
});

const replyAddressKey = (address: ChannelReplyAddress) => {
  switch (address.kind) {
    case "goat":
      return "goat:" + address.environmentId + ":" + address.threadId;
    case "slack":
      return (
        "slack:" +
        address.connectionId +
        ":" +
        address.teamId +
        ":" +
        address.channelId +
        ":" +
        address.rootTs
      );
    case "mcp":
      return (
        "mcp:" +
        address.connectionId +
        ":" +
        address.requestNamespace +
        ":" +
        address.conversationKey
      );
    case "imessage":
      return JSON.stringify(["imessage", address.connectionId, address.chatGuid]);
  }
};

const ledgerFailure = (cause: ChannelLedger.ChannelLedgerError) =>
  new ChannelGatewayError({
    reason: cause.reason === "idempotency_conflict" ? "idempotency_conflict" : "persistence_failed",
  });

const forbidden = () => new ChannelGatewayError({ reason: "forbidden" });

/**
 * The keys an input is stored under, applied after the caller check. GOAT bot input belongs to
 * the owner's one bot conversation whichever bot thread it came from, so a replacement bot keeps
 * the history and open questions. MCP callers share one connection, so the request namespace
 * scopes their conversations and retry keys: two agents sending the same key stay two inputs in
 * two conversations.
 */
const scopedForCaller = (
  input: ChannelIngestInput,
  context: ChannelIngressContext,
): ChannelIngestInput => {
  if (input.kind === "goat") return { ...input, conversationKey: GOAT_CONVERSATION_KEY };
  if (input.kind !== "mcp" || context.caller.type !== "mcp") return input;
  const namespace = context.caller.requestNamespace;
  const scope = (key: string) => JSON.stringify([namespace, key]);
  return {
    ...input,
    conversationKey: scope(input.conversationKey),
    idempotencyKey: scope(input.idempotencyKey),
  };
};

const noticeDelivery = (
  causeKey: string,
  destination: ChannelReplyAddress,
  text: string,
  mentionActorId: string | undefined,
  inputId?: ChannelInputId,
): ChannelLedger.ChannelOutboxInsert => {
  const deliveryId = deliveryIdFor(causeKey);
  return {
    deliveryId,
    causeKey,
    ...(inputId === undefined ? {} : { inputId }),
    message: {
      deliveryId,
      destination,
      kind: "receipt",
      text,
      ...(inputId === undefined ? {} : { inReplyToInputId: inputId }),
      ...(mentionActorId === undefined ? {} : { mentionActorId }),
    },
  };
};

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const home = yield* ChannelBotHome.ChannelBotHome;
  const registry = yield* ChannelTransport.ChannelTransportRegistry;
  const timeline = yield* ChannelBotTimeline.ChannelBotTimeline;
  const wake = yield* ChannelWake.ChannelWake;

  /** Checks that the caller may speak for this channel, conversation, and reply address. */
  const checkCaller = (input: ChannelIngestInput, context: ChannelIngressContext) =>
    Effect.gen(function* () {
      const caller = context.caller;
      const address = input.replyAddress;
      if (address.kind !== input.kind) return yield* forbidden();
      switch (input.kind) {
        case "goat": {
          if (caller.type !== "rpc" && caller.type !== "intake") return yield* forbidden();
          if (address.kind !== "goat" || input.connectionId !== GOAT_CONNECTION_ID) {
            return yield* forbidden();
          }
          const bot = yield* ledger.getBot(context.ownerId).pipe(Effect.mapError(ledgerFailure));
          if (bot === undefined || bot.bot.threadId !== address.threadId) {
            return yield* forbidden();
          }
          if (input.conversationKey !== address.threadId) return yield* forbidden();
          if (input.attachments.length > 0) {
            return yield* new ChannelGatewayError({ reason: "invalid_input" });
          }
          return;
        }
        case "mcp": {
          if (caller.type !== "mcp" || address.kind !== "mcp") return yield* forbidden();
          if (
            input.connectionId !== MCP_CONNECTION_ID ||
            address.connectionId !== MCP_CONNECTION_ID ||
            address.requestNamespace !== caller.requestNamespace ||
            address.conversationKey !== input.conversationKey
          ) {
            return yield* forbidden();
          }
          return;
        }
        case "slack": {
          if (
            caller.type !== "transport" ||
            caller.kind !== "slack" ||
            caller.connectionId !== input.connectionId ||
            address.kind !== "slack" ||
            address.connectionId !== input.connectionId
          ) {
            return yield* forbidden();
          }
          return;
        }
        case "imessage": {
          if (
            caller.type !== "transport" ||
            caller.kind !== "imessage" ||
            caller.connectionId !== input.connectionId ||
            address.kind !== "imessage" ||
            address.connectionId !== input.connectionId ||
            input.conversationKey !== address.chatGuid ||
            input.attachments.length !== 0
          )
            return yield* forbidden();
          return;
        }
      }
    });

  /** Who is asking. Undefined means an unlinked transport account. */
  const resolveRequester = (input: ChannelIngestInput, context: ChannelIngressContext) =>
    Effect.gen(function* () {
      if (input.kind !== "slack" && input.kind !== "imessage") {
        const requester: ChannelRequester = {
          ownerId: context.ownerId,
          principalId: context.principalId,
          displayName: context.displayName,
          originKind: input.kind,
          ...(input.actor.externalActorId === undefined
            ? {}
            : { externalActorId: input.actor.externalActorId }),
          runtimeModeCeiling: context.runtimeModeCeiling,
          grantedScopes: [...context.grantedScopes],
        };
        return requester;
      }
      const externalActorId = input.actor.externalActorId;
      if (externalActorId === undefined) return undefined;
      const identity = yield* ledger
        .findIdentity({ connectionId: input.connectionId, externalActorId })
        .pipe(Effect.mapError(ledgerFailure));
      if (identity === undefined) return undefined;
      return effectiveRequester(context, identity, { originKind: input.kind, externalActorId });
    });

  const recordBotInput = (input: ChannelIngestInput, result: ChannelIngestResult) =>
    Effect.gen(function* () {
      if (input.replyAddress.kind !== "goat") return result;
      const sequence = yield* timeline.record({
        threadId: input.replyAddress.threadId,
        record: {
          recordKey: "input:" + result.inputId,
          entry: {
            type: "message",
            role: "user",
            text: input.text,
            meta: {
              conversationId: result.conversationId,
              originKind: "goat",
              kind: "inbound",
              inputId: result.inputId,
            },
          },
        },
        revision: "accepted",
      });
      yield* ledger
        .setTimelineSequence(result.inputId, sequence)
        .pipe(Effect.mapError(ledgerFailure));
      return { ...result, timelineSequence: sequence };
    });

  const ingest: ChannelGateway["Service"]["ingest"] = (input, context) =>
    Effect.gen(function* () {
      if (input.intent === "report") {
        // Workers report through channel_task_report, which checks their assignment.
        return yield* new ChannelGatewayError({ reason: "invalid_input" });
      }
      if (input.kind === "goat" || input.kind === "mcp" || input.kind === "imessage")
        yield* home.requireHome;
      yield* checkCaller(input, context);
      const requester = yield* resolveRequester(input, context);
      const stored = scopedForCaller(input, context);
      const conversationId = conversationIdFor({
        ownerId: context.ownerId,
        kind: stored.kind,
        connectionId: stored.connectionId,
        conversationKey: stored.conversationKey,
      });
      const inputId = inputIdFor({
        ownerId: context.ownerId,
        kind: stored.kind,
        connectionId: stored.connectionId,
        idempotencyKey: stored.idempotencyKey,
      });
      const acceptedAt = DateTime.formatIso(yield* DateTime.now);
      const result = yield* ledger
        .acceptInput({
          ownerId: context.ownerId,
          inputId,
          conversationId,
          bindingId: bindingIdFor(conversationId, replyAddressKey(input.replyAddress)),
          message: stored,
          contentHash: contentHashFor(stored),
          requester,
          acceptedAt,
          ...(requester === undefined
            ? {
                rejectNotice: noticeDelivery(
                  "unlinked:" + inputId,
                  input.replyAddress,
                  CHANNEL_COPY.unlinkedInput,
                  input.actor.externalActorId,
                  inputId,
                ),
              }
            : {}),
        })
        .pipe(Effect.mapError(ledgerFailure));
      // A retry after a crash between storing and recording finds no sequence and records again;
      // the record's ids are fixed, so the bot shows the message once.
      const recorded =
        result.timelineSequence === undefined && result.state !== "rejected"
          ? yield* recordBotInput(input, result)
          : result;
      yield* wake.wake;
      return recorded;
    });

  const linkIdentity: ChannelGateway["Service"]["linkIdentity"] = (input, context) =>
    Effect.gen(function* () {
      const caller = context.caller;
      if (
        caller.type !== "transport" ||
        caller.connectionId !== input.connectionId ||
        input.replyAddress.kind !== caller.kind ||
        ("connectionId" in input.replyAddress &&
          input.replyAddress.connectionId !== input.connectionId)
      ) {
        return yield* forbidden();
      }
      if (caller.kind === "imessage") yield* home.requireHome;
      const causeKey = "link:" + input.connectionId + ":" + input.idempotencyKey;
      const now = DateTime.formatIso(yield* DateTime.now);
      // Success and failure share one cause key, so a retried code keeps the first answer.
      const outcome = yield* ledger
        .consumeIdentityLink({
          codeHash: linkCodeHashFor(input.connectionId, input.code),
          connectionId: input.connectionId,
          externalActorId: input.externalActorId,
          now,
          notice: noticeDelivery(
            causeKey,
            input.replyAddress,
            CHANNEL_COPY.linked,
            input.externalActorId,
          ),
          failureNotice: noticeDelivery(
            causeKey,
            input.replyAddress,
            CHANNEL_COPY.linkInvalid,
            input.externalActorId,
          ),
        })
        .pipe(Effect.mapError(ledgerFailure));
      yield* wake.wake;
      if (outcome.type === "invalid") return yield* forbidden();
      return { principalId: outcome.identity.principalId, linkedAt: outcome.linkedAt };
    });

  const requestNotice: ChannelGateway["Service"]["requestNotice"] = (input, context) =>
    Effect.gen(function* () {
      const caller = context.caller;
      if (
        caller.type !== "transport" ||
        caller.connectionId !== input.connectionId ||
        input.replyAddress.kind !== caller.kind ||
        ("connectionId" in input.replyAddress &&
          input.replyAddress.connectionId !== input.connectionId)
      ) {
        return yield* forbidden();
      }
      if (caller.kind === "imessage") yield* home.requireHome;
      const causeKey = "notice:" + input.connectionId + ":" + input.idempotencyKey;
      const deliveryId = deliveryIdFor(causeKey);
      const existing = yield* ledger
        .getDeliveryState(deliveryId)
        .pipe(Effect.mapError(ledgerFailure));
      if (existing !== undefined) return { deliveryId, duplicate: true };
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger
        .enqueueDeliveries(
          [
            noticeDelivery(
              causeKey,
              input.replyAddress,
              input.notice === "link_help" ? CHANNEL_COPY.linkHelp : CHANNEL_COPY.linkInvalid,
              input.actor.externalActorId,
            ),
          ],
          now,
        )
        .pipe(Effect.mapError(ledgerFailure));
      yield* wake.wake;
      return { deliveryId, duplicate: false };
    });

  const getInput: ChannelGateway["Service"]["getInput"] = (inputId, context) =>
    Effect.gen(function* () {
      const stored = yield* ledger.getInput(inputId).pipe(Effect.mapError(ledgerFailure));
      const caller = context.caller;
      const address = stored?.message.replyAddress;
      const visible =
        stored !== undefined &&
        stored.ownerId === context.ownerId &&
        (caller.type !== "mcp" ||
          (address?.kind === "mcp" && address.requestNamespace === caller.requestNamespace));
      if (!visible) return yield* new ChannelGatewayError({ reason: "not_found" });
      return stored.snapshot;
    });

  const send: ChannelGateway["Service"]["send"] = (message) =>
    registry.resolve(message.destination.kind).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ChannelGatewayError({ reason: "adapter_unavailable" })),
          onSome: (transport) => transport.send(message),
        }),
      ),
    );

  return ChannelGateway.of({ ingest, linkIdentity, requestNotice, getInput, send });
});

export const layer = Layer.effect(ChannelGateway, make);

/**
 * Replies to agent input stay in the ledger, on the input itself, where the agent reads them
 * with `channel_input_get`. This transport accepts those deliveries so the outbox records them
 * as delivered instead of failing them for want of an adapter.
 */
export const layerMcpMailbox = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    yield* registry.register({
      kind: "mcp",
      send: (message) =>
        DateTime.now.pipe(
          Effect.map((now) => ({
            deliveryId: message.deliveryId,
            acceptedAt: DateTime.formatIso(now),
          })),
        ),
    });
  }),
);
