import {
  MEMORY_REPORT_MAX_AUTOMATIC_ATTEMPTS,
  type EnvironmentId,
  type MemoryIndexCoverage,
  type MemoryProcessingStatus,
  type MemoryResetReportAttemptsResult,
  type MemoryStorageStatus,
  type MemoryHistoryPage,
  type MemoryItem,
  type MemoryLocalAvailability,
  type MemoryMutationReceipt,
  type MemoryOwnerSourceReadPolicyView,
  type MemoryReportDelivery,
  type MemoryReportReference,
  type MemoryRevertResult,
  type MemoryRevisionId,
  type MemorySyncStatus,
  type MemoryHubDiagnostics,
  type ExecutionEnvironmentCapabilities,
  type MemoryTaskGrantCeiling,
} from "@goat/contracts";

const MEMORY_REVOCATION_NOTICE =
  "Removing a device applies to later requests and to results still on the hub.";
export const MEMORY_FORGET_NOTICE =
  "The provider's original conversation stays, but forgotten content is never imported again.";

/** Navigation identity only. Renderers still check destination capability and live read permission. */
export function memoryReportTarget(reference: MemoryReportReference) {
  return {
    environmentId: reference.environmentId,
    memorySpaceId: reference.memorySpaceId,
    memoryId: reference.memoryId,
    ...(reference.resolutionId === undefined ? {} : { resolutionId: reference.resolutionId }),
  };
}

export function presentMemoryAvailability(availability: MemoryLocalAvailability) {
  if (availability.exposure === "forgotten") {
    return { label: "Forgotten memory", detailsAvailable: false, canForget: false };
  }
  if (availability.exposure === "visible") {
    return { label: "Available", detailsAvailable: true, canForget: true };
  }
  const reasons = availability.reasons;
  const label = reasons.includes("secret_detected")
    ? "Held for sensitive content"
    : reasons.includes("forget_pending")
      ? "Forgetting memory"
      : reasons.includes("scanner_pending")
        ? "Checking content"
        : reasons.includes("dependency_invalidated")
          ? "Original content unavailable"
          : reasons.includes("missing_parent")
            ? "Waiting for earlier memory"
            : "On hold";
  return { label, detailsAvailable: false, canForget: !reasons.includes("forget_pending") };
}

export function presentMemoryItem(item: MemoryItem) {
  const availability = presentMemoryAvailability(item.localAvailability);
  return {
    ...availability,
    label: item.status === "quarantined" ? "Conflicting memory on hold" : availability.label,
    syncLabel: item.pendingSync ? "Waiting to sync" : null,
    cleanupLabel: item.localAvailability.cleanupPending ? "Cleaning up remaining content" : null,
    canEdit: item.status === "active" && availability.detailsAvailable,
  };
}

const REVERT_LABELS = {
  refused: "Revert attempt refused",
  pending: "Waiting for revert approval",
  accepted: "Revert approved",
  revision_changed: "Memory changed; cannot revert",
  forgotten: "Forgotten memory cannot be reverted",
  revert_expired: "Revert window expired",
} as const;

const MEMORY_RESOLVER_LABELS = new Map([
  ["codex", "Codex"],
  ["claudeAgent", "Claude"],
  ["cursor", "Cursor"],
  ["grok", "Grok"],
  ["opencode", "OpenCode"],
  ["antigravity", "Antigravity"],
]);

/** Retained resolution metadata remains useful even when its judgment has been purged. */
export function presentMemoryResolution(entry: MemoryHistoryPage["resolutions"][number]) {
  const resolution = entry.resolution;
  return {
    label:
      resolution.revertsResolutionId === undefined
        ? "Automatic resolution applied"
        : "Revert applied",
    providerLabel:
      MEMORY_RESOLVER_LABELS.get(resolution.effectiveProvider) ?? resolution.effectiveProvider,
    requestedModelSelection: resolution.requestedModelSelection,
    effectiveModel: resolution.effectiveModel,
    resolvingEnvironmentId: resolution.resolvingEnvironmentId,
    appliedAtUtc: resolution.appliedAtUtc,
    revertDeadlineUtc: resolution.revertDeadlineUtc,
    judgmentAvailable: entry.payload !== null,
  };
}

