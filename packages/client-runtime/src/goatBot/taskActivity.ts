import type { ChannelBotTaskActivityEntry } from "@goat/contracts";
import { presentTaskStatus } from "./readers.ts";

export function botTaskActivityText(
  entry: ChannelBotTaskActivityEntry,
  workerTitle?: string | undefined,
): string {
  switch (entry.type) {
    case "created":
      return "Task created";
    case "status":
      return presentTaskStatus(entry.status, null).label;
    case "worker_started":
      return `Worker started · ${workerTitle ?? entry.threadId}`;
    case "worker_finished":
      return `Worker finished · ${workerTitle ?? entry.threadId}`;
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
