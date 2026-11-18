import {
  buildGoatBotTimeline,
  createGoatBotSendQueue,
  goatBotActivity,
  goatBotActivityTask,
  goatBotItemReaders,
  goatBotReplyingSince,
  goatBotEnsureFailure,
  GOAT_BOT_NOT_ACCEPTED,
  initialGoatBotEnsure,
  observeResidentAtom,
  residentAtomValue,
  retryGoatBotEnsure,
  settleGoatBotEnsure,
  startGoatBotEnsure,
  syncGoatBotEnsure,
  type GoatBotSendQueue,
} from "@goat/client-runtime/goatBot";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { goatBotIngestInput } from "@goat/client-runtime/state/channels";
import type {
  BotProfile,
  ChannelBotRef,
  ChannelGatewayError,
  ChannelQuestionId,
  ChannelTaskId,
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
} from "@goat/contracts";
import { useContext, useEffect, useSyncExternalStore } from "react";

import { useGlobalAgentStore } from "~/globalAgentStore";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  useEnvironmentShellsBootstrapped,
  useServerConfigs,
  useThreadShell,
  useTimelineVisibleTurnItems,
} from "~/state/entities";
import { environmentThreadDetails } from "~/state/threads";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";
import {
  memberBotRef,
  pickGoatBotEnvironment,
  resolveGoatBotHomeSelection,
  type GoatBotAvailability,
} from "@goat/client-runtime/goatBot";
import {
  releaseGoatBotAttachments,
  retainGoatBotAttachments,
  uploadGoatBotAttachments,
  type GoatBotAttachmentSupport,
  type GoatBotDraftAttachment,
} from "./goatBotAttachments";
import { GoatBotChannelContext, type GoatBotChannelPort } from "./goatBotChannelPort";
import { useGoatBotSource } from "./useGoatBotSource";
import { useGoatBotEnvironments } from "./goatBotHooks";
import { registerGoatBotEnvironmentDisposal } from "./goatBotEnvironmentLifecycle";
import {
  goatBotEnabledFor,
  goatBotHomeKey,
  goatBotHomeReady,
  goatBotMainAvailability,
  goatBotNotHomeHolds,
  updateGoatBotSession as update,
  useGoatBotSessions as useSessions,
} from "./goatBotSessions";

export { goatBotEnabled } from "./goatBotSessions";

const EMPTY_ITEMS: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [];
const changed = () => useSessions.setState((state) => ({ revision: state.revision + 1 }));

function disposeWebGoatBotEnvironment(environmentId: EnvironmentId): void {
  const session = useSessions.getState().sessions.get(environmentId);
  if (!session) return;
  useSessions.setState((state) => {
    const sessions = new Map(state.sessions);
    sessions.delete(environmentId);
    return { sessions };
  });
  session.queue.dispose();
}

registerGoatBotEnvironmentDisposal(disposeWebGoatBotEnvironment);

function newQueue(environmentId: EnvironmentId) {
  const owned = new Map<string, ReadonlyArray<GoatBotDraftAttachment>>();
  let disposed = false;
  const forget = (key: string) => {
    const attachments = owned.get(key);
    if (attachments === undefined) return;
    owned.delete(key);
    releaseGoatBotAttachments(attachments);
  };
  const queue = createGoatBotSendQueue<GoatBotDraftAttachment>({
    onChange: changed,
    onSubmit: (key, attachments) => {
      retainGoatBotAttachments(attachments);
      owned.set(key, attachments);
    },
    onForget: (key) => forget(key),
    makeKey: randomUUID,
    canDispatch: (bot) => {
      const session = useSessions.getState().sessions.get(environmentId);
      return (
        session?.connected === true &&
        session.capability &&
        session.canOperate &&
        session.port !== null &&
        session.machine.ensure.state === "confirmed" &&
        session.machine.ensure.bot.environmentId === bot.environmentId &&
        (session.machine.ensure.bot.threadId === bot.threadId || session.members.has(bot.threadId))
      );
    },
    send: async ({ clientKey, text, attachments, receivedAt, bot, taskId, questionId }) => {
      const port = useSessions.getState().sessions.get(environmentId)?.port;
      if (!port) throw new Error("GOAT Bot isn't available");
      const files = await uploadGoatBotAttachments(bot.environmentId, attachments);
      if (disposed) throw new Error("GOAT Bot environment was removed");
      const result = await port.ingest(
        bot.environmentId,
        goatBotIngestInput({
          bot,
          text,
          attachments: files,
          clientMessageId: clientKey,
          receivedAt,
          ...(taskId === undefined ? {} : { taskId }),
          ...(questionId === undefined ? {} : { questionId }),
        }),
      );
      // The server keeps its own copy of each file once it has the message, and a rejected
      // message is never sent again.
      forget(clientKey);
      if (result.state === "rejected")
        return {
          requestKey: result.inputId,
          rejected: GOAT_BOT_NOT_ACCEPTED,
        };
      return { requestKey: result.inputId };
    },
  });
  return {
    ...queue,
    dispose: () => {
      disposed = true;
      queue.dispose();
    },
  };
}

