import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  memoryReportTarget,
  memoryLocalSpace,
  isMemoryReportRetryCandidate,
  presentMemoryReportReset,
  presentMemoryCoverage,
  presentMemoryStorage,
  presentMemoryProcessing,
  memoryHoldRefreshDelayMs,
  presentMemoryReceipt,
  presentMemoryAvailability,
  presentMemoryForget,
  presentMemoryItem,
  presentMemoryOwnerPolicy,
  presentMemoryReport,
  presentMemoryResolution,
  presentMemoryRevert,
  presentMemoryRevertResult,
  presentMemoryRunAccess,
  presentMemorySync,
} from "./memoryPresentation.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const applied = "2026-10-01T00:00:00.000Z";
const deadline = "2026-10-31T00:00:00.000Z";
const processing = M.MemoryProcessingStatus.make({
  lastReceivedHubSequence: 4,
  receiveLag: null,
  deferred: 1,
  oldestDeferredAtUtc: M.MemoryUtcTimestamp.make(applied),
  unindexedItems: 1,
  scannerHeldItems: 1,
  scannerPendingItems: 1,
  missingParentItems: 1,
  pendingCleanupItems: 1,
  reportBacklog: 2,
  reportFailed: 1,
  hubAdmissionFailures: 1,
  indexCoverage: {
    status: "partial",
    eligibleItems: 2,
    indexedItems: 1,
    unindexedItems: 1,
    projectionWatermark: 4,
  },
});
const visible = M.MemoryLocalAvailability.make({
  exposure: "visible",
  reasons: [],
  deferred: [],
  cleanupPending: false,
});
const payload = M.MemoryPayload.make({
  text: "Synthetic fact",
  evidence: [{ origin: "user", messageIds: [] }],
  derivedFromMemoryRevisions: [],
});
const decodeRevertResult = Schema.decodeUnknownSync(M.MemoryRevertResult);
const decodeRevision = Schema.decodeUnknownSync(M.MemoryRevision);
const decodeOwnerView = Schema.decodeUnknownSync(M.MemoryOwnerSourceReadPolicyView);
const revision = (n: number) =>
  decodeRevision({
    memorySpaceId: id(1),
    memoryId: id(2),
    revisionId: id(n),
    operationId: id(10 + n),
    parents: [],
    scope: { kind: "user" },
    payloadRef: id(n),
    assertionKind: "fact",
    provenance: { environmentId: "owner" },
    createdAtUtc: applied,
  });
const item = {
  memorySpaceId: revision(5).memorySpaceId,
  memoryId: revision(5).memoryId,
  status: "active",
  scope: { kind: "user" },
  revision: revision(5),
  payload,
  pendingSync: true,
  localAvailability: visible,
} satisfies M.MemoryItem;
const resolution = Schema.decodeUnknownSync(M.MemoryResolution)({
  resolutionId: id(6),
  memorySpaceId: id(1),
  memoryId: id(2),
  inputRevisionIds: [id(3), id(4)],
  inputPayloadRefs: [id(3), id(4)],
  judgmentRef: id(6),
  requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
  effectiveProvider: "codex",
  effectiveModel: "synthetic",
  resolvingEnvironmentId: "owner",
  fencingToken: 1,
  resultRevisionId: id(5),
  appliedAtUtc: applied,
  revertDeadlineUtc: deadline,
});
const entry = {
  resolution,
  payload: M.MemoryResolutionPayload.make({
    resolutionId: resolution.resolutionId,
    judgment: "Synthetic judgment",
  }),
};
const history = {
  revisions: [3, 4].map((n) => ({ revision: revision(n), payload })),
  revertResults: [],
  nextCursor: null,
} satisfies Pick<M.MemoryHistoryPage, "revisions" | "revertResults" | "nextCursor">;
const report = Schema.decodeUnknownSync(M.MemoryReportDelivery)({
  reportId: "a".repeat(64),
  operationId: id(7),
  outcome: "resolved",
  resolvingEnvironmentId: "resolver",
  resolutionId: id(6),
  state: "failed",
  failureCode: "storage_failed",
  reportThread: null,
  sequence: null,
});

