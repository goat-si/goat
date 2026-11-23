import { ProjectId, type EnvironmentId } from "@goat/contracts";
import type { OlderSettledScope } from "@goat/client-runtime/state/threads";

/** The sidebar's scope per environment: the scoped projects there, or every project. */
export function olderSettledScopes(
  environmentIds: ReadonlyArray<EnvironmentId>,
  scopedProjectKeys: ReadonlySet<string> | null,
): ReadonlyArray<OlderSettledScope> {
  if (scopedProjectKeys === null) {
    return environmentIds.map((environmentId) => ({ environmentId, projectIds: null }));
  }
  return environmentIds.flatMap((environmentId) => {
    const prefix = `${environmentId}:`;
    const projectIds = [...scopedProjectKeys].flatMap((key) =>
      key.startsWith(prefix) ? [ProjectId.make(key.slice(prefix.length))] : [],
    );
    return projectIds.length === 0 ? [] : [{ environmentId, projectIds }];
  });
}
