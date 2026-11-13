import {
  CHANNEL_GATEWAY_WS_METHODS,
  type ChannelBotRef,
  type ChannelIngestInput,
  type ChannelListBotThreadsInput,
  type ChannelQuestionId,
  type ChannelSubscribeTaskChangesInput,
  type ChannelTaskId,
  type ChatAttachment,
  type EnvironmentId,
  isChannelChildWorkActive,
  SLACK_CHANNEL_WS_METHODS,
} from "@goat/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { botRowListedUntil, botRowRetiresAt } from "../goatBot/taskVisibility.ts";
import { sameBotColor } from "../goatBot/botColor.ts";
import { goatBotListedWork, type GoatBotWorkRef } from "../goatBot/visibility.ts";
import { subscribeOrUnavailable } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

const NO_WORK: ReadonlyArray<GoatBotWorkRef> = Object.freeze([]);
// setTimeout's longest delay; a later expiry re-arms when this one fires.
const MAX_TIMER_MS = 2_147_483_647;
const CUTOFF_MARGIN_MS = 1_000;
const CUTOFF_RETRY_MS = 60_000;
const CUTOFF_RETRY_WINDOW_MS = 10 * 60_000;
// A remote launch can be listed before its destination identity is saved; re-read briefly.
const PENDING_REMOTE_RETRY_MS = 5_000;
const PENDING_REMOTE_WINDOW_MS = 2 * 60_000;

/**
 * Commands and queries for the GOAT bot, the channel ledger, and Slack settings. Bot messages
 * go through `ingest`, which returns once the server stored the message; the reply arrives on
 * the bot thread. Sends are not serialized: the bot takes a new message while work runs.
 */
/** How long the task change stream stays open after its last view unmounts. */
const TASK_CHANGES_IDLE_TTL_MS = 2_000;

