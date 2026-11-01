import type { MemoryImportCounts } from "@goat/client-runtime/memory-import-workflow";
import {
  EnvironmentId,
  MemoryId,
  MemorySpaceId,
  MemoryResolutionId,
  type MemoryItem,
  type MemoryImportOutcome,
  type MemoryImportIssue,
  type MemoryCapacityDimension,
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

/** Display aggregate workflow outcomes and safe reasons across all settled chunks. */
export function nativeMemoryImportOutcomes(counts: MemoryImportCounts) {
  const labels: Record<MemoryImportOutcome, string> = {
    created: "Added",
    revised: "Updated",
    noop: "Unchanged",
    aliased: "Linked to an existing memory",
    suppressed: "Previously forgotten; not imported",
    rejected: "Could not import",
    conflicted: "Conflicting memories on hold",
  };
  const issues: Record<MemoryImportIssue, string> = {
    unsupported_format: "Unsupported source format",
    source_missing: "Source no longer available",
    source_unreadable: "Source could not be read",
    invalid_utf8: "Source text encoding is not supported",
    path_rejected: "Source location is not allowed",
    limit_exceeded: "Import limit reached",
    source_changed: "Source changed; preview again",
    scope_unmapped: "Choose a destination scope",
    mapping_changed: "Destination changed; preview again",
    bootstrap_required: "Set up memory before importing",
    secret_detected: "Sensitive content blocked",
    storage_failed: "Could not save imported memory",
    operation_id_reused: "Import request expired; preview again",
    capacity_exceeded: "Storage limit reached",
  };
  const capacity: Record<MemoryCapacityDimension, string> = {
    body: "Memory text size limit reached",
    user_items: "User memory count limit reached",
    project_items: "Project memory count limit reached",
    thread_summaries: "Thread summary count limit reached",
    thread_items: "Thread memory count limit reached",
    space_live_items: "Memory space count limit reached",
    environment_live_items: "Environment memory count limit reached",
    live_payload_bytes: "Memory content storage limit reached",
    history: "Memory history limit reached",
    import_session_items: "Import session item limit reached",
    import_session_bytes: "Import session size limit reached",
    import_live_items: "Imported memory count limit reached",
    import_live_bytes: "Imported memory storage limit reached",
    import_source_items: "Source item limit reached",
    import_aliases: "Import link limit reached",
    import_digests: "Import fingerprint limit reached",
    permanent_metadata: "Memory metadata storage limit reached",
    lifetime_ids: "Memory identifier limit reached",
    receipts: "Saved result limit reached",
    log_tail_rows: "Sync event count limit reached",
    log_tail_bytes: "Sync event storage limit reached",
    work_items: "Pending work count limit reached",
    work_bytes: "Pending work storage limit reached",
    report_items: "Report count limit reached",
    report_bytes: "Report storage limit reached",
    relay_environment: "Device relay storage limit reached",
    relay_hub: "Hub relay storage limit reached",
    members: "Connected device limit reached",
    checkpoint_handles: "Checkpoint count limit reached",
    checkpoint_staging: "Checkpoint staging limit reached",
    derived_cache: "Memory cache storage limit reached",
    fts_indexed_text: "Search index size limit reached",
    fts_admission_brake: "Search indexing paused at the storage limit",
    import_lineage_records: "Import history count limit reached",
    import_lineage_bytes: "Import history storage limit reached",
  };
  function lines<K extends string>(names: Record<K, string>, values: Partial<Record<K, number>>) {
    return (Object.keys(names) as K[]).flatMap((key) => {
      const count = values[key] ?? 0;
      return count ? [`${names[key]}: ${count}`] : [];
    });
  }
  return [
    ...lines(labels, counts.outcomes),
    ...lines(issues, counts.issues),
    ...lines(capacity, counts.capacity),
  ];
}