export function presentMemoryRevertResult(result: MemoryRevertResult) {
  return {
    label: REVERT_LABELS[result.status],
    settled: result.status !== "pending",
    // Acceptance survives replay after expiry; visibility is a separate local milestone.
    detailsAvailable:
      result.status === "accepted" && result.localAvailability.exposure === "visible",
  };
}

/** The server retains the local space identity; clients never persist memory bodies. */
export function memoryLocalSpace(
  status: Pick<MemorySyncStatus, "state" | "memorySpaceId" | "retainedLocalSpaceId"> | null,
) {
  if (!status || status.state === "bootstrapping") return null;
  return status.state === "disabled" ? (status.retainedLocalSpaceId ?? null) : status.memorySpaceId;
}

/** UI eligibility only; the hub authorizes the intent and its deadline. */
export function presentMemoryRevert(input: {
  readonly item: MemoryItem;
  readonly entry: MemoryHistoryPage["resolutions"][number];
  readonly history: Pick<
    MemoryHistoryPage,
    "revertResults" | "revisions" | "nextCursor" | "restorableRevisionIds"
  >;
  readonly now: number;
  /** Omit while choosing an original; once selected, validate only that input. */
  readonly restoredRevisionId?: MemoryRevisionId;
  /** Legacy servers cannot fetch originals independently of the complete history. */
  readonly requireCompleteHistory?: boolean;
}) {
  const { item, entry, history, now, restoredRevisionId } = input;
  const resolution = entry.resolution;
  const result = history.revertResults.find(
    (value) => value.resolutionId === resolution.resolutionId && value.memoryId === item.memoryId,
  );
  const restorableRevisionIds = resolution.inputRevisionIds.filter(
    (id) =>
      history.restorableRevisionIds?.includes(id) ||
      history.revisions.some((pair) => pair.revision.revisionId === id && pair.payload !== null),
  );
  // A client clock can warn, but cannot establish hub expiry or close admission.
  const localDeadlineState =
    Number.isFinite(now) && now < Date.parse(resolution.revertDeadlineUtc)
      ? ("before_deadline" as const)
      : ("confirmation_needed" as const);
  const reason =
    item.memoryId !== resolution.memoryId || item.memorySpaceId !== resolution.memorySpaceId
      ? "Memory does not match"
      : item.status === "forgotten"
        ? "Forgotten memory cannot be reverted"
        : result !== undefined && result.status !== "refused"
          ? REVERT_LABELS[result.status]
          : resolution.revertsResolutionId !== undefined
            ? "A revert cannot be reverted"
            : item.status !== "active" || item.revision.revisionId !== resolution.resultRevisionId
              ? "Check the current memory before reverting"
              : input.requireCompleteHistory && history.nextCursor !== null
                ? "Load complete history before reverting"
                : restoredRevisionId !== undefined
                  ? restorableRevisionIds.includes(restoredRevisionId)
                    ? null
                    : "Selected original unavailable"
                  : restorableRevisionIds.length === 0
                    ? "Retained originals unavailable"
                    : null;
  return {
    canRevert: reason === null,
    notice:
      result?.status === "refused"
        ? `Last revert attempt was refused: ${result.failureCode.replaceAll("_", " ")}`
        : null,
    reason,
    windowLabel: "Revert once within 30 days of resolution",
    revertDeadlineUtc: resolution.revertDeadlineUtc,
    restorableRevisionIds,
    localDeadlineState,
    timeNotice:
      result === undefined && localDeadlineState === "confirmation_needed"
        ? "The hub needs to confirm the revert window"
        : null,
  };
}

