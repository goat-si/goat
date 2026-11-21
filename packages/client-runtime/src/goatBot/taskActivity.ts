import type { BotWorkResult, ChannelBotTaskActivityEntry } from "@goat/contracts";
import { scopeThreadRef } from "../environment/scoped.ts";
import { presentTaskStatus } from "./readers.ts";

export function botTaskActivityWorkerRef(entry: ChannelBotTaskActivityEntry) {
  return (entry.type === "worker_started" || entry.type === "worker_finished") &&
    entry.environmentId !== undefined
    ? scopeThreadRef(entry.environmentId, entry.threadId)
    : null;
}

const workerKey = (entry: ChannelBotTaskActivityEntry) =>
  entry.type === "worker_started" || entry.type === "worker_finished"
    ? JSON.stringify([entry.host ?? null, entry.environmentId ?? null, entry.threadId])
    : null;

/** A fallback name per worker, numbered in start order when the task had more than one. */
export function botTaskActivityFallbackNames(
  entries: readonly ChannelBotTaskActivityEntry[],
): ReadonlyMap<string, string> {
  const order: string[] = [];
  for (const entry of [...entries].reverse()) {
    const key = workerKey(entry);
    if (key !== null && !order.includes(key)) order.push(key);
  }
  return new Map(
    order.map((key, index) => [key, order.length > 1 ? `Work thread ${index + 1}` : "Work thread"]),
  );
}

export function botTaskActivityFallbackName(
  entry: ChannelBotTaskActivityEntry,
  names: ReadonlyMap<string, string>,
): string | undefined {
  const key = workerKey(entry);
  return key === null ? undefined : names.get(key);
}

export function botTaskActivityText(
  entry: ChannelBotTaskActivityEntry,
  workers: BotWorkResult["codingRows"],
  threadTitle?: string | undefined,
  fallbackName?: string | undefined,
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
      const title = threadTitle?.trim() || worker?.title?.trim() || fallbackName || "Work thread";
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
