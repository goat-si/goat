import type { OrchestrationProjectShell, ProjectId } from "@goat/contracts";
import type { SupportedProject } from "./PullRequestService.ts";

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