/** Sidebar observers also track reconnects while the bot screen is closed. */
function useObservedEnvironments() {
  const environments = useGoatBotEnvironments();
  const homeKey = goatBotHomeKey(resolveGoatBotHomeSelection(environments, null));
  useEffect(() => {
    const observed = new Map(environments.map((entry) => [entry.environmentId, entry]));
    for (const [environmentId, session] of useSessions.getState().sessions) {
      if (!observed.has(environmentId) && session.connected) {
        update(environmentId, {
          ...session,
          connected: false,
          machine: syncGoatBotEnsure(session.machine, null),
        });
      }
    }
    for (const environment of environments) {
      const previous = useSessions.getState().sessions.get(environment.environmentId);
      if (
        previous?.connected === environment.connected &&
        previous.capability === environment.supportsChannelLedger &&
        previous.homeKey === homeKey
      )
        continue;
      const generation =
        (previous?.generation ?? 0) + (environment.connected && !previous?.connected ? 1 : 0);
      const key =
        environment.connected && environment.supportsChannelLedger
          ? `${environment.environmentId}:${generation}:channel:${homeKey}`
          : null;
      update(environment.environmentId, {
        homeKey,
        notHome: previous?.notHome ?? null,
        connected: environment.connected,
        capability: environment.supportsChannelLedger,
        generation,
        machine: syncGoatBotEnsure(previous?.machine ?? initialGoatBotEnsure, key),
        port: previous?.port ?? null,
        canOperate: false,
        legacyAutoRetried: false,
        queue: previous?.queue ?? newQueue(environment.environmentId),
        members: previous?.members ?? new Set(),
      });
    }
  }, [environments, homeKey]);
  return environments;
}

export function useGoatBotEnabled() {
  const port = useContext(GoatBotChannelContext);
  const environments = useObservedEnvironments();
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const home = resolveGoatBotHomeSelection(environments, botRef);
  const environment = pickGoatBotEnvironment(environments, botRef);
  const session = useSessions((state) =>
    environment === null ? undefined : state.sessions.get(environment.environmentId),
  );
  return {
    enabled: goatBotEnabledFor(port, environments, home, environment),
    environments,
    home,
    environment,
    generation:
      session?.connected === environment?.connected &&
      session?.capability === environment?.supportsChannelLedger
        ? (session?.generation ?? 0)
        : 0,
    port,
  };
}

// Without a port nothing can send; the stand-in keeps the hook call unconditional.
const NO_PORT_PERMISSION: Pick<GoatBotChannelPort, "useCanSend"> = { useCanSend: () => false };

// The queue changes in place and bumps revision; taking revision makes it an input of the
// compiled read, so the timeline does not keep the previous pending inputs.
function pendingInputsAt(
  queue: GoatBotSendQueue<GoatBotDraftAttachment> | undefined,
  _revision: number,
) {
  return queue?.pendingInputs() ?? [];
}

/** A worker thread's detail only while another view keeps it loaded; never loads it. */
function useResidentThreadProjection(ref: ScopedThreadRef | null) {
  const atom = ref === null ? null : environmentThreadDetails.threadAtom(ref);
  const resident = atom !== null && residentAtomValue(appAtomRegistry, atom) !== null;
  const subscribe = (onChange: () => void) =>
    atom === null || !resident ? () => {} : observeResidentAtom(appAtomRegistry, atom, onChange);
  const thread = useSyncExternalStore(subscribe, () =>
    atom === null ? null : residentAtomValue(appAtomRegistry, atom),
  );
  return thread?.projection ?? null;
}

