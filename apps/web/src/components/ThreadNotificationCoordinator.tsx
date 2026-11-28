import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@goat/client-runtime/environment";
import { runAtomCommand } from "@goat/client-runtime/state/runtime";
import { foldLaunchedThreads } from "@goat/client-runtime/state/launch-fold";
import { isRemoteDelegatedChild } from "@goat/shared/threadLaunchState";
import {
  type PendingSubagentRequest,
  type EnvironmentThreadShell,
  presentThreadShell,
} from "@goat/client-runtime/state/models";
import { pendingSubagentRequestsByThread } from "@goat/client-runtime/state/threads";
import { resolveBackgroundThreadRequest } from "./backgroundThreadAnnouncement";
import type { AnyRouter } from "@tanstack/react-router";
import type {
  DecisionFeed,
  DecisionHandoff,
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@goat/contracts";
import {
  isChannelWorkerThreadId,
  isGoatBotSessionThreadId,
  isRemoteChannelWorkerThreadId,
  isSideChatThread,
} from "@goat/contracts";
import type { ClientSettings } from "@goat/contracts/settings";
import * as DateTime from "effect/DateTime";
import { monitorHoldsWakeCompletion } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "~/components/solar";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform } from "../lib/utils";
import { environmentPresentations, environmentSummaries } from "../state/presentation";
import { channelEnvironment } from "../state/channels";
import { serverEnvironment } from "../state/server";
import { environmentShell } from "../state/shell";
import { threadFamilies } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import {
  buildSidebarSubagentIndex,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
} from "./Sidebar.logic";
import {
  approvalHandoffShownBy,
  createApprovalNotificationGate,
  feedOwnedApprovalThreads,
  notificationAttention,
  createThreadNotificationGate,
  isSnoozedForNotification,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
  readonly feedOwned: boolean;
}

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, NotificationState>;
  reconnecting: boolean;
  /** Set once the decision feed has listed approvals; from then on it announces them. */
  feedReady: boolean;
  /** Server time of the first shell snapshot: approvals older than it were open before watching. */
  baselineMs: number | null;
  threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly gate: ReturnType<typeof createThreadNotificationGate<ThreadId>>;
  readonly approvals: ReturnType<typeof createApprovalNotificationGate<string>>;
}

/**
 * Turns thread status transitions in every connected environment into sounds, in-app toasts,
 * and desktop notifications, and keeps the dock badge in step with the unread ones.
 */