/** A deleted receipt is not evidence that cleanup or hub propagation has finished. */
export function presentMemoryForget(receipt: MemoryMutationReceipt) {
  return {
    label:
      receipt.outcome === "rejected"
        ? "Forget request rejected"
        : receipt.outcome === "deleted" || receipt.outcome === "noop"
          ? "Forget request applied"
          : "Check the forget result",
    pendingSync: receipt.pendingSync,
    expansionStatus: receipt.forgetExpansion?.status ?? "unknown",
    failureCode: receipt.failureCode ?? null,
    notice: MEMORY_FORGET_NOTICE,
  };
}

export function presentMemoryOwnerPolicy(view: MemoryOwnerSourceReadPolicyView) {
  const pending = view.policy.enrollments.filter((entry) => entry.state === "pending");
  return {
    effectiveRequesterEnvironmentIds: view.policy.allowedRequesterEnvironmentIds,
    desiredRequesterEnvironmentIds: [
      ...new Set([
        ...view.policy.allowedRequesterEnvironmentIds,
        ...pending.map((entry) => entry.requesterEnvironmentId),
      ]),
    ],
    pendingEnrollments: pending.map((entry) => ({
      ...entry,
      label: "Waiting to allow this device again after removal completes",
    })),
    revocationLabel:
      view.revocationPropagation === "pending"
        ? "Syncing device removal"
        : "Device removal applied",
    notice: MEMORY_REVOCATION_NOTICE,
  };
}

/** Missing pre-feature attempt metadata is unknown, never reconstructed from failed state. */
export function presentMemoryReport(
  report: MemoryReportDelivery,
  options: {
    readonly isDeliveryOwner?: boolean;
    /** Authoritative classification/approval eligibility, supplied after the lifecycle handoff. */
    readonly isResetEligible?: boolean;
    readonly hasActiveClaim?: boolean | undefined;
  } = {},
) {
  const value = report.automaticAttempts;
  const attempts =
    value !== undefined &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MEMORY_REPORT_MAX_AUTOMATIC_ATTEMPTS
      ? value
      : null;
  const exhausted = attempts === MEMORY_REPORT_MAX_AUTOMATIC_ATTEMPTS;
  return {
    label:
      report.state === "delivered"
        ? "Report delivered"
        : report.state === "failed" && exhausted
          ? "All 10 automatic retries used"
          : report.state === "failed"
            ? "Report delivery failed"
            : "Waiting to deliver report",
    automaticAttempts: attempts,
    retryState: attempts === null ? "unknown" : exhausted ? "exhausted" : "remaining",
    // Settings alone consumes this eligibility; a future guarded command remains authoritative.
    canResetInSettings:
      report.state === "failed" &&
      exhausted &&
      options.isResetEligible === true &&
      options.isDeliveryOwner === true &&
      options.hasActiveClaim === false,
    reportTarget: report.state === "delivered" ? report.reportThread : null,
    failureCode: report.failureCode ?? null,
  };
}

/** Online is a connection state, not proof of publication, exposure or policy readiness. */
export function presentMemorySync(
  status: Pick<MemorySyncStatus, "state" | "memorySpaceId">,
  options?: {
    readonly capabilities: ExecutionEnvironmentCapabilities;
    readonly diagnostics?: MemoryHubDiagnostics;
  },
) {
  const diagnostics =
    options?.capabilities.memory?.hubDiagnostics === true ? options.diagnostics : undefined;
  const labels = {
    disabled: "Memory sharing off",
    bootstrapping: "Receiving initial memories",
    online: "Hub connected",
    offline: "Hub disconnected",
    error: "Memory sync error",
  } as const;
  return {
    label: diagnostics
      ? diagnostics.readiness === "disabled"
        ? labels.disabled
        : diagnostics.readiness === "unbound"
          ? "Connect a memory space"
          : diagnostics.readiness === "staging"
            ? labels.bootstrapping
            : diagnostics.connection === "connected"
              ? labels.online
              : diagnostics.connection === "unreachable"
                ? labels.offline
                : "Hub connection not confirmed"
      : status.state !== "disabled" && status.memorySpaceId === null
        ? "Connect a memory space"
        : labels[status.state],
    diagnostics: diagnostics?.publication.state ?? "unknown",
    readiness: diagnostics?.readiness ?? "unknown",
    connection: diagnostics?.connection ?? "unknown",
    publicationLabel:
      diagnostics?.publication.state === "last_valid" ? "Last valid settings in use" : null,
    recoverableHolds: diagnostics?.recoverableHolds ?? [],
    permanentHolds: diagnostics?.permanentHolds ?? [],
    canReconcileInSettings: diagnostics?.reconcile === "available",
  };
}

