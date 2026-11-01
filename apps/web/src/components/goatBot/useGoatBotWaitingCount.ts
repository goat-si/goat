import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { ChannelBotRef, EnvironmentId } from "@goat/contracts";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import { useGlobalAgentStore } from "~/globalAgentStore";
import { useThreadShell } from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { GoatBotChannelPort } from "./goatBotChannelPort";
import { useGoatBotEnabled } from "./useGoatBotSession";

const useCounts = create<{ counts: ReadonlyMap<EnvironmentId, number> }>(() => ({
  counts: new Map(),
}));
const observers = new Map<
  EnvironmentId,
  {
    port: GoatBotChannelPort;
    generation: number;
    supportsStatus: boolean;
    users: number;
    chipRevision?: string;
    refresh: () => void;
    dispose: () => void;
  }
>();

/**
 * One read of the badge: a single count-only status request where the server offers it, which
 * also names the bot so this client hides its thread before ever opening it. Older servers are
 * paged through every waiting task. Returns null when the read stopped early.
 */
export async function readGoatBotWaiting(input: {
  readonly port: GoatBotChannelPort;
  readonly environmentId: EnvironmentId;
  readonly supportsStatus: boolean;
  readonly alive: () => boolean;
}): Promise<{ readonly count: number; readonly bot: ChannelBotRef | null } | null> {
  const { port, environmentId } = input;
  if (input.supportsStatus) {
    const status = await port.getBotStatus(environmentId);
    return { count: status.waitingCount, bot: status.bot };
  }
  const taskIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await port.listTasks(environmentId, {
      status: ["waiting_input"],
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const task of page.tasks) {
      if (task.status === "waiting_input") taskIds.add(task.taskId);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error("Repeated task cursor");
      cursors.add(cursor);
    }
    if (!input.alive()) return null;
  } while (cursor !== undefined);
  return { count: taskIds.size, bot: null };
}

/**
 * Records the bot a status read named, unless the stored ref changed while the read was in
 * flight: an ensure that answered meanwhile (a replacement bot, say) is newer than this read.
 */
export function rememberGoatBotFromStatus(bot: ChannelBotRef, seenAtRequest: ChannelBotRef | null) {
  const known = useGlobalAgentStore.getState().botRef;
  if (known !== seenAtRequest) return;
  if (
    known?.environmentId !== bot.environmentId ||
    known.threadId !== bot.threadId ||
    known.projectId !== bot.projectId
  )
    useGlobalAgentStore.getState().setBotRef(bot);
}

/** Shared by the sidebar row and logo; failed pages never replace the last complete count. */
export function useGoatBotWaitingCount() {
  const { enabled, environment, generation, port } = useGoatBotEnabled();
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connected === true;
  const supportsStatus = environment?.supportsBotStatus === true;
  const count = useCounts((state) =>
    environmentId === null ? undefined : state.counts.get(environmentId),
  );
  useRefreshOnBotVisit(environmentId);
  useEffect(() => {
    if (!enabled || !connected || !port || environmentId === null || generation === 0) return;
    let observer = observers.get(environmentId);
    if (
      observer &&
      (observer.port !== port ||
        observer.generation !== generation ||
        observer.supportsStatus !== supportsStatus)
    ) {
      observer.dispose();
      observers.delete(environmentId);
      observer = undefined;
    }
    if (!observer) {
      let alive = true;
      let pending = false;
      let refreshAgain = false;
      const refresh = () => {
        if (!alive) return;
        if (pending) {
          refreshAgain = true;
          return;
        }
        pending = true;
        const readWaiting = async () => {
          const seenAtRequest = useGlobalAgentStore.getState().botRef;
          const result = await readGoatBotWaiting({
            port,
            environmentId,
            supportsStatus,
            alive: () => alive,
          });
          if (result === null || !alive) return;
          if (result.bot !== null) rememberGoatBotFromStatus(result.bot, seenAtRequest);
          useCounts.setState((state) => ({
            counts: new Map(state.counts).set(environmentId, result.count),
          }));
        };
        void readWaiting()
          .catch(() => {
            // Keep the previous complete result, including an unknown first result.
          })
          .finally(() => {
            pending = false;
            if (refreshAgain && alive) {
              refreshAgain = false;
              refresh();
            }
          });
      };
      const interval = window.setInterval(refresh, 60_000);
      window.addEventListener("focus", refresh);
      observer = {
        port,
        generation,
        supportsStatus,
        users: 0,
        refresh,
        dispose: () => {
          alive = false;
          window.clearInterval(interval);
          window.removeEventListener("focus", refresh);
        },
      };
      observers.set(environmentId, observer);
      refresh();
    }
    const shared = observer;
    shared.users++;
    return () => {
      shared.users--;
      if (shared.users === 0 && observers.get(environmentId) === shared) {
        shared.dispose();
        observers.delete(environmentId);
      }
    };
  }, [enabled, connected, environmentId, port, generation, supportsStatus]);
  return enabled && connected ? count : undefined;
}

/** Chip updates while the bot screen is open also refresh the sidebar's shared count. */
export function refreshGoatBotWaitingCount(environmentId: EnvironmentId, chipRevision: string) {
  const observer = observers.get(environmentId);
  if (!observer || observer.chipRevision === chipRevision) return;
  observer.chipRevision = chipRevision;
  observer.refresh();
}

function useBotThreadRef() {
  const botRef = useGlobalAgentStore((state) => state.botRef);
  return botRef === null ? null : scopeThreadRef(botRef.environmentId, botRef.threadId);
}

/**
 * The server counts only tasks that started waiting after the bot thread's last visit, so a
 * visit from any client (synced through the thread shell) re-reads the count right away.
 */
function useRefreshOnBotVisit(environmentId: EnvironmentId | null) {
  const botVisitedAt = useThreadShell(useBotThreadRef())?.lastVisitedAt ?? null;
  const seen = useRef(botVisitedAt);
  useEffect(() => {
    if (seen.current === botVisitedAt) return;
    seen.current = botVisitedAt;
    if (environmentId !== null) observers.get(environmentId)?.refresh();
  }, [botVisitedAt, environmentId]);
}

/**
 * Marks every waiting GOAT Bot task read by visiting the bot thread: the same thread.visit the
 * sidebar's mark-read uses, persisted on the server and synced to every client. Null when the
 * bot's server predates read-aware counts.
 */
export function useMarkGoatBotRead(): (() => Promise<void>) | null {
  const botThreadRef = useBotThreadRef();
  const { environment } = useGoatBotEnabled();
  const statusEnvironmentId = environment?.environmentId ?? null;
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const visit = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const capabilities =
    botThreadRef === null
      ? undefined
      : serverConfigs.get(botThreadRef.environmentId)?.environment.capabilities;
  const supported =
    capabilities?.goatBotWaitingRead === true && capabilities.threadVisitedTracking === true;
  const markRead = async () => {
    if (botThreadRef === null) return;
    const result = await visit({
      environmentId: botThreadRef.environmentId,
      input: { threadId: botThreadRef.threadId, visitedAt: new Date().toISOString() },
    });
    if (result._tag === "Success") {
      if (statusEnvironmentId !== null) observers.get(statusEnvironmentId)?.refresh();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to mark GOAT Bot tasks as read",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
  return supported ? markRead : null;
}