/** What GOAT Bot's acknowledged work is doing, from the conversation and its worker. */
function useGoatBotWorking(visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  const task = goatBotActivityTask({ visibleTurnItems, readers: goatBotItemReaders });
  const worker = task?.chip.worker;
  // Thread keys carry no host, so remote work is never looked up locally.
  const workerRef =
    worker === undefined || worker.host !== undefined
      ? null
      : scopeThreadRef(worker.environmentId, worker.threadId);
  const shell = useThreadShell(workerRef);
  const projection = useResidentThreadProjection(workerRef);
  const activity = goatBotActivity({
    reading: false,
    task,
    worker: workerRef === null ? null : { shell: shell?.source ?? null, projection },
  });
  return activity === null || task === null ? activity : { ...activity, title: task.chip.title };
}

/**
 * Sets the members whose messages may leave this environment's queue to the roster's active ones,
 * so a member deleted while its chat is closed stops sending.
 */
export function syncGoatBotMemberThreads(
  environmentId: EnvironmentId,
  bots: ReadonlyArray<BotProfile>,
): void {
  const current = useSessions.getState().sessions.get(environmentId);
  if (!current) return;
  const members = new Set(
    bots
      .filter(
        (bot) =>
          bot.role === "member" && bot.state !== "deleted" && bot.environmentId === environmentId,
      )
      .map((bot) => bot.sessionThreadId as string),
  );
  if (members.size === current.members.size && [...members].every((id) => current.members.has(id)))
    return;
  update(environmentId, { ...current, members });
}

