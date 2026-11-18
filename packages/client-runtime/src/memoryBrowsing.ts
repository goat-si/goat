import {
  repositoryGroupingKeyOf,
  MemoryRpcError,
  type EnvironmentId,
  type MemoryFailureCode,
  type MemoryId,
  type MemoryMoveInput,
  type MemoryMutationReceipt,
  type MemoryOperationId,
  type MemoryListInput,
  type MemoryPage,
  type MemoryProjectBinding,
  type MemoryScope,
  type MemorySearchInput,
  type RepositoryIdentity,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AsyncResult } from "effect/reactivity";

// Indexed phrase search works at every supported scope size, unlike bounded substring scans.
const MEMORY_SEARCH_MODE = "fts" satisfies MemorySearchInput["mode"];

/** Call only after binding lookup succeeds: a failed lookup cannot rule out an explicit key. */
export function memoryProjectScope(
  binding: Pick<MemoryProjectBinding, "projectKey" | "repositoryKey">,
  repositoryIdentity: RepositoryIdentity | null | undefined,
): MemoryScope | null {
  const projectKey =
    binding.projectKey ??
    binding.repositoryKey ??
    (repositoryIdentity
      ? { kind: "repository" as const, groupingKey: repositoryGroupingKeyOf(repositoryIdentity) }
      : null);
  return projectKey ? { kind: "project", projectKey } : null;
}

type BrowseInput = Omit<MemoryListInput, "includeQuarantined">;

export function memoryBrowseInput(input: BrowseInput) {
  return { ...input, scope: input.scope ?? { kind: "user" as const } };
}

export function memorySearchInput(input: BrowseInput, query: string): MemorySearchInput {
  return { ...memoryBrowseInput(input), query: query.trim(), mode: MEMORY_SEARCH_MODE };
}

export function presentMemoryPage(page: MemoryPage, searching: boolean) {
  if (searching && page.indexCoverage && page.indexCoverage.status !== "available") {
    return "Results are incomplete; memories may still be available";
  }
  if (page.items.length > 0) return null;
  if (page.nextCursor) return "No matching memories on this page. Continue to the next page.";
  return searching ? "No memories found" : "No memories yet.";
}

export function memoryPreview(text: string) {
  let preview = "";
  let length = 0;
  for (const character of text) {
    if (length++ === 120) break;
    preview += character;
  }
  return preview;
}

export function memoryScopeLabel(scope: MemoryScope) {
  return scope.kind === "user" ? "User" : scope.kind === "project" ? "Project" : "Thread";
}

export const MEMORY_FORGET_SELECTION_LIMIT = 40;

export function memoryForgetRequest(
  item: import("@goat/contracts").MemoryItem,
  operationId: import("@goat/contracts").MemoryOperationId,
): import("@goat/contracts").MemoryForgetInput | null {
  if (item.status === "forgotten" || item.localAvailability.reasons.includes("forget_pending"))
    return null;
  return {
    memoryId: item.memoryId,
    memorySpaceId: item.memorySpaceId,
    operationId,
    expectedHeads:
      item.status === "active"
        ? [item.revision.revisionId]
        : item.status === "quarantined"
          ? [...item.conflict.heads].sort()
          : [],
  };
}

export type MemoryMoveCandidate = Omit<MemoryMoveInput, "operationId" | "toScope">;

export function memoryMoveCandidate(
  item: import("@goat/contracts").MemoryItem,
): MemoryMoveCandidate | null {
  if (
    item.status !== "active" ||
    item.pendingSync ||
    (item.scope.kind === "thread" && !item.scopeVersion && item.revision.provenance.sourceThread) ||
    item.localAvailability.exposure !== "visible"
  )
    return null;
  return {
    memoryId: item.memoryId,
    memorySpaceId: item.memorySpaceId,
    expectedHeads: [item.revision.revisionId],
    expectedScopeVersion: item.scopeVersion ?? 0,
    fromScope: item.scope,
  };
}

function sameMemoryScope(left: MemoryScope, right: MemoryScope): boolean {
  if (left.kind === "user") return right.kind === "user";
  if (left.kind === "thread")
    return (
      right.kind === "thread" &&
      left.thread.environmentId === right.thread.environmentId &&
      left.thread.threadId === right.thread.threadId
    );
  if (right.kind !== "project") return false;
  const a = left.projectKey;
  const b = right.projectKey;
  return a.kind === "explicit"
    ? b.kind === "explicit" && a.sharedProjectId === b.sharedProjectId
    : b.kind === "repository" && a.groupingKey === b.groupingKey;
}

