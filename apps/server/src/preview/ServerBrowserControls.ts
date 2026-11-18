import * as Effect from "effect/Effect";
import { tabKey } from "./ServerBrowserPointer.ts";
import type { SessionControl } from "./SessionControl.ts";

interface LogicalTabControl {
  stopped: boolean;
  control?: SessionControl;
}

export const makeServerBrowserControls = () => {
  // The preview manager closes the logical tab independently of its renderer attempts.
  const records = new Map<string, LogicalTabControl>();
  const stop = (record: LogicalTabControl) => {
    record.stopped = true;
    record.control?.stopAgents();
  };
  return {
    reserve: (key: string) => {
      if (!records.has(key)) records.set(key, { stopped: false });
    },
    find: (threadId: string, tabId: string) => {
      const control = records.get(tabKey(threadId, tabId))?.control;
      return control ? { threadId, tabId, control } : undefined;
    },
    bind: (key: string, control: SessionControl, { preserveStop = false } = {}) => {
      const record = records.get(key);
      if (!record) return;
      record.control = control;
      if (preserveStop && control.isAgentStopped) record.stopped = true;
      if (record.stopped) control.stopAgents();
      else if (control.isAgentStopped) control.resumeAgents();
    },
    detach: (key: string, control: SessionControl) => {
      const record = records.get(key);
      if (record?.control === control) delete record.control;
    },
    restoreStop: (key: string, control: SessionControl) => {
      if (records.get(key)?.stopped) control.stopAgents();
    },
    close: (key: string) => {
      records.delete(key);
    },
    stopAllAgents: Effect.sync(() => {
      for (const record of records.values()) stop(record);
    }),
    controlSession: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly control: "stop" | "handBack";
    }) =>
      Effect.sync(() => {
        const record = records.get(tabKey(input.threadId, input.tabId));
        if (!record) return false;
        if (input.control === "stop") stop(record);
        else {
          record.stopped = false;
          record.control?.resumeAgents();
        }
        return true;
      }),
  };
};
