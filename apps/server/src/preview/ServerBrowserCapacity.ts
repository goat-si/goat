import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Limits from "./serverBrowserLimits.ts";
import type { SessionControl } from "./SessionControl.ts";

interface CapacityTab {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly control: SessionControl;
  readonly viewers: ReadonlySet<unknown>;
  readonly desktop: unknown | null;
  readonly recording: unknown | null;
  readonly agentOperating: boolean;
  readonly closing: boolean;
  readonly usedAt: number;
}

export function makeCapacity<T extends CapacityTab>(options: {
  readonly tabs: Map<string, T>;
  readonly pending: Map<string, { readonly agentId: string | null }>;
  readonly isShown: (tab: T) => boolean;
  readonly isActive: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly drop: (tab: T) => void;
  readonly now: () => number;
}) {
  const opening = () =>
    [...options.pending.entries()]
      .filter(([key]) => !options.tabs.has(key))
      .map(([, value]) => value);
  const serverFull = () => options.tabs.size + opening().length >= Limits.SERVER_TAB_LIMIT;
  const agentFull = (id: string) =>
    [...options.tabs.values()].filter((tab) => tab.control.agentId === id).length +
      opening().filter((pending) => pending.agentId === id).length >=
    Limits.AGENT_TAB_LIMIT;
  const idle = () =>
    [...options.tabs.values()].filter(
      (tab) =>
        tab.control.agentId !== null &&
        tab.viewers.size === 0 &&
        !(tab.desktop !== null && options.isShown(tab)) &&
        tab.usedAt < options.now() - Limits.AGENT_TAB_IDLE_MS &&
        tab.control.controller === null &&
        tab.control.handoffReason === null &&
        !tab.control.isPrivate &&
        !tab.control.isAgentStopped &&
        !tab.control.hasAgentWork &&
        !tab.agentOperating &&
        !tab.closing &&
        tab.recording === null,
    );
  const reclaim = Effect.fn("ServerBrowser.freeIdleAgentSlot")(function* (id: string) {
    if (!serverFull() || agentFull(id)) return;
    for (const tab of idle().sort((a, b) => a.usedAt - b.usedAt)) {
      if (yield* options.isActive(tab.threadId)) continue;
      if (serverFull() && !agentFull(id) && idle().includes(tab)) options.drop(tab);
      return;
    }
  });
  const closeIdle = Effect.gen(function* () {
    for (const tab of idle()) {
      if (tab.desktop === null && !(yield* options.isActive(tab.threadId)) && idle().includes(tab))
        options.drop(tab);
    }
  });
  return { atLimit: (id: string) => serverFull() || agentFull(id), reclaim, closeIdle };
}