describe("memory presentation boundaries", () => {
  it("recovers a retained local space after a disabled status is fetched on a fresh visit", () => {
    const status = {
      state: "disabled",
      memorySpaceId: null,
      retainedLocalSpaceId: item.memorySpaceId,
    } satisfies Pick<M.MemorySyncStatus, "state" | "memorySpaceId" | "retainedLocalSpaceId">;
    expect(memoryLocalSpace(status)).toBe(item.memorySpaceId);
    expect(memoryLocalSpace({ ...status, retainedLocalSpaceId: null })).toBeNull();
    expect(
      memoryLocalSpace({ ...status, state: "bootstrapping", memorySpaceId: item.memorySpaceId }),
    ).toBeNull();
    expect(
      memoryLocalSpace({ ...status, state: "online", memorySpaceId: resolution.memorySpaceId }),
    ).toBe(resolution.memorySpaceId);
  });
  it("keeps propagation separate from usable memory", () => {
    expect(presentMemoryItem(item)).toMatchObject({
      label: "Available",
      syncLabel: "Waiting to sync",
      canEdit: true,
    });
  });
  it.each([
    ["scanner_pending", "Checking content", true],
    ["secret_detected", "Held for sensitive content", true],
    ["forget_pending", "Forgetting memory", false],
    ["missing_parent", "Waiting for earlier memory", true],
  ] as const)("presents %s without offering a rescan", (reason, label, canForget) => {
    expect(presentMemoryAvailability({ ...visible, exposure: "held", reasons: [reason] })).toEqual({
      label,
      detailsAvailable: false,
      canForget,
    });
  });
  it("does not expose forgotten details even while cleanup remains", () => {
    expect(
      presentMemoryAvailability({ ...visible, exposure: "forgotten", cleanupPending: true }),
    ).toEqual({
      label: "Forgotten memory",
      detailsAvailable: false,
      canForget: false,
    });
  });
  it.each([
    ["codex", "Codex"],
    ["claudeAgent", "Claude"],
    ["cursor", "Cursor"],
    ["grok", "Grok"],
    ["opencode", "OpenCode"],
    ["antigravity", "Antigravity"],
    ["custom-resolver", "custom-resolver"],
  ])("labels resolver %s independently of importer profiles", (driver, label) => {
    expect(
      presentMemoryResolution({
        ...entry,
        resolution: { ...resolution, effectiveProvider: M.ProviderDriverKind.make(driver) },
      }).providerLabel,
    ).toBe(label);
  });
  it("shows retained resolution metadata without regenerating purged judgment", () => {
    expect(presentMemoryResolution({ ...entry, payload: null })).toMatchObject({
      label: "Automatic resolution applied",
      providerLabel: "Codex",
      effectiveModel: "synthetic",
      resolvingEnvironmentId: "owner",
      judgmentAvailable: false,
    });
    expect(
      presentMemoryResolution({
        ...entry,
        resolution: { ...resolution, revertsResolutionId: resolution.resolutionId },
      }).label,
    ).toBe("Revert applied");
  });
  it.each([
    ["behind", Date.parse(applied), "before_deadline"],
    ["just before deadline", Date.parse(deadline) - 1, "before_deadline"],
    ["at deadline", Date.parse(deadline), "confirmation_needed"],
    ["ahead", Date.parse(deadline) + 1, "confirmation_needed"],
    ["unknown", NaN, "confirmation_needed"],
  ] as const)("keeps the client clock %s advisory", (_clock, now, localDeadlineState) => {
    expect(presentMemoryRevert({ item, entry, history, now })).toMatchObject({
      canRevert: true,
      reason: null,
      localDeadlineState,
    });
  });
  it("requires a retained original and the current result independently of the history cursor", () => {
    const input = { item, entry, history, now: Date.parse(applied) };
    const incomplete = presentMemoryRevert({
      ...input,
      history: { ...history, nextCursor: "more", revisions: [] },
    });
    const absent = presentMemoryRevert({ ...input, history: { ...history, revisions: [] } });
    expect(incomplete.canRevert).toBe(false);
    expect(absent.canRevert).toBe(false);
    expect(incomplete.reason).toBe(absent.reason);
    expect(
      presentMemoryRevert({ ...input, history: { ...history, nextCursor: "more" } }),
    ).toMatchObject({ canRevert: true, reason: null });
    expect(
      presentMemoryRevert({ ...input, item: { ...item, revision: revision(8) } }).canRevert,
    ).toBe(false);
    expect(
      presentMemoryRevert({
        ...input,
        entry: {
          ...entry,
          resolution: { ...resolution, revertsResolutionId: resolution.resolutionId },
        },
      }).canRevert,
    ).toBe(false);
  });
  it("uses bounded server retention metadata when an original is too large to preview", () => {
    expect(
      presentMemoryRevert({
        item,
        entry,
        history: {
          ...history,
          revisions: history.revisions.map((pair) => ({ ...pair, payload: null })),
          restorableRevisionIds: [revision(3).revisionId],
          nextCursor: "1",
        },
        now: Date.parse(applied),
      }),
    ).toMatchObject({ canRevert: true, restorableRevisionIds: [revision(3).revisionId] });
  });
  it("can restore a retained input without the resolution judgment", () => {
    const missingJudgment = { ...entry, payload: null };
    expect(presentMemoryResolution(missingJudgment).judgmentAvailable).toBe(false);
    expect(
      presentMemoryRevert({
        item,
        entry: missingJudgment,
        history,
        now: Date.parse(applied),
        restoredRevisionId: revision(3).revisionId,
      }),
    ).toMatchObject({ canRevert: true, reason: null });
  });
  it("offers only retained inputs and validates the chosen original", () => {
    const input = {
      item,
      entry,
      now: Date.parse(applied),
      history: {
        ...history,
        revisions: [
          { revision: revision(3), payload },
          { revision: revision(4), payload: null },
          { revision: revision(8), payload },
        ],
      },
    };
    expect(presentMemoryRevert(input)).toMatchObject({
      canRevert: true,
      restorableRevisionIds: [revision(3).revisionId],
    });
    expect(
      presentMemoryRevert({ ...input, restoredRevisionId: revision(3).revisionId }).canRevert,
    ).toBe(true);
    for (const n of [4, 8]) {
      expect(
        presentMemoryRevert({ ...input, restoredRevisionId: revision(n).revisionId }).canRevert,
      ).toBe(false);
    }
  });
  it.each([
    ["just before hub deadline with client ahead", "accepted", Date.parse(deadline) + 1000],
    ["at hub deadline with client behind", "revert_expired", Date.parse(deadline) - 1000],
  ] as const)("settles from the supplied hub result: %s", (_scenario, status, now) => {
    // The result is producer evidence; no hub clock is inferred or added to the DTO.
    const identity = {
      operationId: report.operationId,
      memoryId: item.memoryId,
      resolutionId: resolution.resolutionId,
      revertDeadlineUtc: resolution.revertDeadlineUtc,
    };
    const result =
      status === "accepted"
        ? M.MemoryRevertResult.make({
            ...identity,
            status,
            receipt: {
              operationId: report.operationId,
              memoryId: item.memoryId,
              outcome: "accepted",
              revisionId: revision(8).revisionId,
              pendingSync: false,
            },
            localAvailability: visible,
          })
        : M.MemoryRevertResult.make({ ...identity, status });
    expect(presentMemoryRevert({ item, entry, history, now }).canRevert).toBe(true);
    expect(presentMemoryRevertResult(result)).toMatchObject({
      settled: true,
      detailsAvailable: status === "accepted",
    });
    expect(
      presentMemoryRevert({
        item,
        entry,
        history: { ...history, revertResults: [result] },
        now,
      }),
    ).toMatchObject({
      canRevert: false,
      reason: presentMemoryRevertResult(result).label,
      timeNotice: null,
    });
  });
  it("keeps replayed accepted revert accepted after expiry and body held", () => {
    const result = M.MemoryRevertResult.make({
      operationId: report.operationId,
      memoryId: item.memoryId,
      resolutionId: resolution.resolutionId,
      revertDeadlineUtc: resolution.revertDeadlineUtc,
      status: "accepted",
      receipt: {
        operationId: report.operationId,
        memoryId: item.memoryId,
        outcome: "accepted",
        revisionId: revision(8).revisionId,
        pendingSync: false,
      },
      localAvailability: { ...visible, exposure: "held", reasons: ["scanner_pending"] },
    });
    expect(presentMemoryRevertResult(result)).toEqual({
      label: "Revert approved",
      settled: true,
      detailsAvailable: false,
    });
    expect(
      presentMemoryRevert({
        item,
        entry,
        history: { ...history, revertResults: [result] },
        now: Date.parse(deadline) + 1,
      }),
    ).toMatchObject({ canRevert: false, reason: "Revert approved" });
  });
  it("does not promote a forget receipt into completed propagation or cleanup", () => {
    expect(
      presentMemoryForget({
        operationId: report.operationId,
        memoryId: item.memoryId,
        outcome: "deleted",
        revisionId: null,
        pendingSync: true,
      }),
    ).toMatchObject({
      label: "Forget request applied",
      pendingSync: true,
      expansionStatus: "unknown",
    });
  });
  it("preserves desired pending enrollment without claiming effective permission", () => {
    const view = decodeOwnerView({
      policy: {
        allowedRequesterEnvironmentIds: ["active"],
        ownerPolicyEpoch: 3,
        removals: [
          {
            memorySpaceId: id(1),
            ownerEnvironmentId: "owner",
            requesterEnvironmentId: "pending",
            removalEpoch: 2,
            state: "pending",
          },
        ],
        enrollments: [
          {
            memorySpaceId: id(1),
            ownerEnvironmentId: "owner",
            requesterEnvironmentId: "active",
            ownerPolicyEpoch: 1,
            state: "active",
          },
          {
            memorySpaceId: id(1),
            ownerEnvironmentId: "owner",
            requesterEnvironmentId: "pending",
            ownerPolicyEpoch: 3,
            removalEpoch: 2,
            state: "pending",
          },
        ],
      },
      version: 4,
      revocationPropagation: "pending",
    });
    expect(presentMemoryOwnerPolicy(view)).toMatchObject({
      effectiveRequesterEnvironmentIds: ["active"],
      desiredRequesterEnvironmentIds: ["active", "pending"],
      revocationLabel: "Syncing device removal",
      pendingEnrollments: [{ label: "Waiting to allow this device again after removal completes" }],
    });
  });
  it.each([undefined, -1, 11, 1.5, NaN])(
    "treats invalid or absent attempts %s as unknown",
    (automaticAttempts) => {
      expect(
        presentMemoryReport({
          ...report,
          ...(automaticAttempts === undefined ? {} : { automaticAttempts }),
        }),
      ).toMatchObject({
        automaticAttempts: null,
        retryState: "unknown",
        canResetInSettings: false,
      });
    },
  );
  it("requires exact exhausted owner and no active claim for a Settings reset", () => {
    const options = {
      isResetEligible: true,
      isDeliveryOwner: true,
      hasActiveClaim: false,
    };
    expect(presentMemoryReport({ ...report, automaticAttempts: 10 }, options)).toMatchObject({
      canResetInSettings: true,
      label: "All 10 automatic retries used",
    });
    for (const overrides of [
      { automaticAttempts: 9 },
      { isResetEligible: false },
      { isDeliveryOwner: false },
      { hasActiveClaim: true },
      { hasActiveClaim: undefined },
    ]) {
      expect(
        presentMemoryReport(
          { ...report, automaticAttempts: 10, ...overrides },
          { ...options, ...overrides },
        ).canResetInSettings,
      ).toBe(false);
    }
    expect(presentMemoryReport({ ...report, state: "pending" }, options).canResetInSettings).toBe(
      false,
    );
    expect(presentMemoryReport({ ...report, automaticAttempts: 0 }).retryState).toBe("remaining");
  });
  it("links delivered reports by their actual thread, not the resolving device", () => {
    const reportThread = {
      environmentId: M.EnvironmentId.make("delivery-owner"),
      threadId: M.ThreadId.make("bot"),
    };
    expect(
      presentMemoryReport({ ...report, state: "delivered", reportThread, sequence: 0 })
        .reportTarget,
    ).toEqual(reportThread);
  });
  it("keeps memory links scoped and body-free", () => {
    const reference = M.MemoryReportReference.make({
      environmentId: M.EnvironmentId.make("delivery-owner"),
      memorySpaceId: item.memorySpaceId,
      memoryId: item.memoryId,
      resolutionId: resolution.resolutionId,
    });
    expect(memoryReportTarget(reference)).toEqual(reference);
  });
  it("does not infer readiness or effective permission from connection or ceiling", () => {
    expect(presentMemorySync({ state: "online", memorySpaceId: item.memorySpaceId })).toMatchObject(
      { diagnostics: "unknown", canReconcileInSettings: false },
    );
    expect(presentMemorySync({ state: "offline", memorySpaceId: null }).label).toBe(
      "Connect a memory space",
    );
    expect(presentMemorySync({ state: "disabled", memorySpaceId: null }).label).toBe(
      "Memory sharing off",
    );
    expect(presentMemoryRunAccess({})).toEqual({
      savedCeiling: "none",
      savedCeilingLabel: "Memory limit: none",
      effectiveAccess: "unknown",
      effectiveReason: null,
    });
    expect(presentMemoryRunAccess({ memoryGrantCeiling: "read_write" })).toMatchObject({
      savedCeiling: "read_write",
      effectiveAccess: "unknown",
    });
  });
});

