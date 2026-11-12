import { EnvironmentId, NodeId, ProviderInstanceId, ThreadId } from "@goat/contracts";

import type { FleetEnvironment, FleetShell } from "./fleet.ts";

const codex = ProviderInstanceId.make("codex");

export type ShellOptions = {
  readonly status?: NonNullable<FleetShell["runtime"]>["status"] | null;
  readonly background?: boolean;
  readonly approval?: boolean;
  readonly question?: boolean;
  readonly archived?: boolean;
  readonly sideChat?: boolean;
  readonly title?: string;
  readonly launchedBy?: FleetShell["source"]["launchedBy"];
  readonly subagentOf?: string;
  readonly subagentRequest?: FleetShell["pendingSubagentRequest"];
  readonly natives?: ReadonlyArray<
    readonly [id: string, child: string | null, status?: "running" | "waiting"]
  >;
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

export function shell(
  environmentId: EnvironmentId,
  id: string,
  options: ShellOptions = {},
): FleetShell {
  const status = options.status === undefined ? "running" : options.status;
  return {
    environmentId,
    id: ThreadId.make(id),
    title: options.title ?? id,
    providerInstanceId: codex,
    runtime:
      status === null
        ? null
        : {
            status,
            activeRunId: null,
            providerInstanceId: codex,
            providerName: null,
            lastError: null,
            updatedAt: "2026-10-17T00:00:00.000Z",
          },
    hasPendingApprovals: options.approval ?? false,
    hasPendingUserInput: options.question ?? false,
    pendingBackgroundTasks: options.background
      ? ([{ kind: "command" }] as unknown as FleetShell["pendingBackgroundTasks"])
      : [],
    archivedAt: options.archived ? "2026-10-17T00:00:00.000Z" : null,
    deletedAt: null,
    sideChatOf: options.sideChat ? ThreadId.make("parent") : null,
    lineage:
      options.subagentOf === undefined
        ? { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) }
        : {
            parentThreadId: ThreadId.make(options.subagentOf),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make(options.subagentOf),
          },
    pendingSubagentRequest: options.subagentRequest ?? null,
    nativeSubagents: (options.natives ?? []).map(([nativeId, child, status]) => ({
      id: NodeId.make(nativeId),
      childThreadId: child === null ? null : ThreadId.make(child),
      title: "task " + nativeId,
      status: status ?? "running",
    })),
    latestUserMessageAt: null,
    pinnedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    createdAt: options.createdAt ?? "2026-10-17T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-10-17T00:00:00.000Z",
    source:
      options.launchedBy === undefined
        ? { pendingRuntimeRequest: null }
        : { pendingRuntimeRequest: null, launchedBy: options.launchedBy },
  };
}

export const env = (environmentId: EnvironmentId, label: string, sshAliases: string[] = []) =>
  ({ environmentId, label, sshAliases }) satisfies FleetEnvironment;
