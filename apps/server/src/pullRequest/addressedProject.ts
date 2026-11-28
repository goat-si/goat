import type {
  OrchestrationProjectShell,
  ProjectId,
  SourceControlProviderKind,
} from "@goat/contracts";
import type { SupportedProject } from "./PullRequestService.ts";

export interface WorkspaceProjects {
  /** Every project read, with its repository identity resolved. */
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly supported: ReadonlyArray<SupportedProject>;
  readonly unimplemented: ReadonlyMap<
    string,
    { readonly kind: SourceControlProviderKind; readonly projectCount: number }
  >;
  readonly viewerRoots: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly refinedProjectIdsByHost: ReadonlyMap<string, ReadonlyArray<ProjectId>>;
}

export function ownProjectShells(
  repositories: ReadonlyArray<{
    readonly project: OrchestrationProjectShell;
    readonly upstream: boolean;
  }>,
): ReadonlyArray<OrchestrationProjectShell> {
  return repositories.filter((entry) => !entry.upstream).map((entry) => entry.project);
}

export function addressedProjectOf(
  workspace: {
    readonly projects: ReadonlyArray<OrchestrationProjectShell>;
    readonly supported: ReadonlyArray<SupportedProject>;
  },
  projectId: ProjectId,
) {
  const own = workspace.supported.find((entry) => !entry.upstream);
  if (own === undefined) return workspace.projects.find((project) => project.id === projectId);
  const identity = own.project.repositoryIdentity;
  return identity == null || identity.provider === own.api.kind
    ? own.project
    : { ...own.project, repositoryIdentity: { ...identity, provider: own.api.kind } };
}

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

// Capture before the provider read so a slow response keeps its original freshness through caches.
export const observeRead = Effect.fnUntraced(function* <A, E, R>(read: Effect.Effect<A, E, R>) {
  const observedAt = yield* Clock.currentTimeMillis;
  return { value: yield* read, observedAt };
});