it("uses only the optional server assessment for current permission and reason", () => {
  for (const [access, reason] of [
    ["none", "environment_off"],
    ["read", "read_only_destination"],
    ["read_write", "ceiling"],
  ] as const) {
    expect(
      presentMemoryRunAccess({
        memoryGrantCeiling: "read_write",
        currentMemoryAccess: { access, reason },
      }),
    ).toEqual({
      savedCeiling: "read_write",
      savedCeilingLabel: "Memory limit: read & write",
      effectiveAccess: access,
      effectiveReason: reason,
    });
  }
  expect(presentMemoryRunAccess({ memoryGrantCeiling: "none" }).effectiveAccess).toBe("unknown");
});

it("refused is settled while retry still checks head, history and originals", () => {
  const result = decodeRevertResult({
    operationId: id(60),
    memoryId: item.memoryId,
    resolutionId: resolution.resolutionId,
    revertDeadlineUtc: deadline,
    status: "refused",
    failureCode: "source_unavailable",
  });
  expect(presentMemoryRevertResult(result)).toMatchObject({
    label: "Revert attempt refused",
    settled: true,
  });
  const input = {
    item,
    entry,
    history: { ...history, revertResults: [result] },
    now: Date.parse(applied),
  };
  expect(presentMemoryRevert(input)).toMatchObject({
    canRevert: true,
    reason: null,
    notice: "Last revert attempt was refused: source unavailable",
  });
  expect(
    presentMemoryRevert({ ...input, history: { ...input.history, nextCursor: "more" } }).canRevert,
  ).toBe(true);
  expect(
    presentMemoryRevert({ ...input, history: { ...input.history, revisions: [] } }).canRevert,
  ).toBe(false);
  expect(
    presentMemoryRevert({ ...input, item: { ...item, revision: revision(7) } }).canRevert,
  ).toBe(false);
});