/** Saved ceiling has a legacy default; current effective access needs independent producer evidence. */
export function presentMemoryRunAccess(input: {
  readonly memoryGrantCeiling?: MemoryTaskGrantCeiling;
  readonly currentMemoryAccess?: import("@goat/contracts").MemoryCurrentAccess;
}) {
  return {
    savedCeiling: input.memoryGrantCeiling ?? "none",
    savedCeilingLabel: `Memory limit: ${{ none: "none", read: "read", read_write: "read & write" }[input.memoryGrantCeiling ?? "none"]}`,
    effectiveAccess: input.currentMemoryAccess?.access ?? ("unknown" as const),
    effectiveReason: input.currentMemoryAccess?.reason ?? null,
  };
}

/** A candidate only: approval/claim checks and the final reset decision belong to the server. */
export function isMemoryReportRetryCandidate(report: MemoryReportDelivery, owner: EnvironmentId) {
  return (
    report.state === "failed" &&
    report.automaticAttempts === MEMORY_REPORT_MAX_AUTOMATIC_ATTEMPTS &&
    report.resolvingEnvironmentId === owner
  );
}

export function presentMemoryReportReset(result: MemoryResetReportAttemptsResult) {
  return {
    label: `${result.resetCount} reports ready to retry; ${result.unchangedCount} unchanged`,
    resetCount: result.resetCount,
    unchangedCount: result.unchangedCount,
  };
}

/** Empty results only establish absence when coverage is complete. */
export function presentMemoryCoverage(
  coverage: MemoryIndexCoverage | undefined,
  resultCount: number,
) {
  const status = coverage?.status ?? "unknown";
  return {
    status,
    complete: status === "available",
    label:
      status === "unavailable"
        ? "Memory search unavailable"
        : status === "partial"
          ? "Some memories are still being indexed"
          : status === "unknown"
            ? "Memory coverage unknown"
            : "Memory search ready",
    emptyLabel:
      resultCount > 0
        ? null
        : status === "available"
          ? "No memories found"
          : "Results are incomplete; memories may still be available",
  };
}

const STORAGE_REASON_LABELS = {
  retained_revert_input: "Originals retained for revert",
  active_lease: "Waiting for active work",
  pending_work: "Work pending",
  checkpoint_pinned: "Checkpoint retained",
  storage_unavailable: "Memory storage unavailable",
  index_unavailable: "Memory search unavailable",
  fts_braked: "Search indexing paused",
  cleanup_failed: "Memory cleanup needs attention",
  report_backlog: "Reports waiting to be delivered",
  capacity_exceeded: "Memory storage limit reached",
} as const;

export function presentMemoryStorage(storage: MemoryStorageStatus) {
  const levels = ["normal", "warning", "critical", "full"] as const;
  const level = levels.reduce(
    (current, candidate) =>
      storage.quotas.some((quota) => quota.warning === candidate) ? candidate : current,
    "normal",
  );
  const reasons = [
    ...new Set([
      ...storage.warnings,
      ...storage.quotas.flatMap((quota) => quota.blockedReasons),
      ...storage.compaction.blockedReasons,
    ]),
  ];
  return {
    label:
      level === "full"
        ? "Memory storage limit reached"
        : level === "critical"
          ? "Memory storage nearly full"
          : level === "warning"
            ? "Memory storage getting full"
            : storage.measuredAtUtc === null
              ? "Memory storage usage unknown"
              : "Memory storage available",
    reasons: reasons.map((reason) => STORAGE_REASON_LABELS[reason]),
    searchLabel:
      storage.ftsAdmission.state === "braked"
        ? "Search indexing paused"
        : storage.ftsAdmission.measurementStatus === "unavailable"
          ? "Search storage usage unknown"
          : "Search indexing available",
  };
}