/** Lets a member's messages through the queue while it is active, and stops them once deleted. */
function useMemberRegistration(environmentId: EnvironmentId | null, member: BotProfile | null) {
  const threadId = member?.sessionThreadId ?? null;
  const active = member !== null && member.state !== "deleted";
  const sessionExists = useSessions(
    (state) => environmentId !== null && state.sessions.has(environmentId),
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Publish the member's state to the environment's send queue, which outlives this view.
  useEffect(() => {
    if (environmentId === null || threadId === null || !sessionExists) return;
    const current = useSessions.getState().sessions.get(environmentId);
    if (!current || current.members.has(threadId) === active) return;
    const members = new Set(current.members);
    if (active) members.add(threadId);
    else members.delete(threadId);
    update(environmentId, { ...current, members });
  }, [environmentId, threadId, active, sessionExists]);
}

/**
 * One ensure and send queue per environment, shared by the entry route and thread view. With a
 * member, the same session sends to that member's own conversation once the environment's bot is
 * confirmed.
 */
export function useGoatBotSession(
  visibleTurnItems = EMPTY_ITEMS,
  taskId?: ChannelTaskId | null,
  member: BotProfile | null = null,
  displayedRef?: ScopedThreadRef | null,
) {
  const { enabled, environment, environments, home, port } = useGoatBotEnabled();
  const environmentId = environment?.environmentId ?? null;
  const bootstrapped = useEnvironmentShellsBootstrapped(environmentId);
  const session = useSessions((state) =>
    environmentId === null ? undefined : state.sessions.get(environmentId),
  );
  const revision = useSessions((state) => state.revision);
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const projectionRef =
    displayedRef !== undefined
      ? displayedRef
      : member
        ? scopeThreadRef(member.environmentId, member.sessionThreadId)
        : botRef
          ? scopeThreadRef(botRef.environmentId, botRef.threadId)
          : null;
  const membership = useTimelineVisibleTurnItems(projectionRef);
  const source = useGoatBotSource(
    projectionRef,
    member?.botId ?? "main",
    visibleTurnItems,
    membership,
  );
  const legacyRef = useGlobalAgentStore((state) => state.ref);
  const legacyThreadRef =
    legacyRef === null ? null : scopeThreadRef(legacyRef.environmentId, legacyRef.threadId);
  const legacyShell = useThreadShell(legacyThreadRef);
  const legacyStopped =
    legacyRef?.environmentId === environmentId && legacyShell?.runtime?.activeRunId === null;
  // The transport supplies a hook, installed for the lifetime of the app provider.
  const canOperate = (port ?? NO_PORT_PERMISSION).useCanSend(environmentId);

  const homeKey = goatBotHomeKey(home);
  const settingsSnapshot = environment?.settingsSnapshot ?? null;
  const homeReady = goatBotHomeReady(home);
  useEffect(() => {
    if (environmentId === null || session === undefined) return;
    let current = useSessions.getState().sessions.get(environmentId);
    if (!current) return;
    // A not_home refusal waits for observed evidence, including across manual retry and reconnect.
    if (current.notHome !== null) {
      if (goatBotNotHomeHolds(current, homeKey, settingsSnapshot)) return;
      current = { ...current, notHome: null, machine: retryGoatBotEnsure(current.machine) };
      update(environmentId, current);
    }
    let machine = current.machine;
    let legacyAutoRetried = current.port === port ? current.legacyAutoRetried : false;
    if (current.port !== port) machine = retryGoatBotEnsure(machine);
    if (machine.ensure.state === "legacy_active" && legacyStopped && !legacyAutoRetried) {
      machine = retryGoatBotEnsure(machine);
      legacyAutoRetried = true;
    }
    if (
      machine !== current.machine ||
      current.port !== port ||
      current.canOperate !== canOperate ||
      current.legacyAutoRetried !== legacyAutoRetried
    ) {
      current = { ...current, port, canOperate, legacyAutoRetried, machine };
      update(environmentId, current);
    }
    if (
      !homeReady ||
      !enabled ||
      !current.capability ||
      !bootstrapped ||
      !current.connected ||
      !port ||
      machine.ensure.state !== "idle"
    )
      return;
    const request = startGoatBotEnsure(machine);
    update(environmentId, { ...current, machine: request.machine });
    const candidateThreadId =
      legacyRef?.environmentId === environmentId &&
      legacyShell?.archivedAt == null &&
      legacyShell?.deletedAt == null
        ? legacyRef.threadId
        : undefined;
    const settle = (result: Parameters<typeof settleGoatBotEnsure>[2], bot?: ChannelBotRef) => {
      const latest = useSessions.getState().sessions.get(environmentId);
      if (!latest) return;
      const settled = settleGoatBotEnsure(latest.machine, request.token, result);
      if (settled === latest.machine) return;
      update(environmentId, { ...latest, machine: settled });
      if (bot) useGlobalAgentStore.getState().setBotRef(bot);
    };
    void (async () => {
      try {
        const bot = await port.ensureBot(
          environmentId,
          candidateThreadId === undefined ? {} : { candidateThreadId },
        );
        settle({ kind: "confirmed", bot }, bot);
      } catch (error) {
        const gatewayError = error as ChannelGatewayError | null;
        if (gatewayError?.reason === "not_home") {
          const latest = useSessions.getState().sessions.get(environmentId);
          if (latest?.machine.pending === request.token) {
            update(environmentId, {
              ...latest,
              machine: retryGoatBotEnsure(latest.machine),
              notHome: { homeKey, settingsSnapshot },
            });
          }
          return;
        }
        settle(
          gatewayError?.reason === "legacy_active"
            ? { kind: "legacy_active" }
            : {
                kind: "failed",
                ...goatBotEnsureFailure(error),
              },
        );
      }
    })();
  }, [
    environmentId,
    homeReady,
    homeKey,
    settingsSnapshot,
    enabled,
    bootstrapped,
    port,
    session,
    canOperate,
    legacyStopped,
    legacyRef,
    legacyShell,
  ]);

  useMemberRegistration(environmentId, member);
  const mainAvailability = goatBotMainAvailability({ port, environments, botRef, session });
  // A member answers only through its own environment's session.
  const availability: GoatBotAvailability =
    member === null || mainAvailability.kind !== "ready"
      ? mainAvailability
      : member.environmentId !== mainAvailability.bot.environmentId
        ? {
            kind: "error",
            environmentId: member.environmentId,
            message: `${member.name} runs on another computer.`,
          }
        : { ...mainAvailability, bot: memberBotRef(member, mainAvailability.bot) };
  const targetThreadId = member?.sessionThreadId ?? botRef?.threadId ?? null;
  const queue = session?.queue;
  useEffect(() => {
    const keys = new Set<string>();
    for (const { item } of visibleTurnItems) {
      if (item.type !== "user_message") continue;
      const presentation = goatBotItemReaders.message(item);
      if (presentation?.requestKey) keys.add(presentation.requestKey);
      if (presentation?.clientKey) keys.add(presentation.clientKey);
    }
    // An entry-route consumer has no projection and must not clear a thread consumer's keys.
    if (visibleTurnItems !== EMPTY_ITEMS) queue?.acknowledge(keys);
  }, [queue, visibleTurnItems]);
  const activity = useGoatBotWorking(visibleTurnItems);
  const serverConfigs = useServerConfigs();
  const readyBot = availability.kind === "ready" ? availability.bot : null;
  const capabilities =
    readyBot === null
      ? undefined
      : serverConfigs.get(readyBot.environmentId)?.environment.capabilities;
  const threads = useEnvironmentQuery(
    readyBot !== null && capabilities?.goatBotTaskThreads === true
      ? channelEnvironment.listBotThreads({
          environmentId: readyBot.environmentId,
          input: member === null ? {} : { botId: member.botId },
        })
      : null,
  );
  const knownTaskIds = (threads.data?.rows ?? []).flatMap((row) =>
    row.kind === "task" ? [row.task.taskId] : [],
  );
  const rowsForTask = (selectedTask: ChannelTaskId | null | undefined) =>
    buildGoatBotTimeline({
      visibleTurnItems,
      pendingInputs: pendingInputsAt(queue, revision).filter(
        (input) => input.threadId === undefined || input.threadId === targetThreadId,
      ),
      readers: goatBotItemReaders,
      knownTaskIds,
      ...(selectedTask === undefined ? {} : { taskId: selectedTask }),
      // Work cards leave the chat only where the bot's work list can open every task.
      conversationOnly: capabilities?.goatBotTaskThreads === true,
      // This client's question card sends answers with their question.
      answerReferences: true,
    });
  const rows = rowsForTask(taskId);
  const sendable =
    availability.kind === "ready" &&
    canOperate &&
    member?.state !== "deleted" &&
    queue !== undefined;
  const attachmentSupport: GoatBotAttachmentSupport | null =
    capabilities?.goatBotAttachments === true && capabilities.attachmentUploads === true
      ? { maxUploadBytes: capabilities.fileAttachments?.maxUploadBytes ?? null }
      : null;
  return {
    confirmedBot: availability.kind === "ready" ? availability.bot : null,
    projectionRef,
    source,
    availability,
    canOperate,
    visibleTurnItems,
    rows,
    replyingSince: goatBotReplyingSince({ visibleTurnItems, readers: goatBotItemReaders }),
    activity,
    attachmentSupport,
    supportsTaskThreads: capabilities?.goatBotTaskThreads === true,
    supportsTaskRetry: capabilities?.goatBotTaskRetry === true,
    rowsForTask,
    onSendToTask: (
      selectedTask: ChannelTaskId,
      text: string,
      attachments: ReadonlyArray<GoatBotDraftAttachment> = [],
      questionId?: ChannelQuestionId,
    ) => {
      if (!sendable || availability.kind !== "ready") return false;
      if (attachments.length > 0 && attachmentSupport === null) return false;
      return queue.submit(text, availability.bot, attachments, selectedTask, questionId);
    },
    onSend: (text: string, attachments: ReadonlyArray<GoatBotDraftAttachment> = []) => {
      if (!sendable || availability.kind !== "ready") return false;
      if (attachments.length > 0 && attachmentSupport === null) return false;
      return queue.submit(text, availability.bot, attachments, taskId ?? undefined);
    },
    onRetryInput: (key: string) => {
      if (sendable) queue?.retry(key);
    },
    onDiscardInput: (key: string) => queue?.discard(key),
    onRetryAvailability: () => {
      if (environmentId === null) return;
      const current = useSessions.getState().sessions.get(environmentId);
      if (current && current.notHome === null)
        update(environmentId, { ...current, machine: retryGoatBotEnsure(current.machine) });
    },
  };
}
