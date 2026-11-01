import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";

import type { LaunchFoldThread } from "./launchFold.ts";

export const HOME = EnvironmentId.make("environment-home");
export const OTHER = EnvironmentId.make("environment-other");
export const NOW = "2026-10-27T12:00:00.000Z";

type Status = "running" | "queued" | "idle" | "completed";

export function thread(
  id: string,
  options: {
    readonly launchedBy?: string;
    readonly launcherEnvironment?: EnvironmentId | null;
    readonly via?: "thread_launch" | "create_threads" | "ssh_thread_launch" | "delegate_task";
    readonly kind?: "launch" | "promotion";
    readonly environmentId?: EnvironmentId;
    readonly subagentOf?: string;
    readonly status?: Status;
    readonly approval?: boolean;
    readonly input?: boolean;
    readonly pinned?: boolean;
    readonly snoozedUntil?: string;
    readonly settled?: boolean;
    readonly createdAt?: string;
    /** When the user last sent this thread a prompt. */
    readonly promptedAt?: string;
  } = {},
): LaunchFoldThread {
  const status = options.status ?? "completed";
  return {
    environmentId: options.environmentId ?? HOME,
    id: ThreadId.make(id),
    lineage: {
      rootThreadId: ThreadId.make(options.subagentOf ?? id),
      parentThreadId: options.subagentOf ? ThreadId.make(options.subagentOf) : null,
      relationshipToParent: options.subagentOf ? "subagent" : null,
    },
    createdAt: options.createdAt ?? "2026-10-27T10:00:00.000Z",
    latestUserMessageAt: options.promptedAt ?? null,
    latestUserAuthoredMessageAt: options.promptedAt ?? null,
    pinnedAt: options.pinned ? "2026-10-27T10:00:00.000Z" : null,
    settledOverride: options.settled ? "settled" : null,
    snoozedUntil: options.snoozedUntil ?? null,
    snoozedAt: options.snoozedUntil ? "2026-10-27T10:00:00.000Z" : null,
    hasPendingApprovals: options.approval ?? false,
    hasPendingUserInput: options.input ?? false,
    pendingBackgroundTasks: [],
    runtime: {
      status,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: null,
      lastError: null,
      updatedAt: NOW,
    },
    source: {
      pendingRuntimeRequest: null,
      ...(options.launchedBy === undefined
        ? {}
        : {
            launchedBy: {
              kind: options.kind ?? "launch",
              threadId: ThreadId.make(options.launchedBy),
              environmentId: options.launcherEnvironment ?? null,
              environmentLabel: null,
              threadTitle: null,
              via: options.via ?? "thread_launch",
            },
          }),
    },
  };
}

export const key = (id: string, environmentId = HOME) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
export const ids = (threads: readonly LaunchFoldThread[]) =>
  threads.map((entry) => String(entry.id));
