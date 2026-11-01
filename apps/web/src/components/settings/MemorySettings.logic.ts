import { randomUUID } from "../../lib/utils";
import {
  EnvironmentId,
  MemoryId,
  MemorySpaceId,
  MemoryResolutionId,
  MemoryOperationId,
  MemoryReportReference,
  supportsMemoryProtocol,
  type ExecutionEnvironmentCapabilities,
  type MemoryItem,
  type MemoryOwnerSourceReadPolicyView,
  type MemoryForgetInput,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import {
  isMemoryReportRetryCandidate,
  presentMemoryOwnerPolicy,
} from "@goat/client-runtime/memory-presentation";

function decoded<A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A | undefined {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    return undefined;
  }
}

/** Explicit destinations never inherit a project, checkout, or primary environment. */
export function validateMemorySettingsSearch(raw: Record<string, unknown>) {
  const environmentId = decoded(EnvironmentId, raw.environmentId ?? raw.machine);
  const memorySpaceId = decoded(MemorySpaceId, raw.memorySpaceId);
  const memoryId = memorySpaceId ? decoded(MemoryId, raw.memoryId) : undefined;
  const resolutionId = memoryId ? decoded(MemoryResolutionId, raw.resolutionId) : undefined;
  return {
    ...(environmentId ? { environmentId, machine: environmentId } : {}),
    ...(memorySpaceId ? { memorySpaceId } : {}),
    ...(memoryId ? { memoryId } : {}),
    ...(resolutionId ? { resolutionId } : {}),
    project: undefined,
    checkout: undefined,
  };
}
export type MemorySettingsSearch = ReturnType<typeof validateMemorySettingsSearch>;

export function memorySettingsDestination(reference: unknown) {
  const target = decoded(MemoryReportReference, reference);
  return target ? validateMemorySettingsSearch(target) : null;
}
export function isMemoryEnvironmentAvailable(
  capabilities: ExecutionEnvironmentCapabilities | undefined,
) {
  return capabilities !== undefined && supportsMemoryProtocol(capabilities);
}
export function memoryForgetIntent(
  item: MemoryItem,
  operationId = MemoryOperationId.make(randomUUID()),
): MemoryForgetInput | null {
  const heads =
    item.status === "active"
      ? [item.revision.revisionId]
      : item.status === "quarantined"
        ? [...item.conflict.heads].sort()
        : item.status === "blocked"
          ? []
          : null;
  return heads === null
    ? null
    : {
        memorySpaceId: item.memorySpaceId,
        memoryId: item.memoryId,
        expectedHeads: heads,
        operationId,
      };
}
export function memoryOwnerDesiredIds(
  view: MemoryOwnerSourceReadPolicyView,
  id: EnvironmentId,
  allowed: boolean,
) {
  const desired = presentMemoryOwnerPolicy(view).desiredRequesterEnvironmentIds;
  return allowed ? [...new Set([...desired, id])] : desired.filter((value) => value !== id);
}

/** Revalidate a selection against the current page and exact delivery owner at submission. */
export function memoryReportRetryIntent(
  environmentId: EnvironmentId,
  memorySpaceId: MemorySpaceId,
  reports: readonly import("@goat/contracts").MemoryReportDelivery[],
  selected: readonly string[],
) {
  const reportIds = [
    ...new Set(
      reports
        .filter(
          (report) =>
            selected.includes(report.reportId) &&
            isMemoryReportRetryCandidate(report, environmentId),
        )
        .map((report) => report.reportId),
    ),
  ].slice(0, 32);
  return reportIds.length > 0 ? { environmentId, memorySpaceId, reportIds } : null;
}
