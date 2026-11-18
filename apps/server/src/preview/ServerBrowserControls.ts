import * as Effect from "effect/Effect";
import { tabKey } from "./ServerBrowserPointer.ts";
import type { SessionControl } from "./SessionControl.ts";

interface ControlTab {
  readonly threadId: string;
  readonly tabId: string;
  readonly control: SessionControl;
}

export const makeServerBrowserControls = (
  tabs: ReadonlyMap<string, ControlTab>,
  pendingTabs: ReadonlyMap<string, { readonly recovery?: ControlTab }>,
) => {
  const stopped = new Map<string, boolean>();
  const find = (threadId: string, tabId: string) => {
    const key = tabKey(threadId, tabId);
    return pendingTabs.get(key)?.recovery ?? tabs.get(key);
  };
  const rememberStop = (key: string, control: SessionControl) => {
    if (control.isAgentStopped) stopped.set(key, true);
  };
  const stop = (key: string, control: SessionControl) => {
    control.stopAgents();
    rememberStop(key, control);
  };
  return {
    find,
    rememberStop,
    restoreStop: (key: string, control: SessionControl) => {
      if (stopped.get(key)) control.stopAgents();
    },
    close: (key: string) => {
      stopped.delete(key);
    },
    stopAllAgents: Effect.sync(() => {
      for (const [key, tab] of tabs) {
        if (!pendingTabs.get(key)?.recovery) stop(key, tab.control);
      }
      for (const [key, { recovery }] of pendingTabs) {
        if (recovery) stop(key, recovery.control);
      }
    }),
    controlSession: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly control: "stop" | "handBack";
    }) =>
      Effect.sync(() => {
        const tab = find(input.threadId, input.tabId);
        if (!tab) return false;
        const key = tabKey(input.threadId, input.tabId);
        if (input.control === "stop") stop(key, tab.control);
        else {
          tab.control.resumeAgents();
          if (stopped.has(key)) stopped.set(key, false);
        }
        return true;
      }),
  };
};