it("presents separate diagnostics only for an advertised capability", () => {
  const diagnostics: M.MemoryHubDiagnostics = {
    version: 7,
    publication: { state: "last_valid", code: "invalid_settings" },
    readiness: "ready",
    connection: "unreachable",
    recoverableHolds: ["protocol"],
    permanentHolds: [],
    reconcile: "unavailable",
  };
  const status = { state: "offline" as const, memorySpaceId: item.memorySpaceId };
  const capabilities = {
    repositoryIdentity: false,
    memory: { protocolVersion: 1, hubDiagnostics: true },
  };
  expect(presentMemorySync(status, { capabilities, diagnostics })).toMatchObject({
    diagnostics: "last_valid",
    publicationLabel: "Last valid settings in use",
    readiness: "ready",
    connection: "unreachable",
    canReconcileInSettings: false,
  });
  const available = {
    ...diagnostics,
    publication: { state: "current" as const },
    reconcile: "available" as const,
  };
  expect(
    presentMemorySync(status, { capabilities, diagnostics: available }).canReconcileInSettings,
  ).toBe(true);
  expect(
    presentMemorySync(status, {
      capabilities: { repositoryIdentity: false, memory: { protocolVersion: 1 } },
      diagnostics: available,
    }).canReconcileInSettings,
  ).toBe(false);
  expect(
    presentMemorySync(status, {
      capabilities,
      diagnostics: { ...diagnostics, permanentHolds: ["identity"], reconcile: "permanent_hold" },
    }).canReconcileInSettings,
  ).toBe(false);
});

