import {
  CHANNEL_GATEWAY_WS_METHODS,
  type ChannelBotRef,
  type ChannelIngestInput,
  type ChannelListBotThreadsInput,
  type ChannelTaskId,
  type ChatAttachment,
  type EnvironmentId,
  SLACK_CHANNEL_WS_METHODS,
} from "@goat/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { goatBotListedWork, type GoatBotWorkRef } from "../goatBot/visibility.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

const NO_WORK: ReadonlyArray<GoatBotWorkRef> = Object.freeze([]);

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
  /**
   * The threads every bot's rows open as its own work, in the given environments. A bot's
   * rows are read again when its environment's signal changes; until they load, nothing is
   * listed, so thread lists keep showing the work.
   */
  const listedBotWork = (source: {
    readonly environmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
    readonly signal: (environmentId: EnvironmentId) => Atom.Atom<string>;
  }) => {
    const rowsQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:channel:goat-bot-listed-work",
      tag: CHANNEL_GATEWAY_WS_METHODS.listBotThreads,
      staleTimeMs: 2_000,
      refreshTrigger: ({ environmentId }) => source.signal(environmentId),
    });
    const forEnvironment = Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get): ReadonlyArray<GoatBotWorkRef> => {
        const capabilities = get(sessions.initialConfigValueAtom(environmentId))?.environment
          .capabilities;
        if (capabilities?.goatBotTaskThreads !== true) return NO_WORK;
        const inputs: ChannelListBotThreadsInput[] = [{}];
        if (capabilities.goatBotMembers === true && capabilities.goatBotProfiles === true) {
          // The roster's own query, so both read one list of bots.
          const bots = get(listBots({ environmentId, input: { includeDeleted: true } }));
          for (const bot of AsyncResult.isSuccess(bots) ? bots.value.bots : []) {
            if (bot.role === "member" && bot.state !== "deleted") inputs.push({ botId: bot.botId });
          }
        }
        const listed: GoatBotWorkRef[] = [];
        for (const input of inputs) {
          const result = get(rowsQuery({ environmentId, input }));
          if (AsyncResult.isSuccess(result)) listed.push(...goatBotListedWork(result.value.rows));
        }
        return listed.length === 0 ? NO_WORK : listed;
      }).pipe(Atom.withLabel(`environment-data:channel:goat-bot-listed-work:${environmentId}`)),
    );
    return Atom.make((get) =>
      get(source.environmentIdsAtom).flatMap((environmentId) => get(forEnvironment(environmentId))),
    ).pipe(Atom.withLabel("environment-data:channel:goat-bot-listed-work"));
  };
  return {
    ensureBot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:ensure-bot",
      tag: CHANNEL_GATEWAY_WS_METHODS.ensureBot,
    }),
    listBots,
    listedBotWork,
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
    listBotNotes: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:channel:list-bot-notes",
      tag: CHANNEL_GATEWAY_WS_METHODS.listBotNotes,
      staleTimeMs: 2_000,
    }),
    listBotArtifacts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:channel:list-bot-artifacts",
      tag: CHANNEL_GATEWAY_WS_METHODS.listBotArtifacts,
      staleTimeMs: 2_000,
    }),
    /** One chunk of a Library file; callers read a file one chunk at a time. */
    readBotArtifact: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:read-bot-artifact",
      tag: CHANNEL_GATEWAY_WS_METHODS.readBotArtifact,
    }),
    listChildWork: (target: Parameters<typeof childWorkQuery>[0]) =>
      childWorkFamily(JSON.stringify(target)),
    updateTaskView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:update-task-view",
      tag: CHANNEL_GATEWAY_WS_METHODS.updateTaskView,
    }),
    /** A person runs failed or stopped work again; a resent clientRequestId returns the first result. */
    retryTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:retry-task",
      tag: CHANNEL_GATEWAY_WS_METHODS.retryTask,
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
