import type { BotWorkResult, ChannelBotTaskActivityEntry } from "@goat/contracts";
import { presentTaskStatus } from "./readers.ts";

export function botTaskActivityText(
  entry: ChannelBotTaskActivityEntry,
  workers: BotWorkResult["codingRows"],
): string {
  switch (entry.type) {
    case "created":
      return "Task created";
    case "status":
      return presentTaskStatus(entry.status, null).label;
    case "worker_started":
    case "worker_finished": {
      const label = entry.type === "worker_started" ? "Worker started" : "Worker finished";
      const worker = workers.find(
        (row) => row.environmentId === entry.environmentId && row.threadId === entry.threadId,
      );
      const subject =
        entry.environmentId === undefined && entry.host !== undefined
          ? `${entry.threadId} on ${entry.host}`
          : (worker?.title ?? entry.threadId);
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