describe("shared memory progress presentation", () => {
  it("reads attempts from the report DTO with no caller options", () => {
    expect(presentMemoryReport(report).automaticAttempts).toBeNull();
    expect(presentMemoryReport({ ...report, automaticAttempts: 0 }).automaticAttempts).toBe(0);
    expect(presentMemoryReport({ ...report, automaticAttempts: 10 }).retryState).toBe("exhausted");
    const owner = M.EnvironmentId.make("resolver");
    expect(isMemoryReportRetryCandidate({ ...report, automaticAttempts: 10 }, owner)).toBe(true);
    expect(isMemoryReportRetryCandidate(report, owner)).toBe(false);
    expect(isMemoryReportRetryCandidate({ ...report, automaticAttempts: 9 }, owner)).toBe(false);
    expect(
      isMemoryReportRetryCandidate({ ...report, automaticAttempts: 10, state: "pending" }, owner),
    ).toBe(false);
    expect(
      isMemoryReportRetryCandidate(
        { ...report, automaticAttempts: 10 },
        M.EnvironmentId.make("other"),
      ),
    ).toBe(false);
    expect(presentMemoryReportReset({ resetCount: 2, unchangedCount: 1 }).label).toBe(
      "2 reports ready to retry; 1 unchanged",
    );
    expect(presentMemoryReportReset({ resetCount: 0, unchangedCount: 3 }).label).toBe(
      "0 reports ready to retry; 3 unchanged",
    );
  });
  it.each(["available", "partial", "unavailable", undefined] as const)(
    "distinguishes empty results and %s coverage",
    (status) => {
      const coverage =
        status === undefined
          ? undefined
          : M.MemoryIndexCoverage.make({
              status,
              eligibleItems: status === "available" ? 0 : 1,
              indexedItems: 0,
              unindexedItems: status === "available" ? 0 : 1,
              projectionWatermark: 0,
            });
      const result = presentMemoryCoverage(coverage, 0);
      expect(result.complete).toBe(status === "available");
      expect(result.emptyLabel).toBe(
        status === "available"
          ? "No memories found"
          : "Results are incomplete; memories may still be available",
      );
      expect(presentMemoryCoverage(coverage, 1).emptyLabel).toBeNull();
    },
  );
  it("keeps scanner checking neutral and a secret hold forget-only despite an accepted receipt", () => {
    const checking = M.MemoryLocalAvailability.make({
      exposure: "held",
      reasons: ["scanner_pending"],
      deferred: [],
      cleanupPending: false,
    });
    const secret = M.MemoryLocalAvailability.make({ ...checking, reasons: ["secret_detected"] });
    const receipt = M.MemoryMutationReceipt.make({
      operationId: report.operationId,
      memoryId: item.memoryId,
      outcome: "accepted",
      revisionId: item.revision.revisionId,
      pendingSync: true,
    });
    expect(presentMemoryReceipt(receipt, checking)).toMatchObject({
      label: "Memory change accepted",
      syncLabel: "Waiting to sync",
      availability: { label: "Checking content", detailsAvailable: false, canForget: true },
    });
    expect(presentMemoryItem({ ...item, localAvailability: secret })).toMatchObject({
      canEdit: false,
      detailsAvailable: false,
      canForget: true,
    });
    expect(presentMemoryReceipt(receipt, secret).availability.label).toBe(
      "Held for sensitive content",
    );
    expect(
      presentMemoryReceipt(
        { ...receipt, outcome: "rejected", failureCode: "storage_failed" },
        visible,
      ).label,
    ).toBe("Memory change rejected");
  });
  it.each([
    [
      "schema_rejected",
      "the model provider rejected GOAT's request format (check for a GOAT update)",
    ],
    ["auth", "the model provider needs you to sign in again"],
    ["unavailable", "the memory model isn't available on this computer"],
    ["rate_limited", "the model provider's usage limit was reached"],
  ] as const)("explains a %s generation pause and its retry time", (reason, explanation) => {
    const nextAttemptAt = M.MemoryUtcTimestamp.make("2026-10-01T14:05:00.000Z");
    const shown = presentMemoryProcessing(
      processing,
      { reason, since: M.MemoryUtcTimestamp.make(applied), nextAttemptAt },
      (timestamp) =>
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "UTC",
          hour: "2-digit",
          minute: "2-digit",
        }).format(Date.parse(timestamp)),
    );
    expect(shown.pausedLabel).toBe(`Memory paused: ${explanation}. Next try at 14:05`);
  });
  it("clears the paused label when no generation hold is reported", () => {
    expect(presentMemoryProcessing(processing).pausedLabel).toBeNull();
    expect(
      presentMemoryProcessing(processing, undefined, () => {
        throw new Error("No retry time should be formatted without a hold");
      }).pausedLabel,
    ).toBeNull();
  });
  it("reads a paused status again just after its next try", () => {
    const hold = {
      reason: "schema_rejected" as const,
      since: M.MemoryUtcTimestamp.make(applied),
      nextAttemptAt: M.MemoryUtcTimestamp.make("2026-10-01T00:10:00.000Z"),
    };
    expect(memoryHoldRefreshDelayMs(undefined, Date.parse(applied))).toBeNull();
    expect(memoryHoldRefreshDelayMs(hold, Date.parse(applied))).toBe(600_000 + 15_000);
    // The try is due or running: look again in a minute, not continuously.
    expect(memoryHoldRefreshDelayMs(hold, Date.parse("2026-10-01T00:10:00.000Z"))).toBe(60_000);
  });
  it("maps processing independently of connection and exposure", () => {
    for (const work of [
      { scannerPendingItems: 1, unindexedItems: 0, pendingCleanupItems: 0 },
      { scannerPendingItems: 0, unindexedItems: 1, pendingCleanupItems: 0 },
      { scannerPendingItems: 0, unindexedItems: 0, pendingCleanupItems: 1 },
    ]) {
      const shown = presentMemoryProcessing({
        ...processing,
        ...work,
        missingParentItems: 0,
        reportBacklog: 0,
        reportFailed: 0,
      });
      expect(shown.waitingLabel).toBe(
        work.scannerPendingItems > 0 ? null : "Memory processing pending",
      );
      expect(shown.checkingLabel).toBe(work.scannerPendingItems > 0 ? "Checking content" : null);
    }
    expect(presentMemoryProcessing(processing)).toMatchObject({
      checkingLabel: "Checking content",
      heldLabel: "Sensitive content on hold; forgetting is available",
      waitingLabel: "Waiting for earlier memories",
      cleanupLabel: "Cleaning up remaining content",
      receiveLabel: "Sync progress unknown",
      reportLabel: "Some reports could not be delivered",
      admissionLabel: "Some memory changes could not be accepted",
    });
  });
  it("shows capacity, held reclamation and indexing pause without raw storage fields", () => {
    const storage = M.MemoryStorageStatus.make({
      quotas: [
        {
          dimension: "body",
          current: 128,
          limit: 128,
          reclaimable: 0,
          reserved: 0,
          warning: "full",
          blockedReasons: ["capacity_exceeded"],
        },
      ],
      tables: [],
      measuredAtUtc: null,
      dbFileBytes: null,
      walBytes: null,
      freelistBytes: null,
      freelistRatio: null,
      retentionFloor: 0,
      checkpointSequence: 0,
      compaction: {
        lastRunAtUtc: null,
        removedRows: 0,
        reclaimedLogicalBytes: 0,
        reclaimableLogicalBytes: 0,
        blockedReasons: ["retained_revert_input"],
      },
      ftsAdmission: {
        state: "braked",
        changedAtUtc: null,
        lastMeasuredAtUtc: null,
        allocatedBytes: null,
        measurementStatus: "unavailable",
      },
      growth: {
        current: null,
        deltas: ([1, 7, 30] as const).flatMap((days) =>
          M.MemoryStorageMetric.literals.map((metric) => ({
            days,
            metric,
            status: "unavailable" as const,
            baselineAtUtc: null,
            currentAtUtc: null,
            elapsedMs: null,
            deltaBytes: null,
            reason: "missing_baseline" as const,
          })),
        ),
      },
      warnings: ["capacity_exceeded"],
    });
    expect(presentMemoryStorage(storage)).toEqual({
      label: "Memory storage limit reached",
      reasons: ["Memory storage limit reached", "Originals retained for revert"],
      searchLabel: "Search indexing paused",
    });
    expect(
      presentMemoryStorage({
        ...storage,
        quotas: [],
        ftsAdmission: { ...storage.ftsAdmission, state: "open" },
      }),
    ).toMatchObject({
      label: "Memory storage usage unknown",
      searchLabel: "Search storage usage unknown",
    });
  });
});
