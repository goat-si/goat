import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { foldLaunchedThreads } from "@goat/client-runtime/state/launch-fold";
import { isRemoteDelegatedChild } from "@goat/shared/threadLaunchState";
import {
  type PendingSubagentRequest,
  type EnvironmentThreadShell,
  presentThreadShell,
} from "@goat/client-runtime/state/models";
import { pendingSubagentRequestsByThread } from "@goat/client-runtime/state/threads";
import type { AnyRouter } from "@tanstack/react-router";
import type {
  DecisionFeed,
  DecisionHandoff,
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@goat/contracts";
import { isGoatBotSessionThreadId, isSideChatThread } from "@goat/contracts";
import type { ClientSettings } from "@goat/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "~/components/solar";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform } from "../lib/utils";
import { environmentSummaries } from "../state/presentation";
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
  createApprovalNotificationGate,
  feedOwnedApprovalThreads,
  createThreadNotificationGate,
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

  // Completions fire from a timer, so read settings, focus and route when presenting.
  const presentApproval = (environmentId: EnvironmentId, entry: DecisionHandoff) => {
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const threadId = entry.handoff.requestedBy.threadId;
    // A GOAT Bot session asks through its bot, as its other requests do.
    if (isGoatBotSessionThreadId(threadId)) return;
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
  ) => {
    let { thread } = state;
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
        type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
        title,
        description: thread.title,
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
        body: thread.title,
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
    const feedOwned = feedOwnedApprovalThreads(threads, entry.feedReady);
    entry.baselineMs ??= threads.reduce(
      (latest, raw) => Math.max(latest, DateTime.toEpochMillis(raw.updatedAt)),
      0,
    );
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      // Subagents report through their parent; a side chat answers in its open panel; a GOAT
      // Bot session replies through the bot, after its receipt.
      if (
        rawThread.lineage.relationshipToParent === "subagent" ||
        isSideChatThread(rawThread) ||
        isGoatBotSessionThreadId(rawThread.id)
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
      const attention =
        !feedOwned.has(rawThread.id) &&
        (status === "input" ||
          status === "request" ||
          status === "approval" ||
          status === "failed" ||
          status === "limited")
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const settled = status === "ready" && thread.latestRun?.status === "completed";
      const state = {
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        feedOwned: feedOwned.has(rawThread.id),
        attention,
        settled,
        completedAt: settled && Number.isFinite(completedAt) ? completedAt : null,
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
      unsubscribe: () => {},
      gate: createThreadNotificationGate<ThreadId>((threadId, kind) => {
        const state = entry.previous.get(threadId);
        if (!state) return;
        // An approval the shell announced is not announced again by the feed.
        const request = state.raw.pendingRuntimeRequest;
        if (request?.handoff !== undefined) entry.approvals.remember(request.id);
        present(environmentId, state, kind);
      }),
      approvals: createApprovalNotificationGate<string>((handoffId) => {
        const handoff = handoffs.get(handoffId);
        if (handoff) presentApproval(environmentId, handoff);
      }),
    };
    // Held for as long as notifications watch this environment, whatever is on screen.
    const unsubscribeFeed = registry.subscribe(
      serverEnvironment.decisionFeed(environmentId),
      (feed: DecisionFeed | null) => {
        if (feed?.handoffs === undefined) return;
        entry.feedReady = true;
        handoffs = new Map(feed.handoffs.map((item) => [item.handoff.handoffId, item]));
        // On the first list, only approvals newer than the first shell snapshot opened unseen.
        const since = entry.baselineMs;
        entry.approvals.observe([...handoffs.keys()], (id) => {
          const created = handoffs.get(id)?.handoff.createdAt;
          return since !== null && created !== undefined && DateTime.toEpochMillis(created) > since;
        });
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
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
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
    unsubscribeEnvironmentIds();
    for (const entry of watched.values()) entry.unsubscribe();
    watched.clear();
    stopModeListeners();
  };
}