export function startThreadNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const pending = new Map<string, { environmentId: EnvironmentId; notification: Notification }>();
  const watched = new Map<EnvironmentId, WatchedEnvironment>();
  const toasts = new Map<ReturnType<typeof toastManager.add>, string>();
  const closeToasts = (key?: string) => {
    for (const [id, threadKey] of toasts) {
      if (key !== undefined && key !== threadKey) continue;
      toasts.delete(id);
      toastManager.close(id);
    }
  };
  const trackToast = (id: ReturnType<typeof toastManager.add>, key: string) => {
    toasts.set(id, key);
    if (toasts.size > 1000) {
      const oldest = toasts.keys().next().value;
      if (oldest !== undefined) {
        toasts.delete(oldest);
        toastManager.close(oldest);
      }
    }
  };

  const trackNotification = (environmentId: EnvironmentId, notification: Notification) => {
    pending.get(notification.tag)?.notification.close();
    pending.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.size);
  };
  const clearPending = () => {
    for (const { notification } of pending.values()) notification.close();
    pending.clear();
    setNotificationBadge(0);
  };

  let cachedParents:
    | {
        readonly inputs: ReadonlyArray<
          readonly [EnvironmentId, ReadonlyArray<OrchestrationV2ThreadShell>]
        >;
        readonly signature: string;
        readonly expiresAt: number;
        readonly parents: ReadonlyMap<string, EnvironmentThreadShell>;
      }
    | undefined;
  const notificationParents = () => {
    const inputs = registry.get(environmentSummaries.environmentIdsAtom).flatMap((id) => {
      const shell = registry.get(environmentShell.stateValueAtom(id));
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) return [];
      return [[id, registry.get(threadFamilies.snapshotAtom(id)) ?? shell.snapshot.value] as const];
    });
    const now = Date.now();
    if (
      cachedParents !== undefined &&
      now < cachedParents.expiresAt &&
      inputs.length === cachedParents.inputs.length &&
      inputs.every(
        ([id, snapshot], index) =>
          cachedParents?.inputs[index]?.[0] === id &&
          cachedParents.inputs[index]?.[1] === snapshot.threads,
      )
    )
      return cachedParents.parents;
    const lifecycleMatters = inputs.some(([, snapshot]) =>
      snapshot.threads.some((raw) => raw.snoozedUntil != null || raw.settledOverride === "settled"),
    );
    const signature = JSON.stringify(
      inputs.map(([id, snapshot]) => [
        id,
        snapshot.threads.map((raw) => {
          const remote = isRemoteDelegatedChild({
            lineage: raw.lineage,
            launchedBy: raw.launchedBy,
          });
          const quietRemote =
            remote && raw.snoozedUntil == null && raw.pendingRuntimeRequest == null;
          return [
            raw.id,
            raw.title,
            raw.lineage,
            raw.launchedBy,
            raw.creationSource,
            raw.archivedAt,
            raw.deletedAt,
            raw.sideChatOf,
            raw.pinnedAt,
            raw.settledOverride,
            raw.snoozedUntil,
            raw.snoozedAt,
            lifecycleMatters ? raw.pendingRuntimeRequest : null,
            lifecycleMatters ? raw.pendingGuestMessageCount : null,
            !lifecycleMatters || quietRemote ? null : raw.status,
            !lifecycleMatters || quietRemote ? null : raw.activityRunStatus,
            !lifecycleMatters || quietRemote ? null : raw.pendingBackgroundTasks,
            raw.snoozedUntil == null ? null : raw.updatedAt,
            raw.snoozedUntil == null ? null : raw.latestRunCompletedAt,
          ];
        }),
      ]),
    );
    if (
      cachedParents !== undefined &&
      now < cachedParents.expiresAt &&
      cachedParents.signature === signature
    ) {
      cachedParents = {
        ...cachedParents,
        inputs: inputs.map(([id, snapshot]) => [id, snapshot.threads]),
      };
      return cachedParents.parents;
    }
    const all: EnvironmentThreadShell[] = [];
    for (const [id, snapshot] of inputs) {
      const requests = pendingSubagentRequestsByThread(snapshot.threads);
      for (const raw of snapshot.threads)
        all.push(presentThreadShell(id, raw, requests.get(raw.id) ?? null));
    }
    const visible = all.filter(
      (item) =>
        item.archivedAt === null &&
        item.deletedAt === null &&
        !isSideChatThread(item.source) &&
        item.lineage.relationshipToParent !== "subagent",
    );
    const delegatedAttentionByKey = buildSidebarSubagentIndex(all).attentionByOwnerKey;
    const fold = foldLaunchedThreads({
      visible,
      all,
      now: new Date(now).toISOString(),
      delegatedAttentionByKey,
    });
    const byKey = new Map(
      visible.map((item) => [scopedThreadKey(scopeThreadRef(item.environmentId, item.id)), item]),
    );
    const roots = new Map<string, string>();
    const rootOf = (start: string) => {
      const path: string[] = [];
      let current = start;
      while (!roots.has(current)) {
        const parent = fold.parentKeyByKey.get(current);
        if (parent === undefined) break;
        path.push(current);
        current = parent;
      }
      const root = roots.get(current) ?? current;
      for (const item of path) roots.set(item, root);
      return root;
    };
    const parents = new Map<string, EnvironmentThreadShell>();
    for (const [child, parent] of fold.parentKeyByKey) {
      const root = byKey.get(rootOf(parent));
      if (root !== undefined) parents.set(child, root);
    }
    let expiresAt = Infinity;
    for (const item of visible) {
      const at = Date.parse(item.snoozedUntil ?? "");
      if (at > now && at < expiresAt) expiresAt = at;
    }
    cachedParents = {
      inputs: inputs.map(([id, snapshot]) => [id, snapshot.threads]),
      signature,
      expiresAt,
      parents,
    };
    return parents;
  };

  const usesLocalBotAlerts = (environmentId: EnvironmentId, threadId: ThreadId) =>
    (isChannelWorkerThreadId(threadId) || isGoatBotSessionThreadId(threadId)) &&
    registry.get(environmentPresentations.presentationAtom(environmentId))?.serverConfig
      ?.environment.capabilities.goatBotAttention === true;

  const usesBotAlerts = (environmentId: EnvironmentId, threadId: ThreadId) =>
    isGoatBotSessionThreadId(threadId) ||
    isRemoteChannelWorkerThreadId(threadId) ||
    usesLocalBotAlerts(environmentId, threadId);

  const BOT_OWNERSHIP_CACHE_LIMIT = 500;
  const BOT_OWNERSHIP_CACHE_TTL_MS = 15_000;
  const BOT_OWNERSHIP_CONCURRENCY = 4;
  // Caches confirmed worker-ownership answers with a short TTL and invalidates immediately
  // when the origin's bot taskChanges stream advances.
  const botOwnershipCache = new Map<
    string,
    { readonly owned: boolean; readonly expiresAt: number; readonly revision: unknown }
  >();
  const botOriginInvalidators = new Map<EnvironmentId, () => void>();
  const botOwnershipKey = (origin: EnvironmentId, destination: EnvironmentId, threadId: ThreadId) =>
    `${origin}\u0000${destination}\u0000${threadId}`;
  const extractTaskChangeRevision = (
    result: AsyncResult.AsyncResult<unknown, unknown>,
  ): unknown => {
    const event = AsyncResult.value(result);
    if (Option.isNone(event)) return undefined;
    const payload = event.value;
    if (typeof payload !== "object" || payload === null || !("value" in payload)) {
      return undefined;
    }
    const inner = (payload as { readonly value: unknown }).value;
    if (typeof inner === "object" && inner !== null && "revision" in inner) {
      const subscription =
        "subscription" in payload
          ? (payload as { readonly subscription: unknown }).subscription
          : "";
      return `${String(subscription)}:${String((inner as { readonly revision: unknown }).revision)}`;
    }
    return inner;
  };
  const readOriginTaskChangeRevision = (origin: EnvironmentId): unknown =>
    extractTaskChangeRevision(
      registry.get(channelEnvironment.taskChanges({ environmentId: origin, input: {} })),
    );
  const invalidateOriginOwnership = (origin: EnvironmentId) => {
    const prefix = `${origin}\u0000`;
    for (const key of botOwnershipCache.keys()) {
      if (key.startsWith(prefix)) botOwnershipCache.delete(key);
    }
    const stop = botOriginInvalidators.get(origin);
    if (stop !== undefined) {
      botOriginInvalidators.delete(origin);
      stop();
    }
  };
  const watchOriginTaskChanges = (origin: EnvironmentId) => {
    if (botOriginInvalidators.has(origin)) return;
    let initialized = false;
    let lastRevision: unknown;
    const unsubscribe = registry.subscribe(
      channelEnvironment.taskChanges({ environmentId: origin, input: {} }),
      (result) => {
        const revision = extractTaskChangeRevision(result);
        if (!initialized) {
          initialized = true;
          lastRevision = revision;
          return;
        }
        if (revision !== lastRevision) {
          invalidateOriginOwnership(origin);
        }
      },
      { immediate: true },
    );
    botOriginInvalidators.set(origin, unsubscribe);
  };
  const rememberBotOwnership = (origin: EnvironmentId, key: string, owned: boolean) => {
    if (botOwnershipCache.size >= BOT_OWNERSHIP_CACHE_LIMIT && !botOwnershipCache.has(key)) {
      const oldest = botOwnershipCache.keys().next().value;
      if (oldest !== undefined) botOwnershipCache.delete(oldest);
    }
    watchOriginTaskChanges(origin);
    botOwnershipCache.set(key, {
      owned,
      expiresAt: Date.now() + BOT_OWNERSHIP_CACHE_TTL_MS,
      revision: readOriginTaskChangeRevision(origin),
    });
  };

  const owningOrigins = (destination: EnvironmentId, source?: OrchestrationV2ThreadShell) =>
    source?.creationSource !== undefined && source.creationSource !== "mcp"
      ? []
      : registry.get(environmentSummaries.environmentIdsAtom).filter((origin) => {
          if (
            origin === destination ||
            (source?.launchedBy?.environmentId != null &&
              source.launchedBy.environmentId !== origin)
          ) {
            return false;
          }
          const presentation = registry.get(environmentPresentations.presentationAtom(origin));
          if (
            presentation?.connection !== undefined &&
            presentation.connection.phase !== "connected"
          ) {
            return false;
          }
          return (
            presentation?.serverConfig?.environment.capabilities.goatBotAttention === true &&
            registry.get(channelEnvironment.listBotAttention.permissionAtom(origin))
          );
        });

  const ownedByBot = async (
    origins: readonly EnvironmentId[],
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => {
    const now = Date.now();
    const uncached: EnvironmentId[] = [];
    for (const origin of origins) {
      const key = botOwnershipKey(origin, environmentId, threadId);
      const cached = botOwnershipCache.get(key);
      if (cached !== undefined) {
        const currentRevision = readOriginTaskChangeRevision(origin);
        if (now < cached.expiresAt && currentRevision === cached.revision) {
          if (cached.owned) return true;
          continue;
        }
        if (currentRevision !== cached.revision) {
          invalidateOriginOwnership(origin);
        } else {
          botOwnershipCache.delete(key);
        }
      }
      uncached.push(origin);
    }
    for (let index = 0; index < uncached.length; index += BOT_OWNERSHIP_CONCURRENCY) {
      const batch = uncached.slice(index, index + BOT_OWNERSHIP_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (origin) => {
          const result = await runAtomCommand(
            registry,
            channelEnvironment.listBotAttention,
            {
              environmentId: origin,
              input: { worker: { environmentId, threadId } },
            },
            { reportFailure: false },
          );
          if (result._tag === "Success") {
            const owned = result.value.ownsWorker === true;
            rememberBotOwnership(origin, botOwnershipKey(origin, environmentId, threadId), owned);
            return owned;
          }
          return false;
        }),
      );
      if (results.some(Boolean)) return true;
    }
    return false;
  };

  // Completions fire from a timer, so read settings, focus and route when presenting.
  const presentApproval = (environmentId: EnvironmentId, entry: DecisionHandoff) => {
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const threadId = entry.handoff.requestedBy.threadId;
    if (
      entry.botAttentionOwned === true &&
      registry.get(channelEnvironment.listBotAttention.permissionAtom(environmentId))
    )
      return;
    const active = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: string;
      threadId?: string;
    };
    const title = "Approval needed";
    const body = entry.threadTitle
      ? `${entry.handoff.title} · ${entry.threadTitle}`
      : entry.handoff.title;
    const open = () =>
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
    if (hasNotificationSound(mode)) {
      void playNotificationSound("input", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    if (document.visibilityState === "visible" && document.hasFocus()) {
      // The thread on screen already shows it above the composer.
      if (
        !inAppNotificationsEnabled ||
        (active.environmentId === environmentId && active.threadId === threadId)
      )
        return;
      const toastId = toastManager.add({
        onRemove: () => {
          toasts.delete(toastId);
        },
        type: "warning",
        title,
        description: body,
        data: {
          hideCopyButton: true,
          leadingIcon: (
            <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
          ),
        },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            open();
          },
        },
      });
      trackToast(toastId, scopedThreadKey(scopeThreadRef(environmentId, threadId)));
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      // One tag per approval, so two at once do not replace each other.
      const notification = new Notification(title, {
        body,
        tag: `approval:${environmentId}:${entry.handoff.handoffId}`,
        silent: true,
      });
      trackNotification(environmentId, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow?.().catch(() => undefined);
        open();
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const present = (
    environmentId: EnvironmentId,
    state: NotificationState,
    kind: ThreadNotificationKind,
    approvalTitle?: string,
  ) => {
    let { thread } = state;
    if (usesBotAlerts(environmentId, thread.id)) return;
    const { status } = state;
    if (isRemoteDelegatedChild({ lineage: thread.lineage, launchedBy: thread.source.launchedBy })) {
      const key = scopedThreadKey(scopeThreadRef(environmentId, thread.id));
      const parent = notificationParents().get(key);
      if (parent !== undefined) {
        if (kind === "completion") return;
        thread = parent;
        environmentId = parent.environmentId;
      }
    }
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const active = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: string;
      threadId?: string;
    };
    const title =
      kind === "completion"
        ? "Thread completed"
        : status === "approval"
          ? "Approval needed"
          : status === "limited"
            ? "Usage limit reached"
            : status === "failed"
              ? "Thread failed"
              : status === "request"
                ? "Guest request"
                : "Input needed";
    if (hasNotificationSound(mode)) {
      void playNotificationSound(kind, () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (active.environmentId !== environmentId || active.threadId !== thread.id)
    ) {
      const toastId = toastManager.add({
        onRemove: () => {
          toasts.delete(toastId);
        },
        type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
        title,
        description: approvalTitle ? `${approvalTitle} · ${thread.title}` : thread.title,
        data: {
          hideCopyButton: true,
          leadingIcon:
            kind === "completion" ? (
              <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
            ) : status === "approval" ? (
              <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : status === "failed" ? (
              <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
            ) : (
              <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
            ),
        },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: thread.id },
            });
          },
        },
      });
      trackToast(toastId, scopedThreadKey(scopeThreadRef(environmentId, thread.id)));
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(title, {
        body: approvalTitle ? `${approvalTitle} · ${thread.title}` : thread.title,
        tag: threadNotificationTag(environmentId, thread.id),
        silent: true,
        // Windows drops clicks after a toast moves into Notification Center.
        requireInteraction: kind === "completion" && isWindowsPlatform(navigator.platform),
      });
      trackNotification(environmentId, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow?.().catch(() => undefined);
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: thread.id },
        });
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const observeThreads = (
    environmentId: EnvironmentId,
    entry: WatchedEnvironment,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) => {
    const previous = entry.previous;
    const next = new Map<ThreadId, NotificationState>();
    const subagentRequests = pendingSubagentRequestsByThread(threads);
    // Approval handoffs notify from the decision feed, one per approval; the shell stays quiet.
    entry.threads = threads;
    const feedOwned = feedOwnedApprovalThreads(threads, entry.feedReady);
    if (entry.baselineMs === null) {
      entry.baselineMs = threads.reduce(
        (latest, raw) => Math.max(latest, DateTime.toEpochMillis(raw.updatedAt)),
        0,
      );
      entry.approvals.setBaseline(entry.baselineMs);
    }
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      // Subagents report through their parent; a side chat answers in its open panel; a GOAT
      // Bot session replies through the bot, after its receipt.
      if (
        rawThread.lineage.relationshipToParent === "subagent" ||
        isSideChatThread(rawThread) ||
        usesBotAlerts(environmentId, rawThread.id)
      )
        continue;
      const prior = previous.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (
        !entry.reconnecting &&
        prior?.raw === rawThread &&
        prior.subagentRequest === subagentRequest &&
        prior.feedOwned === feedOwned.has(rawThread.id)
      ) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const requestId = resolveBackgroundThreadRequest(thread).requestId;
      const attention = notificationAttention(
        status,
        thread.latestRun?.runId ?? "",
        feedOwned.has(rawThread.id),
        requestId,
      );
      const completed = status === "ready" && thread.latestRun?.status === "completed";
      const settled = completed && !monitorHoldsWakeCompletion(rawThread);
      const parsedCompletedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const completedAt = Number.isFinite(parsedCompletedAt) ? parsedCompletedAt : null;
      const state = {
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        feedOwned: feedOwned.has(rawThread.id),
        attention,
        requestId,
        settled,
        completedAt: settled ? completedAt : null,
        backgroundWake: rawThread.latestRunBackgroundWake === true,
      };
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    entry.reconnecting = false;
    entry.previous = next;
    entry.gate.retain(new Set(next.keys()));
    if (cachedParents !== undefined) notificationParents();
    for (const [prior, state] of changed) {
      entry.gate.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        snoozed: isSnoozedForNotification(state.thread, state.completedAt, Date.now()),
        quiet:
          state.raw.latestRunStopRequested === true ||
          state.thread.latestRun?.completionNotification === "silent",
      });
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
    let handoffs = new Map<string, DecisionHandoff>();
    const entry: WatchedEnvironment = {
      previous: new Map(),
      reconnecting: false,
      feedReady: false,
      baselineMs: null,
      threads: [],
      unsubscribe: () => {},
      gate: createThreadNotificationGate<ThreadId>((threadId, kind) => {
        const state = entry.previous.get(threadId);
        if (!state) return;
        // The approval this notification stands for is named here and not announced again.
        const shown =
          kind === "input" ? approvalHandoffShownBy(entry.threads, threadId, state.status) : null;
        if (shown) entry.approvals.remember(shown.id);
        const origins =
          state.raw.creationSource === "mcp" ? owningOrigins(environmentId, state.raw) : [];
        if (origins.length === 0) {
          present(environmentId, state, kind, shown?.title);
          return;
        }
        void ownedByBot(origins, environmentId, threadId).then((owned) => {
          const current = entry.previous.get(threadId);
          if (
            !owned &&
            watched.get(environmentId) === entry &&
            current?.attention === state.attention &&
            current?.completedAt === state.completedAt
          )
            present(environmentId, state, kind, shown?.title);
        });
      }),
      approvals: createApprovalNotificationGate<string>((handoffId) => {
        const handoff = handoffs.get(handoffId);
        if (handoff === undefined) return;
        const threadId = handoff.handoff.requestedBy.threadId;
        if (isRemoteChannelWorkerThreadId(threadId) || usesLocalBotAlerts(environmentId, threadId))
          return;
        const source = entry.threads.find((thread) => thread.id === threadId);
        const origins = owningOrigins(environmentId, source);
        if (origins.length === 0) {
          presentApproval(environmentId, handoff);
          return;
        }
        void ownedByBot(origins, environmentId, threadId).then((owned) => {
          const current = handoffs.get(handoffId);
          if (!owned && current !== undefined && watched.get(environmentId) === entry)
            presentApproval(environmentId, current);
        });
      }),
    };
    // Held for as long as notifications watch this environment, whatever is on screen.
    const unsubscribeFeed = registry.subscribe(
      serverEnvironment.decisionFeed(environmentId),
      (feed: DecisionFeed | null) => {
        if (feed?.handoffs === undefined) return;
        entry.feedReady = true;
        handoffs = new Map(feed.handoffs.map((item) => [item.handoff.handoffId, item]));
        // The gate holds its first list until the first shell snapshot gives it a server time.
        entry.approvals.observe(
          feed.handoffs.map((item) => ({
            id: String(item.handoff.handoffId),
            createdAt: DateTime.toEpochMillis(item.handoff.createdAt),
          })),
        );
      },
      { immediate: true },
    );
    const unsubscribeShell = registry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        const threads =
          shell.status === "live" && Option.isSome(shell.snapshot)
            ? shell.snapshot.value.threads
            : null;
        if (threads !== null) {
          observeThreads(environmentId, entry, threads);
          return;
        }
        entry.reconnecting = true;
        entry.gate.pause();
      },
      { immediate: true },
    );
    entry.unsubscribe = () => {
      unsubscribeFeed();
      unsubscribeShell();
      entry.gate.clear();
    };
    return entry;
  };

  const syncEnvironments = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const enabled = notificationMode !== "off" || inAppNotificationsEnabled;
    if (!enabled) closeToasts();
    const environmentIds = enabled ? registry.get(environmentSummaries.environmentIdsAtom) : [];
    const activeIds = new Set(environmentIds);
    for (const [environmentId, entry] of watched) {
      if (activeIds.has(environmentId)) continue;
      entry.unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const pruneRemovedEnvironments = () => {
    const activeIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    for (const [id, key] of toasts) {
      const threadRef = parseScopedThreadKey(key);
      if (threadRef === null || activeIds.has(threadRef.environmentId)) continue;
      toasts.delete(id);
      toastManager.close(id);
    }
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
    for (const key of botOwnershipCache.keys()) {
      const [origin, destination] = key.split("\u0000");
      if (
        origin === undefined ||
        destination === undefined ||
        !activeIds.has(origin as EnvironmentId) ||
        !activeIds.has(destination as EnvironmentId)
      ) {
        botOwnershipCache.delete(key);
      }
    }
    for (const [origin, stop] of botOriginInvalidators) {
      if (!activeIds.has(origin)) {
        botOriginInvalidators.delete(origin);
        stop();
      }
    }
  };

  // Listeners that only exist for some notification modes, rebuilt when the mode changes.
  let appliedMode: ClientSettings["notificationMode"] | null = null;
  let stopModeListeners = () => {};
  const applyMode = () => {
    const nextMode = getClientSettings().notificationMode;
    if (nextMode === appliedMode) return;
    appliedMode = nextMode;
    stopModeListeners();
    clearPending();
    const stops: Array<() => void> = [];
    if (hasDesktopNotifications(nextMode)) {
      const unsubscribeBadgeClear = window.desktopBridge?.onNotificationBadgeClear?.(clearPending);
      window.addEventListener("focus", clearPending);
      stops.push(() => {
        unsubscribeBadgeClear?.();
        window.removeEventListener("focus", clearPending);
        clearPending();
      });
    }
    if (hasNotificationSound(nextMode)) {
      document.addEventListener("pointerdown", unlockNotificationAudio);
      document.addEventListener("keydown", unlockNotificationAudio);
      stops.push(() => {
        document.removeEventListener("pointerdown", unlockNotificationAudio);
        document.removeEventListener("keydown", unlockNotificationAudio);
      });
    }
    stopModeListeners = () => {
      for (const stop of stops) stop();
    };
  };

  const onSettings = () => {
    applyMode();
    syncEnvironments();
  };
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  const unsubscribeRoute = router.subscribe("onResolved", () => {
    const active = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: EnvironmentId;
      threadId?: ThreadId;
    };
    if (active.environmentId !== undefined && active.threadId !== undefined) {
      closeToasts(scopedThreadKey(scopeThreadRef(active.environmentId, active.threadId)));
    }
  });
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      pruneRemovedEnvironments();
      syncEnvironments();
    },
  );
  onSettings();

  return () => {
    unsubscribeSettings();
    unsubscribeRoute();
    unsubscribeEnvironmentIds();
    for (const entry of watched.values()) entry.unsubscribe();
    watched.clear();
    for (const stop of botOriginInvalidators.values()) stop();
    botOriginInvalidators.clear();
    botOwnershipCache.clear();
    stopModeListeners();
    closeToasts();
  };
}