const GENERATION_HOLD_REASONS = {
  schema_rejected: "the model provider rejected GOAT's request format (check for a GOAT update)",
  auth: "the model provider needs you to sign in again",
  unavailable: "the memory model isn't available on this computer",
  rate_limited: "the model provider's usage limit was reached",
} satisfies Record<NonNullable<MemorySyncStatus["generationHold"]>["reason"], string>;

/**
 * When to read status again while a memory model is paused, so its next try shows without
 * polling: shortly after the scheduled try, or a minute later while that try is still running.
 */
export function memoryHoldRefreshDelayMs(
  generationHold: MemorySyncStatus["generationHold"],
  nowMs: number,
): number | null {
  if (!generationHold) return null;
  const untilTry = Date.parse(generationHold.nextAttemptAt) - nowMs;
  return untilTry > 0 ? untilTry + 15_000 : 60_000;
}

export function presentMemoryProcessing(
  processing: MemoryProcessingStatus,
  generationHold?: MemorySyncStatus["generationHold"],
  formatTime = (timestamp: string) =>
    new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
      Date.parse(timestamp),
    ),
) {
  return {
    pausedLabel: generationHold
      ? `Memory paused: ${GENERATION_HOLD_REASONS[generationHold.reason]}. Next try at ${formatTime(generationHold.nextAttemptAt)}`
      : null,
    coverage: presentMemoryCoverage(
      processing.indexCoverage,
      processing.indexCoverage.indexedItems,
    ),
    checkingLabel: processing.scannerPendingItems > 0 ? "Checking content" : null,
    heldLabel:
      processing.scannerHeldItems > 0 ? "Sensitive content on hold; forgetting is available" : null,
    waitingLabel:
      processing.missingParentItems > 0
        ? "Waiting for earlier memories"
        : processing.deferred > 0 &&
            (processing.scannerPendingItems === 0 ||
              processing.unindexedItems > 0 ||
              processing.pendingCleanupItems > 0 ||
              processing.reportBacklog > 0 ||
              processing.reportFailed > 0)
          ? "Memory processing pending"
          : null,
    cleanupLabel: processing.pendingCleanupItems > 0 ? "Cleaning up remaining content" : null,
    receiveLabel:
      processing.receiveLag === null
        ? "Sync progress unknown"
        : processing.receiveLag > 0
          ? "Receiving memories"
          : "Memories received",
    reportLabel:
      processing.reportFailed > 0
        ? "Some reports could not be delivered"
        : processing.reportBacklog > 0
          ? "Reports waiting to be delivered"
          : null,
    admissionLabel:
      processing.hubAdmissionFailures > 0 ? "Some memory changes could not be accepted" : null,
  };
}

/** A receipt describes admission; exposure independently determines whether content can be shown. */
export function presentMemoryReceipt(
  receipt: MemoryMutationReceipt,
  availability: MemoryLocalAvailability,
) {
  return {
    label:
      receipt.outcome === "rejected"
        ? "Memory change rejected"
        : receipt.outcome === "conflicted"
          ? "Conflicting memory on hold"
          : receipt.outcome === "deleted"
            ? "Forget request applied"
            : receipt.outcome === "noop"
              ? "Memory unchanged"
              : "Memory change accepted",
    syncLabel: receipt.pendingSync ? "Waiting to sync" : null,
    availability: presentMemoryAvailability(availability),
  };
}
