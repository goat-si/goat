import {
  EnvironmentId,
  MemoryId,
  MemorySpaceId,
  MemoryResolutionId,
  type MemoryItem,
  type MemoryScope,
  type MemoryOwnerSourceReadPolicyView,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@goat/contracts";
import { presentMemoryOwnerPolicy } from "@goat/client-runtime/memory-presentation";

export type MemoryScreenParams = {
  readonly environmentId?: EnvironmentId;
  readonly memorySpaceId?: MemorySpaceId;
  readonly memoryId?: MemoryId;
  readonly resolutionId?: MemoryResolutionId;
  readonly project?: ScopedProjectRef;
  readonly thread?: ScopedThreadRef;
};

/** URL params are untrusted even though in-app navigation is typed. Never replace a bad target. */
export function validateMemoryDestination(params: MemoryScreenParams | undefined) {
  if (!params) return true;
  try {
    if (params.environmentId !== undefined) EnvironmentId.make(params.environmentId);
    if (params.memorySpaceId !== undefined) MemorySpaceId.make(params.memorySpaceId);
    if (params.memoryId !== undefined) MemoryId.make(params.memoryId);
    if (params.resolutionId !== undefined) MemoryResolutionId.make(params.resolutionId);
    return (
      !(
        (params.memorySpaceId || params.memoryId || params.resolutionId) &&
        !params.environmentId
      ) &&
      !(params.memoryId && !params.memorySpaceId) &&
      !(params.resolutionId && !params.memoryId) &&
      (!params.project || params.project.environmentId === params.environmentId) &&
      (!params.thread || params.thread.environmentId === params.environmentId)
    );
  } catch {
    return false;
  }
}

export function memoryExpectedHeads(item: MemoryItem) {
  return item.status === "active"
    ? [item.revision.revisionId]
    : item.status === "quarantined"
      ? [...item.conflict.heads].sort()
      : [];
}

/** Preserve pending re-enrollments when changing an unrelated requester. */
export function toggleMemoryRequester(view: MemoryOwnerSourceReadPolicyView, id: EnvironmentId) {
  const desired = presentMemoryOwnerPolicy(view).desiredRequesterEnvironmentIds;
  return desired.includes(id) ? desired.filter((value) => value !== id) : [...desired, id];
}

export function memoryScopeForSelection(
  kind: MemoryScope["kind"],
  params: MemoryScreenParams,
  projectKey: Extract<MemoryScope, { kind: "project" }>["projectKey"] | null,
): MemoryScope | undefined {
  if (kind === "user") return { kind };
  if (kind === "project") return projectKey ? { kind, projectKey } : undefined;
  return params.thread
    ? { kind, thread: params.thread, ...(projectKey ? { projectKey } : {}) }
    : undefined;
}