export function createChannelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const sessions = createEnvironmentSessionAtoms(runtime);
  // Bumped when this client changes a task's view, or a listed row's retention ends, so every
  // reader of that environment's bot rows reads them again.
  const botThreadsRevision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:channel:bot-threads-revision:${environmentId}`),
    ),
  );
  const bumpBotThreads = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.update(botThreadsRevision(environmentId), (n) => n + 1));
  // The thread shell's work signal, installed by `listedBotWork` when the shell is built.
  let shellWorkSignal: ((environmentId: EnvironmentId) => Atom.Atom<string>) | undefined;
  const botThreadsSignal = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        `${get(botThreadsRevision(environmentId))}|${
          shellWorkSignal === undefined ? "" : get(shellWorkSignal(environmentId))
        }`,
    ).pipe(Atom.withLabel(`environment-data:channel:bot-threads-signal:${environmentId}`)),
  );
  // The bot's rows and the thread lists that hide its work read this one query, so a row the
  // bot can no longer show stops hiding its thread on the same answer.
  const listBotThreads = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:channel:list-bot-threads",
    tag: CHANNEL_GATEWAY_WS_METHODS.listBotThreads,
    staleTimeMs: 2_000,
    refreshTrigger: ({ environmentId }) => botThreadsSignal(environmentId),
  });
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
    return Atom.readable(
      (get) =>
        get(sessions.initialConfigValueAtom(target.environmentId))?.environment.capabilities
          .goatBotChildWork === true
          ? get(childWorkQuery(target))
          : AsyncResult.success({ groups: [] }),
      (refresh) => refresh(childWorkQuery(target)),
    );
  });
  /**
   * Whether this client holds a live session to exactly this environment: the one test that
   * lets the bot's work on another machine be opened, and so hidden from thread lists. A
   * disabled or disconnected entry has no session, and a session that reports another identity
   * does not count.
   */
  const remoteWorkOpenable = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        get(sessions.initialConfigValueAtom(environmentId))?.environment.environmentId ===
        environmentId,
    ).pipe(Atom.withLabel(`environment-data:channel:remote-work-openable:${environmentId}`)),
  );
  /**
   * The threads the rows each bot shows open as its own work. A row aged out of the bot's lists
   * stops hiding its thread, and the rows are read again when the next one's retention ends.
   * Until they load, nothing is listed, so thread lists keep showing the work.
   */
  const listedBotWork = (source: {
    readonly environmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
    readonly signal: (environmentId: EnvironmentId) => Atom.Atom<string>;
  }) => {
    shellWorkSignal = source.signal;
    const forEnvironment = Atom.family((environmentId: EnvironmentId) => {
      // When this client first saw each remote launch without a destination, by its own clock.
      const pendingSince = new Map<string, number>();
      return Atom.make((get): ReadonlyArray<GoatBotWorkRef> => {
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
        // @effect-diagnostics-next-line globalDate:off - Retention is wall-clock, as the bot's lists read it.
        const now = Date.now();
        let nextExpiry = Infinity;
        const stillPending = new Set<string>();
        let everyListRead = true;
        for (const input of inputs) {
          const result = get(listBotThreads({ environmentId, input }));
          if (!AsyncResult.isSuccess(result)) {
            everyListRead = false;
            continue;
          }
          const shown = [];
          const retiredTasks = new Set<string>();
          for (const row of result.value.rows) {
            const retiresAt = botRowRetiresAt(row);
            const listedUntil = botRowListedUntil(row);
            // The server still lists a task at its cutoff, and its clock may trail ours: re-read
            // just after the cutoff, and again for a bounded while if the row is still there.
            if (listedUntil >= now)
              nextExpiry = Math.min(nextExpiry, listedUntil + CUTOFF_MARGIN_MS);
            else if (now - listedUntil < CUTOFF_RETRY_WINDOW_MS)
              nextExpiry = Math.min(nextExpiry, now + CUTOFF_RETRY_MS);
            if (now >= retiresAt) {
              if (row.kind === "task") retiredTasks.add(row.task.taskId);
              continue;
            }
            nextExpiry = Math.min(nextExpiry, retiresAt);
            shown.push(row);
          }
          for (const item of result.value.remoteWork ?? []) {
            if (item.threadId !== undefined && item.environmentId !== undefined) continue;
            if (!isChannelChildWorkActive(item.state)) continue;
            stillPending.add(item.childWorkId);
            const since = pendingSince.get(item.childWorkId) ?? now;
            pendingSince.set(item.childWorkId, since);
            if (now - since < PENDING_REMOTE_WINDOW_MS)
              nextExpiry = Math.min(nextExpiry, now + PENDING_REMOTE_RETRY_MS);
          }
          listed.push(
            ...goatBotListedWork(shown, {
              originEnvironmentId: environmentId,
              // A retired task's remote work opens only from that task, so it shows again too.
              items: (result.value.remoteWork ?? []).filter(
                (item) => !retiredTasks.has(item.taskId),
              ),
              isOpenable: (destination) => get(remoteWorkOpenable(destination)),
            }),
          );
        }
        // A failed read proves nothing about a pending launch, so it keeps its window.
        for (const [key, since] of pendingSince) {
          if (stillPending.has(key)) continue;
          if (everyListRead) pendingSince.delete(key);
          else if (now - since < PENDING_REMOTE_WINDOW_MS)
            nextExpiry = Math.min(nextExpiry, now + PENDING_REMOTE_RETRY_MS);
        }
        if (nextExpiry !== Infinity) {
          // @effect-diagnostics-next-line globalTimers:off - One bounded timer per read, cleared on the next.
          const handle = setTimeout(
            () => {
              get.registry.update(botThreadsRevision(environmentId), (n) => n + 1);
              get.refreshSelf();
            },
            Math.min(nextExpiry - now, MAX_TIMER_MS),
          );
          get.addFinalizer(() => clearTimeout(handle));
        }
        return listed.length === 0 ? NO_WORK : listed;
      }).pipe(Atom.withLabel(`environment-data:channel:goat-bot-listed-work:${environmentId}`));
    });
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
    remoteWorkOpenable,
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
    listBotThreads,
    getBotTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:get-bot-task",
      tag: CHANNEL_GATEWAY_WS_METHODS.getBotTask,
    }),
    searchBotTasks: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:search-bot-tasks",
      tag: CHANNEL_GATEWAY_WS_METHODS.searchBotTasks,
    }),
    /** One page of a bot's task history, read on request rather than kept live. */
    listBotThreadsPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:channel:list-bot-threads-page",
      tag: CHANNEL_GATEWAY_WS_METHODS.listBotThreads,
    }),
    listOpenAsks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:channel:list-open-asks",
      tag: CHANNEL_GATEWAY_WS_METHODS.listOpenAsks,
      staleTimeMs: 2_000,
    }),
    /** Whether this client may read open asks; without it the strip shows nothing. */
    listOpenAsksPermission: createCommandPermissions(
      runtime,
      CHANNEL_GATEWAY_WS_METHODS.listOpenAsks,
    ).permissionAtom,
    /**
     * "Read again" for the owner's channel tasks, one stream per environment however many views
     * use it. It closes soon after the last one unmounts: the server allows few per connection.
     * A session without the stream says so, and the next session asks again.
     */
    taskChanges: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:channel:task-changes",
      idleTtlMs: TASK_CHANGES_IDLE_TTL_MS,
      subscribe: (input: ChannelSubscribeTaskChangesInput) =>
        subscribeOrUnavailable(CHANNEL_GATEWAY_WS_METHODS.subscribeTaskChanges, input),
    }),
    taskChangesPermission: createCommandPermissions(
      runtime,
      CHANNEL_GATEWAY_WS_METHODS.subscribeTaskChanges,
    ).permissionAtom,
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
      onSuccess: bumpBotThreads,
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
  readonly bot: Pick<ChannelBotRef, "environmentId" | "threadId">;
  readonly text: string;
  /** Uploads this server already holds; the gateway refuses any other file. */
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly clientMessageId: string;
  readonly receivedAt: string;
  readonly taskId?: ChannelTaskId;
  /** With taskId: the card's question this answers, sent as an answer the server checks. */
  readonly questionId?: ChannelQuestionId;
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
    ...(input.taskId === undefined
      ? { intent: "message" as const }
      : input.questionId === undefined
        ? { intent: "message" as const, taskId: input.taskId }
        : { intent: "answer" as const, taskId: input.taskId, questionId: input.questionId }),
  };
}

/** A bot's editable profile fields, as a person sees them in a form. */
export interface BotProfileValues {
  readonly name: string;
  readonly avatar: string | null;
  readonly purpose: string;
  /** A member's accent; null is the theme's neutral. Absent where the server cannot store one. */
  readonly color?: string | null;
}

/**
 * What to send for a bot's profile: every field when creating, else only what changed, trimmed as
 * stored. A color goes only where the form offers one: a chosen one on create, a change on edit.
 */
export function botProfileChanges(
  mode: "edit" | "create",
  initial: BotProfileValues,
  draft: {
    readonly name: string;
    readonly avatar: string;
    readonly purpose: string;
    readonly color?: string | null;
  },
): Partial<BotProfileValues> {
  const next = {
    name: draft.name.trim(),
    avatar: draft.avatar.trim() === "" ? null : draft.avatar.trim(),
    purpose: draft.purpose.trim(),
  };
  const color = draft.color;
  if (mode === "create") return color == null ? next : { ...next, color };
  return {
    ...(next.name === initial.name ? {} : { name: next.name }),
    ...(next.avatar === initial.avatar ? {} : { avatar: next.avatar }),
    ...(next.purpose === initial.purpose ? {} : { purpose: next.purpose }),
    ...(color === undefined || sameBotColor(color, initial.color) ? {} : { color }),
  };
}
