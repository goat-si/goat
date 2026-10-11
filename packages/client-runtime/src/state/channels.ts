import {
  CHANNEL_GATEWAY_WS_METHODS,
  type ChannelBotRef,
  type ChannelIngestInput,
  SLACK_CHANNEL_WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Commands and queries for the GOAT bot, the channel ledger, and Slack settings. Bot messages
 * go through `ingest`, which returns once the server stored the message; the reply arrives on
 * the bot thread. Sends are not serialized: the bot takes a new message while work runs.
 */
export function createChannelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    ensureBot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:ensure-bot",
      tag: CHANNEL_GATEWAY_WS_METHODS.ensureBot,
    }),
    ingest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:ingest",
      tag: CHANNEL_GATEWAY_WS_METHODS.ingest,
    }),
    getTask: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:channel:get-task",
      tag: CHANNEL_GATEWAY_WS_METHODS.getTask,
      staleTimeMs: 2_000,
    }),
    listTasks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:channel:list-tasks",
      tag: CHANNEL_GATEWAY_WS_METHODS.listTasks,
      staleTimeMs: 2_000,
    }),
    getInput: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:channel:get-input",
      tag: CHANNEL_GATEWAY_WS_METHODS.getInput,
      staleTimeMs: 1_000,
    }),
    createIdentityLink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:create-identity-link",
      tag: CHANNEL_GATEWAY_WS_METHODS.createIdentityLink,
    }),
    unlinkIdentity: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:unlink-identity",
      tag: CHANNEL_GATEWAY_WS_METHODS.unlinkIdentity,
    }),
    slackSettings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:slack-channel:get-settings",
      tag: SLACK_CHANNEL_WS_METHODS.getSettings,
      staleTimeMs: 5_000,
    }),
    slackConfigure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack-channel:configure",
      tag: SLACK_CHANNEL_WS_METHODS.configure,
    }),
    slackDisconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack-channel:disconnect",
      tag: SLACK_CHANNEL_WS_METHODS.disconnect,
    }),
    slackStatus: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:slack-channel:status",
      tag: SLACK_CHANNEL_WS_METHODS.subscribeStatus,
    }),
  };
}

/**
 * The channel input for a message typed into the GOAT bot. `clientMessageId` is the client's own
 * id for the message; resending it after a dropped connection returns the stored receipt
 * instead of a second message.
 */
export function goatBotIngestInput(input: {
  readonly bot: ChannelBotRef;
  readonly text: string;
  readonly clientMessageId: string;
  readonly receivedAt: string;
}): ChannelIngestInput {
  return {
    kind: "goat",
    connectionId: "goat",
    conversationKey: input.bot.threadId,
    externalMessageId: input.clientMessageId,
    idempotencyKey: input.clientMessageId,
    actor: {},
    replyAddress: {
      kind: "goat",
      environmentId: input.bot.environmentId,
      threadId: input.bot.threadId,
    },
    text: input.text,
    attachments: [],
    receivedAt: input.receivedAt,
    intent: "message",
  };
}