export function memoryMoveCandidateCurrent(
  candidate: MemoryMoveCandidate,
  items: readonly import("@goat/contracts").MemoryItem[],
) {
  const item = items.find(({ memoryId }) => memoryId === candidate.memoryId);
  const current = item && memoryMoveCandidate(item);
  return (
    current !== null &&
    current !== undefined &&
    current.memorySpaceId === candidate.memorySpaceId &&
    current.expectedHeads[0] === candidate.expectedHeads[0] &&
    current.expectedScopeVersion === candidate.expectedScopeVersion &&
    sameMemoryScope(current.fromScope, candidate.fromScope)
  );
}

type MemoryMoveOutcome =
  | { readonly status: "moved" }
  | { readonly status: "uncertain"; readonly operationId: MemoryOperationId }
  | { readonly status: "stale" }
  | { readonly status: "refused"; readonly code: MemoryFailureCode | undefined };

type MemoryMoveAttempt = {
  readonly key: string;
  readonly outcome: MemoryMoveOutcome;
};
export type MemoryMoveAttempts = ReadonlyMap<MemoryId, MemoryMoveAttempt>;

export function memoryMoveRows(
  environmentId: EnvironmentId,
  candidates: readonly MemoryMoveCandidate[],
  destination: MemoryScope | undefined,
  attempts: MemoryMoveAttempts,
) {
  if (!destination) return [];
  return candidates
    .filter(({ fromScope }) => !sameMemoryScope(fromScope, destination))
    .map((input) => {
      const key = JSON.stringify([environmentId, destination, input]);
      const prior = attempts.get(input.memoryId);
      return {
        label: `Memory ${input.memoryId.slice(-8)}`,
        input: { ...input, toScope: destination },
        key,
        outcome: prior?.key === key ? prior.outcome : undefined,
      };
    });
}

type MoveRow = ReturnType<typeof memoryMoveRows>[number];
const isRpcError = Schema.is(MemoryRpcError);

export function canSubmitMemoryMove({ outcome }: MoveRow) {
  return outcome?.status !== "moved" && outcome?.status !== "stale";
}

function moveOutcome(
  result: AsyncResult.AsyncResult<MemoryMutationReceipt, unknown>,
  operationId: MemoryOperationId,
): MemoryMoveOutcome {
  let code: MemoryFailureCode | undefined;
  if (result._tag === "Success") {
    if (result.value.outcome === "accepted")
      return result.value.pendingSync ? { status: "uncertain", operationId } : { status: "moved" };
    code = result.value.failureCode;
  } else if (result._tag === "Failure") {
    const error = Option.getOrNull(Cause.findErrorOption(result.cause));
    if (!isRpcError(error) || error.code === "hub_unavailable" || error.code === "storage_failed")
      return { status: "uncertain", operationId };
    code = error.code;
  } else return { status: "uncertain", operationId };
  return code === "revision_changed" || code === "identity_mismatch"
    ? { status: "stale" }
    : { status: "refused", code };
}

export async function submitMemoryMoves(
  rows: readonly MoveRow[],
  createOperationId: () => MemoryOperationId,
  call: (
    input: MemoryMoveInput,
  ) => Promise<AsyncResult.AsyncResult<MemoryMutationReceipt, unknown>>,
  allowed: (candidate: MemoryMoveCandidate) => boolean,
) {
  const attempts = new Map<MemoryId, MemoryMoveAttempt>();
  let refresh = false;
  for (const { input, key, outcome: prior } of rows) {
    if (prior) attempts.set(input.memoryId, { key, outcome: prior });
    if (!allowed(input) || prior?.status === "moved" || prior?.status === "stale") continue;
    const operationId = prior?.status === "uncertain" ? prior.operationId : createOperationId();
    const outcome = moveOutcome(await call({ ...input, operationId }), operationId);
    attempts.set(input.memoryId, { key, outcome });
    refresh ||= outcome.status === "moved" || outcome.status === "stale";
  }
  return {
    attempts,
    refresh,
    allMoved: rows.every(({ input }) => attempts.get(input.memoryId)?.outcome.status === "moved"),
  };
}

export function memoryMoveOutcomeMessage(outcome: MemoryMoveOutcome): string {
  switch (outcome.status) {
    case "moved":
      return "Moved.";
    case "uncertain":
      return "Could not confirm the move. Retry uses the same request.";
    case "stale":
      return "The memory changed. Refresh or select it again before moving it.";
    case "refused":
      switch (outcome.code) {
        case "capacity_exceeded":
          return "The destination is full.";
        case "not_found":
        case "source_invalidated":
          return "The destination is no longer available.";
        case "hub_upgrade_required":
          return "Update the memory hub and its members before moving memories.";
        case "forget_pending":
        case "forgotten":
          return "The memory was forgotten or is waiting to be forgotten.";
        default:
          return "The memory could not be moved.";
      }
  }
}
