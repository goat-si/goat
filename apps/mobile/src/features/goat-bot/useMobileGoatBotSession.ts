import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  buildGoatBotTimeline,
  createGoatBotSendQueue,
  goatBotItemReaders,
  goatBotHomeReadBack,
  pickGoatBotEnvironment,
  resolveGoatBotAvailability,
  canSendToGoatBot,
  goatBotActivity,
  goatBotActivityTask,
  goatBotTurnsWaiting,
  goatBotReplyingSince,
  initialGoatBotEnsure,
  observeResidentAtom,
  residentAtomValue,
  retryGoatBotEnsure,
  settleGoatBotEnsure,
  startGoatBotEnsure,
  syncGoatBotEnsure,
  memberBotRef,
  type GoatBotEnsureMachine,
  type GoatBotAvailability,
  type GoatBotPendingInput,
} from "@goat/client-runtime/goatBot";
import { goatBotIngestInput } from "@goat/client-runtime/state/channels";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type {
  BotProfile,
  ChannelBotRef,
  ChannelTaskId,
  EnvironmentId,
  ScopedThreadRef,
} from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import { environmentCatalog } from "../../connection/catalog";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import {
  composerAttachmentFileReferenceKey,
  retainComposerAttachmentFile,
  retainComposerAttachmentUpload,
} from "../../lib/composerAttachmentFiles";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentThreadDetails } from "../../state/threads";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { useReplying } from "./useReplying";
import { markMobileGoatBotMember, mobileGoatBotMemberActive } from "./mobileGoatBotMembers";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { pickMobileGoatBotEnvironment } from "./goatBotHomeMode";
import {
  settleMobileGoatBotEnsure,
  goatBotSessionKey,
  mobileGoatBotWaitingForHome,
  type MobileGoatBotNotHome,
  type MobileGoatBotEnsureDestination,
} from "./mobileGoatBotEnsure";

interface Session {
  readonly machine: GoatBotEnsureMachine;
  readonly notHome: MobileGoatBotNotHome | null;
  readonly bot: ChannelBotRef | null;
  readonly connected: boolean;
  readonly canOperate: boolean;
  readonly queue: ReturnType<typeof createGoatBotSendQueue<DraftComposerAttachment>>;
  readonly pending: ReadonlyArray<GoatBotPendingInput>;
  readonly retain: (key: string, attachments: ReadonlyArray<DraftComposerAttachment>) => void;
  readonly dispose: () => void;
}

/** The confirmed main bot when a message may go to this thread: main's own or an active member's. */
function sendTarget(
  current: Session | undefined,
  bot: { readonly environmentId: EnvironmentId; readonly threadId: string },
) {
  const main = current?.bot;
  if (!main || main.environmentId !== bot.environmentId) return null;
  return main.threadId === bot.threadId ||
    mobileGoatBotMemberActive(bot.environmentId, bot.threadId)
    ? main
    : null;
}

const sessions = new Map<EnvironmentId, Session>();
const botNamesByThread = new Map<string, string>();
const openChatNames = new Map<string, string>();
const mobileBotNameKey = (environmentId: string, threadId: string) =>
  `${environmentId}\0${threadId}`;

function rememberMobileBotName(environmentId: string, threadId: string, name: string): void {
  botNamesByThread.set(mobileBotNameKey(environmentId, threadId), name);
}

function mobileBotNameFor(environmentId: string, threadId: string): string {
  return botNamesByThread.get(mobileBotNameKey(environmentId, threadId)) ?? "GOAT Bot";
}

function rememberOpenChatName(environmentId: string, name: string): void {
  openChatNames.set(environmentId, name);
}

const listeners = new Set<() => void>();
const EMPTY_PENDING: ReadonlyArray<GoatBotPendingInput> = [];
const NO_PERMISSION = Atom.make(false);
const NO_CONNECTION = Atom.make(null);
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function update(environmentId: EnvironmentId, session: Session) {
  sessions.set(environmentId, session);
  for (const listener of listeners) listener();
}

export async function disposeMobileGoatBotEnvironment(environmentId: EnvironmentId): Promise<void> {
  const session = sessions.get(environmentId);
  if (!session) return;
  session.dispose();
  sessions.delete(environmentId);
  for (const listener of listeners) listener();
}

