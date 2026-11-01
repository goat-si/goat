import type {
  CloudAgentProvider,
  CloudRunSummary,
  EnvironmentId,
  ScopedThreadRef,
} from "@goat/contracts";

import { scopeThreadRef } from "../environment/scoped.ts";

/**
 * Fleet's cloud agents: runs on Claude Cloud, Cursor Cloud and Devin Cloud, grouped under one
 * node per provider. This is a separate kind from Fleet's "cloud" machines, which are Boat
 * sandboxes GOAT reaches over SSH. Each run names the environment that holds its login (the
 * holder that launched or follows it) and who launched it.
 */

export type FleetCloudRunState = "running" | "finished" | "link-only";

export interface FleetCloudRun {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  readonly provider: CloudAgentProvider;
  readonly title: string;
  readonly state: FleetCloudRunState;
  readonly status: CloudRunSummary["status"];
  readonly url: string | null;
  readonly repository: string;
  readonly branch: string | null;
  /** The environment that launched or follows the run, by its connection label. */
  readonly holder: string;
  /** "GOAT" for runs GOAT launched; otherwise the outside agent that registered it. */
  readonly launchedBy: string;
  readonly updatedAt: string;
}

export interface FleetCloudAgentGroup {
  readonly kind: "cloud-agent";
  readonly provider: CloudAgentProvider;
  readonly label: string;
  readonly running: number;
  readonly runs: ReadonlyArray<FleetCloudRun>;
}

export interface FleetCloudRunSource {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly runs: ReadonlyArray<CloudRunSummary>;
}

const LABELS: Record<CloudAgentProvider, string> = {
  claudeCloud: "Claude Cloud",
  cursorCloud: "Cursor Cloud",
  devinCloud: "Devin Cloud",
};
const ORDER: ReadonlyArray<CloudAgentProvider> = ["claudeCloud", "cursorCloud", "devinCloud"];

function stateOf(run: CloudRunSummary): FleetCloudRunState {
  if (run.tracking === "link-only") return "link-only";
  return run.status === "running" || run.status === "submitting" ? "running" : "finished";
}

const shortRepository = (repository: string) => repository.replace(/^https:\/\/github\.com\//u, "");

/** Running first, then most recently changed, so finished runs settle below live ones. */
export function groupCloudAgentRuns(
  sources: ReadonlyArray<FleetCloudRunSource>,
): ReadonlyArray<FleetCloudAgentGroup> {
  const byProvider = new Map<CloudAgentProvider, FleetCloudRun[]>();
  for (const source of sources) {
    for (const run of source.runs) {
      const list = byProvider.get(run.provider) ?? [];
      list.push({
        key: `${source.environmentId}:${run.threadId}`,
        ref: scopeThreadRef(source.environmentId, run.threadId),
        provider: run.provider,
        title: run.title,
        state: stateOf(run),
        status: run.status,
        url: run.url ?? null,
        repository: shortRepository(run.repository),
        branch: run.branch ?? null,
        holder: source.label,
        launchedBy: run.launchedBy ?? "GOAT",
        updatedAt: run.updatedAt,
      });
      byProvider.set(run.provider, list);
    }
  }
  return ORDER.flatMap((provider) => {
    const runs = byProvider.get(provider);
    if (runs === undefined) return [];
    const sorted = [...runs].sort(
      (left, right) =>
        Number(right.state === "running") - Number(left.state === "running") ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.key.localeCompare(right.key),
    );
    return [
      {
        kind: "cloud-agent" as const,
        provider,
        label: LABELS[provider],
        running: sorted.filter((run) => run.state === "running").length,
        runs: sorted,
      },
    ];
  });
}
