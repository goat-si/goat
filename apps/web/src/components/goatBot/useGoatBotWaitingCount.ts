import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

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
    users: number;
    chipRevision?: string;
    refresh: () => void;
    dispose: () => void;
  }
>();

/** Shared by the sidebar row and logo; failed pages never replace the last complete count. */
export function useGoatBotWaitingCount() {
  const { enabled, environment, generation, port } = useGoatBotEnabled();
  const environmentId = environment?.environmentId ?? null;
  const connected = environment?.connected === true;
  const count = useCounts((state) =>
    environmentId === null ? undefined : state.counts.get(environmentId),
  );
  useEffect(() => {
    if (!enabled || !connected || !port || environmentId === null || generation === 0) return;
    let observer = observers.get(environmentId);
    if (observer && (observer.port !== port || observer.generation !== generation)) {
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
        void (async () => {
          try {
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
                if (task.status === "waiting_input" && task.originAddress.kind === "goat")
                  taskIds.add(task.taskId);
              }
              cursor = page.nextCursor;
              if (cursor !== undefined) {
                if (cursors.has(cursor)) throw new Error("Repeated task cursor");
                cursors.add(cursor);
              }
              if (!alive) return;
            } while (cursor !== undefined);
            if (alive)
              useCounts.setState((state) => ({
                counts: new Map(state.counts).set(environmentId, taskIds.size),
              }));
          } catch {
            // Keep the previous complete result, including an unknown first result.
          } finally {
            pending = false;
            if (refreshAgain && alive) {
              refreshAgain = false;
              refresh();
            }
          }
        })();
      };
      const interval = window.setInterval(refresh, 60_000);
      window.addEventListener("focus", refresh);
      observer = {
        port,
        generation,
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
  }, [enabled, connected, environmentId, port, generation]);
  return enabled && connected ? count : undefined;
}

/** Chip updates while the bot screen is open also refresh the sidebar's shared count. */
export function refreshGoatBotWaitingCount(environmentId: EnvironmentId, chipRevision: string) {
  const observer = observers.get(environmentId);
  if (!observer || observer.chipRevision === chipRevision) return;
  observer.chipRevision = chipRevision;
  observer.refresh();
}
