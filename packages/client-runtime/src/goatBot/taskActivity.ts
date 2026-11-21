import type { BotWorkResult, ChannelBotTaskActivityEntry } from "@goat/contracts";
import { scopeThreadRef } from "../environment/scoped.ts";
import { presentTaskStatus } from "./readers.ts";

export function botTaskActivityWorkerRef(entry: ChannelBotTaskActivityEntry) {
  return (entry.type === "worker_started" || entry.type === "worker_finished") &&
    entry.environmentId !== undefined
    ? scopeThreadRef(entry.environmentId, entry.threadId)
    : null;
}

export function botTaskActivityText(
  entry: ChannelBotTaskActivityEntry,
  workers: BotWorkResult["codingRows"],
  threadTitle?: string | undefined,
): string {
  switch (entry.type) {
    case "created":
      return "Task created";
    case "status":
      return presentTaskStatus(entry.status, null).label;
    case "worker_started":
    case "worker_finished": {
      const label = entry.type === "worker_started" ? "Worker started" : "Worker finished";
      const ref = botTaskActivityWorkerRef(entry);
      const worker =
        ref === null
          ? undefined
          : workers.find(
              (row) => row.environmentId === ref.environmentId && row.threadId === ref.threadId,
            );
      const title = threadTitle?.trim() || worker?.title?.trim() || "Work thread";
      const subject = entry.host === undefined ? title : `${title} on ${entry.host}`;
      return `${label} · ${subject}`;
    }
    case "pr_linked":
      return `Pull request linked · ${entry.repo}#${entry.number}`;
    case "asked":
      return `Question asked · ${entry.requestId}`;
    case "answered":
      return `Question answered · ${entry.requestId}`;
    case "snoozed":
      return "Task snoozed";
    case "unsnoozed":
      return "Task unsnoozed";
  }
}