/** A member's conversation, before the main bot is confirmed on this connection too. */
function memberBotTarget(member: BotProfile, main: ChannelBotRef | null) {
  return main === null
    ? { environmentId: member.environmentId, threadId: member.sessionThreadId }
    : memberBotRef(member, main);
}

function newSession(environmentId: EnvironmentId): Session {
  // A message's uploads, by its key, so a retry names the same files as the first attempt.
  const uploads = new Map<string, ReadonlyArray<DraftComposerAttachment>>();
  const retained = new Map<
    string,
    ReadonlyArray<{ readonly fileKey: string | null; readonly release: () => void }>
  >();
  const retainedUploadKeys = new Map<string, Set<string>>();
  let cleanupModule: Promise<typeof import("../../state/use-composer-drafts")> | undefined;
  let activeUpload: {
    readonly controller: AbortController;
    readonly clientKey: string;
    transfer: Promise<void> | null;
    fileKey: string | null;
  } | null = null;
  let disposed = false;
  const retainUploads = (key: string, attachments: ReadonlyArray<DraftComposerAttachment>) => {
    const releases = [...(retained.get(key) ?? [])];
    const ids = retainedUploadKeys.get(key) ?? new Set<string>();
    for (const attachment of attachments) {
      if (
        attachment.uploadEnvironmentId === undefined ||
        attachment.uploadedAttachmentId === undefined
      )
        continue;
      const id = JSON.stringify([attachment.uploadEnvironmentId, attachment.uploadedAttachmentId]);
      if (ids.has(id)) continue;
      ids.add(id);
      releases.push({
        fileKey: null,
        release: retainComposerAttachmentUpload(
          attachment.uploadEnvironmentId,
          attachment.uploadedAttachmentId,
        ),
      });
    }
    retained.set(key, releases);
    retainedUploadKeys.set(key, ids);
  };
  const cleanup = (files: ReadonlyArray<DraftComposerAttachment>) => {
    cleanupModule ??= import("../../state/use-composer-drafts").catch((error: unknown) => {
      cleanupModule = undefined;
      throw error;
    });
    void cleanupModule
      .then(({ releaseUnusedComposerAttachmentFiles }) =>
        releaseUnusedComposerAttachmentFiles(
          disposed
            ? files.map(({ uploadedAttachmentId: _id, uploadEnvironmentId: _env, ...file }) => file)
            : files,
        ),
      )
      .catch((error) => console.warn("[goat-bot] could not release attachment files", error));
  };
  const forget = (key: string, attachments: ReadonlyArray<DraftComposerAttachment>) => {
    const files = uploads.get(key) ?? attachments;
    uploads.delete(key);
    const upload = disposed && activeUpload?.clientKey === key ? activeUpload : null;
    const heldKey = upload?.transfer ? upload.fileKey : null;
    const held = (retained.get(key) ?? []).filter(
      (item) => heldKey !== null && item.fileKey === heldKey,
    );
    for (const item of retained.get(key) ?? []) if (!held.includes(item)) item.release();
    retained.delete(key);
    retainedUploadKeys.delete(key);
    const heldFiles =
      heldKey === null
        ? []
        : files.filter(
            (file) =>
              file.fileUri !== undefined &&
              composerAttachmentFileReferenceKey(file.fileUri) === heldKey,
          );
    const otherFiles =
      heldKey === null
        ? files
        : files.filter(
            (file) =>
              file.fileUri === undefined ||
              composerAttachmentFileReferenceKey(file.fileUri) !== heldKey,
          );
    if (otherFiles.length > 0 || files.length === 0) cleanup(otherFiles);
    if (upload?.transfer && held.length > 0) {
      // A transfer that ignores abort keeps only its own file while it is still in use.
      void upload.transfer
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          for (const item of held) item.release();
          cleanup(heldFiles);
        })
        .catch((error) => console.warn("[goat-bot] could not release attachment files", error));
    }
  };
  const queue = createGoatBotSendQueue<DraftComposerAttachment>({
    onForget: forget,
    makeKey: uuidv4,
    onChange: () => {
      const current = sessions.get(environmentId);
      if (current) update(environmentId, { ...current, pending: current.queue.pendingInputs() });
    },
    canDispatch: (bot) => {
      const current = sessions.get(environmentId);
      return (
        !disposed &&
        current?.connected === true &&
        current.canOperate &&
        current.machine.ensure.state === "confirmed" &&
        sendTarget(current, bot) !== null
      );
    },
    send: async ({ clientKey, text, attachments, receivedAt, bot, taskId }) => {
      const main = sendTarget(sessions.get(environmentId), bot);
      if (!main) throw new Error("GOAT Bot isn't available");
      // Each message goes to the bot it was written to, in the main bot's project.
      const fullBot = { ...main, threadId: bot.threadId };
      // Upload code loads only for messages that carry files.
      let files;
      if (attachments.length === 0) {
        files = [];
      } else {
        const controller = new AbortController();
        const upload: NonNullable<typeof activeUpload> = {
          controller,
          clientKey,
          transfer: null,
          fileKey: null,
        };
        activeUpload = upload;
        const settled = import("./goatBotAttachments").then(({ uploadGoatBotAttachments }) =>
          uploadGoatBotAttachments({
            environmentId,
            signal: controller.signal,
            onLocalTransfer: (transfer, attachment) => {
              upload.transfer = transfer;
              upload.fileKey =
                attachment.fileUri === undefined
                  ? null
                  : composerAttachmentFileReferenceKey(attachment.fileUri);
              const clear = () => {
                if (upload.transfer === transfer) {
                  upload.transfer = null;
                  upload.fileKey = null;
                }
              };
              void transfer.then(clear, clear);
            },
            attachments: uploads.get(clientKey) ?? attachments,
            remember: (uploaded) => {
              if (disposed) {
                cleanup(uploaded);
                return;
              }
              uploads.set(clientKey, uploaded);
              retainUploads(clientKey, uploaded);
            },
          }),
        );
        try {
          files = await settled;
        } finally {
          activeUpload = null;
        }
      }
      if (disposed) throw new Error("GOAT Bot environment was removed");
      const result = await runAtomCommand(appAtomRegistry, channelEnvironment.ingest, {
        environmentId,
        input: goatBotIngestInput({
          bot: fullBot,
          text,
          attachments: files,
          clientMessageId: clientKey,
          receivedAt,
          ...(taskId === undefined ? {} : { taskId }),
        }),
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (attachments.length > 0) {
        forget(clientKey, attachments);
      }
      return {
        requestKey: result.value.inputId,
        ...(result.value.state === "rejected"
          ? {
              rejected: `${mobileBotNameFor(bot.environmentId, bot.threadId)} did not accept this message`,
            }
          : {}),
      };
    },
  });
  return {
    machine: initialGoatBotEnsure,
    notHome: null,
    bot: null,
    connected: false,
    canOperate: false,
    queue,
    pending: EMPTY_PENDING,
    retain: (key, attachments) => {
      retained.set(
        key,
        attachments.flatMap((attachment) =>
          attachment.fileUri === undefined
            ? []
            : [
                {
                  fileKey: composerAttachmentFileReferenceKey(attachment.fileUri),
                  release: retainComposerAttachmentFile(attachment.fileUri, () => {}),
                },
              ],
        ),
      );
      retainUploads(key, attachments);
    },
    dispose: () => {
      disposed = true;
      activeUpload?.controller.abort();
      queue.dispose();
    },
  };
}

/** A stable snapshot and a single ensure/send queue per destination environment. */
/** A worker thread's detail only while another screen keeps it loaded; never loads it. */
function useResidentThreadProjection(ref: ScopedThreadRef | null) {
  const atom = ref === null ? null : environmentThreadDetails.threadAtom(ref);
  const resident = atom !== null && residentAtomValue(appAtomRegistry, atom) !== null;
  const subscribe = useCallback(
    (onChange: () => void) =>
      atom === null || !resident ? () => {} : observeResidentAtom(appAtomRegistry, atom, onChange),
    [atom, resident],
  );
  const thread = useSyncExternalStore(subscribe, () =>
    atom === null ? null : residentAtomValue(appAtomRegistry, atom),
  );
  return thread?.projection ?? null;
}

/**
 * GOAT Bot's conversation on this phone. With a member, the same environment session sends to
 * that member's own conversation once the environment's bot is confirmed.
 */
export function useMobileGoatBotSession(
  visible: boolean,
  requestedTaskId?: ChannelTaskId | null,
  member: BotProfile | null = null,
  main: BotProfile | null = null,
) {
  if (member !== null)
    rememberMobileBotName(member.environmentId, member.sessionThreadId, member.name);
  if (main !== null) rememberMobileBotName(main.environmentId, main.sessionThreadId, main.name);
  const home = useMobileGoatBotHomeMode();
  const environment = home.home.supported
    ? pickGoatBotEnvironment(home.environments, home.botRef)
    : pickMobileGoatBotEnvironment(home.environments, home.botRef);
  const environmentId = environment?.environmentId ?? null;
  if (environmentId !== null)
    rememberOpenChatName(environmentId, member?.name ?? main?.name ?? "GOAT Bot");
  const configs = useServerConfigs();
  const capabilities =
    environmentId === null ? undefined : configs.get(environmentId)?.environment.capabilities;
  const supportsTaskThreads = capabilities?.goatBotTaskThreads === true;
  const taskId = supportsTaskThreads ? requestedTaskId : null;
  const threads = useEnvironmentQuery(
    environmentId !== null && environment?.connected && supportsTaskThreads
      ? channelEnvironment.listBotThreads({
          environmentId,
          input: member === null ? {} : { botId: member.botId },
        })
      : null,
  );
  const knownTaskIds = useMemo(
    () =>
      (threads.data?.rows ?? []).flatMap((row) => (row.kind === "task" ? [row.task.taskId] : [])),
    [threads.data],
  );
  const connection = useAtomValue(
    environmentId === null ? NO_CONNECTION : environmentCatalog.stateAtom(environmentId),
  );
  const generation =
    connection !== null && AsyncResult.isSuccess(connection) ? connection.value.generation : null;
  const canEnsure = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.ensureBot.permissionAtom(environmentId),
  );
  const canIngest = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.ingest.permissionAtom(environmentId),
  );
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  // oxlint-disable react/preserve-manual-memoization -- External-store reads are mutable; useSyncExternalStore needs a stable reader.
  const getSnapshot = useCallback(
    () => (environmentId === null ? undefined : sessions.get(environmentId)),
    [environmentId],
  );
  // oxlint-enable react/preserve-manual-memoization
  const session = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const connected = environment?.connected === true;
  const capable = environment?.supportsChannelLedger === true;
  const selection = home.home;
  const homeKey = !selection.supported
    ? "legacy"
    : selection.resolution.state === "claimed"
      ? `${selection.resolution.claim.environmentId}:${selection.resolution.claim.claimedAt}:${selection.resolution.claim.claimId}`
      : selection.resolution.state;
  const settingsSnapshot = environment?.settingsSnapshot ?? null;
  const homeReady = home.loaded && (!selection.supported || goatBotHomeReadBack(selection));
  const connectionKey =
    connected && capable ? goatBotSessionKey({ environmentId, generation, homeKey }) : null;
  const canOperate =
    canEnsure &&
    canIngest &&
    homeReady &&
    !mobileGoatBotWaitingForHome(session?.notHome ?? null, homeKey, settingsSnapshot);
  const selectedDestination = useRef<
    (MobileGoatBotEnsureDestination & { readonly homeKey: string }) | null
  >(null);
  useLayoutEffect(() => {
    selectedDestination.current = { environmentId, connectionKey, homeKey };
    return () => {
      selectedDestination.current = null;
      if (environmentId === null) return;
      const previous = sessions.get(environmentId);
      // Returning to this environment must start a fresh request, even if the
      // old connection generation has not changed.
      if (previous && previous.machine.pending !== null) {
        update(environmentId, {
          ...previous,
          machine: retryGoatBotEnsure(previous.machine),
        });
      }
    };
  }, [environmentId, connectionKey, homeKey]);

  useEffect(() => {
    if (environmentId === null) return;
    const previous = sessions.get(environmentId) ?? session ?? newSession(environmentId);
    const waiting = mobileGoatBotWaitingForHome(previous.notHome, homeKey, settingsSnapshot);
    const notHome = waiting ? previous.notHome : null;
    const machine = syncGoatBotEnsure(
      previous.notHome !== null && !waiting
        ? retryGoatBotEnsure(previous.machine)
        : previous.machine,
      connectionKey,
    );
    let current = previous;
    if (
      !sessions.has(environmentId) ||
      machine !== previous.machine ||
      notHome !== previous.notHome ||
      previous.connected !== connected ||
      previous.canOperate !== canOperate
    ) {
      current = {
        ...previous,
        machine,
        notHome,
        connected,
        canOperate,
        bot: machine === previous.machine ? previous.bot : null,
      };
      update(environmentId, current);
    }
    if (
      !visible ||
      !home.loaded ||
      !homeReady ||
      waiting ||
      connectionKey === null ||
      !canEnsure ||
      current.machine.ensure.state !== "idle"
    )
      return;
    const request = startGoatBotEnsure(current.machine);
    update(environmentId, { ...current, machine: request.machine });
    const settle = (
      result: Parameters<typeof settleGoatBotEnsure>[2],
      bot: ChannelBotRef | null = null,
      notHome = false,
    ) => {
      const latest = sessions.get(environmentId);
      if (!latest) return;
      const liveConnection = appAtomRegistry.get(environmentCatalog.stateAtom(environmentId));
      const selected = selectedDestination.current;
      const liveConnectionKey =
        AsyncResult.isSuccess(liveConnection) &&
        liveConnection.value.phase === "connected" &&
        selected
          ? goatBotSessionKey({
              environmentId,
              generation: liveConnection.value.generation,
              homeKey: selected.homeKey,
            })
          : null;
      const settled = settleMobileGoatBotEnsure(
        latest.machine,
        request.token,
        result,
        { environmentId, connectionKey },
        selected && {
          environmentId: selected.environmentId,
          connectionKey: selected.connectionKey === liveConnectionKey ? liveConnectionKey : null,
        },
      );
      if (settled === latest.machine) return;
      update(environmentId, {
        ...latest,
        machine: notHome ? retryGoatBotEnsure(latest.machine) : settled,
        notHome: notHome ? { homeKey, settingsSnapshot } : null,
        bot,
        canOperate: notHome ? false : latest.canOperate,
      });
      if (bot) savePreferences({ goatBotRef: bot });
    };
    void (async () => {
      try {
        const result = await runAtomCommand(appAtomRegistry, channelEnvironment.ensureBot, {
          environmentId,
          input: {},
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        settle({ kind: "confirmed", bot: result.value }, result.value);
      } catch (error) {
        const reason =
          typeof error === "object" && error !== null && "reason" in error ? error.reason : null;
        const legacy = reason === "legacy_active";
        settle(
          legacy
            ? { kind: "legacy_active" }
            : {
                kind: "failed",
                message:
                  error instanceof Error
                    ? error.message
                    : `Couldn't reach ${openChatNames.get(environmentId ?? "") ?? "GOAT Bot"}`,
              },
          null,
          reason === "not_home",
        );
      }
    })();
  }, [
    environmentId,
    connected,
    connectionKey,
    canOperate,
    canEnsure,
    home.loaded,
    homeReady,
    homeKey,
    settingsSnapshot,
    visible,
    savePreferences,
    session,
  ]);

  const ensure =
    session?.machine.generation === connectionKey
      ? session.machine.ensure
      : initialGoatBotEnsure.ensure;
  const confirmedBot = ensure.state === "confirmed" ? (session?.bot ?? null) : null;
  const bot = confirmedBot ?? home.botRef;
  const threadRef = useMemo(
    () => (visible && bot ? scopeThreadRef(bot.environmentId, bot.threadId) : null),
    [visible, bot],
  );
  const shell = useThreadShell(threadRef);
  const shellReadiness = useEnvironmentShellReadiness(
    visible ? (bot?.environmentId ?? null) : null,
  );
  const seenBot = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !confirmedBot || shellReadiness.status !== "live") return;
    const key = `${confirmedBot.environmentId}:${confirmedBot.threadId}`;
    if (shell !== null && shell.deletedAt == null) {
      seenBot.current = key;
      return;
    }
    // A live snapshot can precede the bot-creation event. Re-ensure only a
    // deleted shell or a bot we already observed before it disappeared.
    if (shell?.deletedAt == null && seenBot.current !== key) return;
    const current = sessions.get(confirmedBot.environmentId);
    if (current?.machine.ensure.state === "confirmed") {
      seenBot.current = null;
      update(confirmedBot.environmentId, {
        ...current,
        bot: null,
        machine: retryGoatBotEnsure(current.machine),
      });
    }
  }, [visible, confirmedBot, shell, shellReadiness.status]);
  // The shell watch above stays on the main bot; a member's state comes from its profile.
  // A member answers only through its own environment's session.
  const memberActive =
    member !== null && member.state !== "deleted" && member.environmentId === environmentId;
  const memberThreadId = member?.sessionThreadId ?? null;
  // oxlint-disable-next-line goat/react-effect-budget -- Publish the member's state to the environment's send queue, which outlives this screen.
  useEffect(() => {
    if (environmentId !== null && memberThreadId !== null)
      markMobileGoatBotMember(environmentId, memberThreadId, memberActive);
  }, [environmentId, memberThreadId, memberActive]);
  const target = member === null ? bot : memberBotTarget(member, bot);
  const visibleTurnItems = useThreadVisibleTurnItems({
    environmentId: visible ? (target?.environmentId ?? null) : null,
    threadId: visible ? (target?.threadId ?? null) : null,
  });
  const queue = session?.queue;
  useEffect(() => {
    if (!visible || !queue) return;
    const keys = new Set<string>();
    for (const { item } of visibleTurnItems) {
      if (item.type !== "user_message") continue;
      const presentation = goatBotItemReaders.message(item);
      if (presentation?.requestKey) keys.add(presentation.requestKey);
      if (presentation?.clientKey) keys.add(presentation.clientKey);
    }
    queue.acknowledge(keys);
  }, [visible, queue, visibleTurnItems]);
  // The roster refreshes the main bot's task list; a member's follows its own conversation here.
  const channelRevision =
    member === null
      ? null
      : visibleTurnItems
          .filter(
            ({ item }) =>
              (item.type === "notification" && item.ledgerTask !== undefined) ||
              ((item.type === "user_message" || item.type === "assistant_message") &&
                item.channel !== undefined),
          )
          .map(({ sourceItemId, item }) => sourceItemId + ":" + item.updatedAt)
          .join("|");
  const refreshThreads = threads.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Refresh a member's task list when channel records in its conversation change.
  useEffect(() => {
    if (channelRevision !== null) refreshThreads();
  }, [channelRevision, refreshThreads]);
  const targetThreadId = target?.threadId ?? null;
  const allPending = session?.pending ?? EMPTY_PENDING;
  const pendingInputs = useMemo(
    () =>
      allPending.filter(
        (input) => input.threadId === undefined || input.threadId === targetThreadId,
      ),
    [allPending, targetThreadId],
  );
  const rows = useMemo(
    () =>
      buildGoatBotTimeline({
        visibleTurnItems,
        pendingInputs,
        readers: goatBotItemReaders,
        knownTaskIds,
        ...(taskId === undefined ? {} : { taskId }),
      }),
    [visibleTurnItems, pendingInputs, taskId, knownTaskIds],
  );
  const replyingSince = useMemo(
    () => goatBotReplyingSince({ visibleTurnItems, readers: goatBotItemReaders }),
    [visibleTurnItems],
  );
  const reading = useReplying(replyingSince, visible);
  const turnsWaiting = useMemo(() => goatBotTurnsWaiting(visibleTurnItems), [visibleTurnItems]);
  const activityTask = useMemo(
    () => goatBotActivityTask({ visibleTurnItems, readers: goatBotItemReaders }),
    [visibleTurnItems],
  );
  const worker = activityTask?.chip.worker;
  // Thread keys carry no host, so remote work is never looked up locally.
  const workerRef = useMemo(
    () =>
      !visible || worker === undefined || worker.host !== undefined
        ? null
        : scopeThreadRef(worker.environmentId, worker.threadId),
    [visible, worker],
  );
  const workerShell = useThreadShell(workerRef);
  const workerProjection = useResidentThreadProjection(workerRef);
  const activity = visible
    ? goatBotActivity({
        reading,
        task: activityTask,
        worker:
          workerRef === null
            ? null
            : { shell: workerShell?.source ?? null, projection: workerProjection },
      })
    : null;
  const resolved: GoatBotAvailability =
    !selection.supported && environment === null && home.botRef !== null
      ? { kind: "offline", environmentId: home.botRef.environmentId }
      : resolveGoatBotAvailability({
          environments: selection.supported ? home.environments : environment ? [environment] : [],
          botRef: home.botRef,
          ensure,
        });
  const availability: GoatBotAvailability["kind"] | "permission" =
    resolved.kind === "ready" || resolved.kind === "connecting"
      ? connected && capable && (!canEnsure || !canIngest)
        ? "permission"
        : resolved.kind
      : resolved.kind;
  const canSend =
    visible &&
    homeReady &&
    canSendToGoatBot(resolved, canOperate) &&
    confirmedBot !== null &&
    (member === null || memberActive);
  const sendBot =
    confirmedBot === null || member === null ? confirmedBot : memberBotRef(member, confirmedBot);
  const attachmentSupport =
    capabilities?.goatBotAttachments === true && capabilities.attachmentUploads === true
      ? { maxUploadBytes: capabilities.fileAttachments?.maxUploadBytes ?? null }
      : null;
  const onSend = useCallback(
    (text: string, attachments: ReadonlyArray<DraftComposerAttachment> = []) => {
      if (!canSend || !sendBot || (!text.trim() && attachments.length === 0)) return false;
      if (!queue || !session) return false;
      const key = queue.submit(text.trim(), sendBot, attachments, taskId ?? undefined);
      session.retain(key, attachments);
      return true;
    },
    [canSend, sendBot, queue, session, taskId],
  );
  const onAnswer = useCallback(
    (answer: string, answerTask?: ChannelTaskId) => {
      if (!canSend || !sendBot || !queue || !session) return false;
      session.retain(queue.submit(answer, sendBot, [], answerTask ?? taskId ?? undefined), []);
      return true;
    },
    [canSend, sendBot, queue, session, taskId],
  );
  const onRetryInput = useCallback(
    (key: string) => {
      if (canSend) queue?.retry(key);
    },
    [canSend, queue],
  );
  const onRetryAvailability = useCallback(() => {
    if (environmentId === null) return;
    const current = sessions.get(environmentId);
    if (mobileGoatBotWaitingForHome(current?.notHome ?? null, homeKey, settingsSnapshot)) return;
    if (current)
      update(environmentId, {
        ...current,
        bot: null,
        machine: retryGoatBotEnsure(current.machine),
      });
  }, [environmentId, homeKey, settingsSnapshot]);
  return {
    rows,
    supportsTaskThreads,
    /** The environment of the bot whose history is shown; before a move confirms, the old one. */
    historyEnvironmentId: target?.environmentId ?? null,
    /** The conversation shown: the member's own, else the main bot's. */
    threadId: target?.threadId ?? null,
    replyingSince,
    activity,
    /** The bot's own turns asking a question in this chat, which the task list never shows. */
    turnsWaiting,
    canSend,
    /** Null when this server's GOAT Bot cannot take files. */
    attachmentSupport,
    availability,
    homeKnown: resolved.kind === "home_offline" ? resolved.known : false,
    homeLabel: resolved.kind === "home_offline" ? resolved.label : null,
    error:
      ensure.state === "failed"
        ? ensure.message
        : member !== null && environmentId !== null && member.environmentId !== environmentId
          ? member.name + " runs on another computer."
          : null,
    onSend,
    onAnswer,
    onRetryInput,
    onDiscardInput: (key: string) => queue?.discard(key),
    onRetryAvailability,
  };
}
