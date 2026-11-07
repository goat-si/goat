import {
  CHANNEL_GATEWAY_WS_METHODS,
  type ChannelBotRef,
  type ChannelIngestInput,
  type ChannelTaskId,
  type ChatAttachment,
  type EnvironmentId,
  SLACK_CHANNEL_WS_METHODS,
} from "@goat/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

/**
 * Commands and queries for the GOAT bot, the channel ledger, and Slack settings. Bot messages
 * go through `ingest`, which returns once the server stored the message; the reply arrives on
 * the bot thread. Sends are not serialized: the bot takes a new message while work runs.
 */
export function createChannelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const sessions = createEnvironmentSessionAtoms(runtime);
  const listBots = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:channel:list-bots",
    tag: CHANNEL_GATEWAY_WS_METHODS.listBots,
    staleTimeMs: 2_000,
  });
  // The roster lists deleted members too; settings list only the others.
  const refreshBots = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(listBots({ environmentId, input: {} }));
      registry.refresh(listBots({ environmentId, input: { includeDeleted: true } }));
    });
  const childWorkQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:channel:list-child-work",
    tag: CHANNEL_GATEWAY_WS_METHODS.listChildWork,
    staleTimeMs: 2_000,
  });
  const childWorkFamily = Atom.family((key: string) => {
    const target = JSON.parse(key) as Parameters<typeof childWorkQuery>[0];
    return Atom.make((get) =>
      get(sessions.initialConfigValueAtom(target.environmentId))?.environment.capabilities
        .goatBotChildWork === true
        ? get(childWorkQuery(target))
        : AsyncResult.success({ groups: [] }),
    );
  });
  return {
    ensureBot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:ensure-bot",
      tag: CHANNEL_GATEWAY_WS_METHODS.ensureBot,
    }),
    listBots,
    /** Edits a bot's name, avatar or purpose; the roster and settings re-read the list after. */
    updateBot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:update-bot",
      tag: CHANNEL_GATEWAY_WS_METHODS.updateBot,
      onSuccess: refreshBots,
    }),
    /** A member bot with its own conversation; a retry with the same clientRequestId returns it. */
    createBot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:create-bot",
      tag: CHANNEL_GATEWAY_WS_METHODS.createBot,
      onSuccess: refreshBots,
    }),
    setBotHidden: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:set-bot-hidden",
      tag: CHANNEL_GATEWAY_WS_METHODS.setBotHidden,
      onSuccess: refreshBots,
    }),
    /** Refused with bot_busy while the bot has open work. */
    deleteBot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:delete-bot",
      tag: CHANNEL_GATEWAY_WS_METHODS.deleteBot,
      onSuccess: refreshBots,
    }),
    restoreBot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:restore-bot",
      tag: CHANNEL_GATEWAY_WS_METHODS.restoreBot,
      onSuccess: refreshBots,
    }),
    /** One bot's waiting count; member rows read it, main keeps its own observer. */
    botStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:channel:bot-status",
      tag: CHANNEL_GATEWAY_WS_METHODS.getBotStatus,
      staleTimeMs: 2_000,
    }),
    listBotThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:channel:list-bot-threads",
      tag: CHANNEL_GATEWAY_WS_METHODS.listBotThreads,
      staleTimeMs: 2_000,
    }),
    listChildWork: (target: Parameters<typeof childWorkQuery>[0]) =>
      childWorkFamily(JSON.stringify(target)),
    updateTaskView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:update-task-view",
      tag: CHANNEL_GATEWAY_WS_METHODS.updateTaskView,
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
  /** Uploads this server already holds; the gateway refuses any other file. */
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly clientMessageId: string;
  readonly receivedAt: string;
  readonly taskId?: ChannelTaskId;
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
    attachments: input.attachments ?? [],
    receivedAt: input.receivedAt,
    intent: "message",
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  };
}

/** A bot's editable profile fields, as a person sees them in a form. */
export interface BotProfileValues {
  readonly name: string;
  readonly avatar: string | null;
  readonly purpose: string;
}

/** What to send for a bot's profile: every field when creating, else only what changed, trimmed as stored. */
export function botProfileChanges(
  mode: "edit" | "create",
  initial: BotProfileValues,
  draft: { readonly name: string; readonly avatar: string; readonly purpose: string },
): Partial<BotProfileValues> {
  const next = {
    name: draft.name.trim(),
    avatar: draft.avatar.trim() === "" ? null : draft.avatar.trim(),
    purpose: draft.purpose.trim(),
  };
  if (mode === "create") return next;
  return {
    ...(next.name === initial.name ? {} : { name: next.name }),
    ...(next.avatar === initial.avatar ? {} : { avatar: next.avatar }),
    ...(next.purpose === initial.purpose ? {} : { purpose: next.purpose }),
  };
}
