import {
  EnvironmentId,
  MemoryItem,
  MemoryOwnerSourceReadPolicyView,
  MemoryOperationId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  memorySettingsDestination,
  memoryOwnerDesiredIds,
  memoryForgetIntent,
  validateMemorySettingsSearch,
} from "./MemorySettings.logic";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const decodeOwner = Schema.decodeUnknownSync(MemoryOwnerSourceReadPolicyView);
const decodeItem = Schema.decodeUnknownSync(MemoryItem);
const pair = {
  memorySpaceId: id(1),
  ownerEnvironmentId: "remote-owner",
  requesterEnvironmentId: "pending-device",
};

describe("Memory settings intent boundaries", () => {
  it("keeps a foreign report's exact destination and clears inherited filters", () => {
    const destination = memorySettingsDestination({
      environmentId: "foreign-owner",
      memorySpaceId: id(1),
      memoryId: id(2),
      resolutionId: id(3),
    });
    expect(destination).toEqual({
      environmentId: "foreign-owner",
      machine: "foreign-owner",
      memorySpaceId: id(1),
      memoryId: id(2),
      resolutionId: id(3),
      project: undefined,
      checkout: undefined,
    });
    expect(
      memorySettingsDestination({
        environmentId: "foreign-owner",
        memorySpaceId: "invalid",
        memoryId: id(2),
      }),
    ).toBeNull();
  });
  it("drops dangling record ids and never chooses a default environment", () => {
    expect(
      validateMemorySettingsSearch({
        memoryId: id(2),
        resolutionId: id(3),
        project: "old",
        checkout: "old",
      }),
    ).toEqual({ project: undefined, checkout: undefined });
  });
  it("preserves pending reenrollment while adding and removing another requester", () => {
    const view = decodeOwner({
      version: 3,
      revocationPropagation: "pending",
      policy: {
        ownerPolicyEpoch: 3,
        allowedRequesterEnvironmentIds: ["active-device"],
        enrollments: [
          { ...pair, ownerPolicyEpoch: 3, removalEpoch: 2, state: "pending" },
          {
            ...pair,
            requesterEnvironmentId: "active-device",
            ownerPolicyEpoch: 3,
            state: "active",
          },
        ],
        removals: [{ ...pair, removalEpoch: 2, state: "pending" }],
      },
    });
    expect(memoryOwnerDesiredIds(view, EnvironmentId.make("new-device"), true)).toEqual([
      "active-device",
      "pending-device",
      "new-device",
    ]);
    expect(memoryOwnerDesiredIds(view, EnvironmentId.make("active-device"), false)).toEqual([
      "pending-device",
    ]);
    expect(memoryOwnerDesiredIds(view, EnvironmentId.make("pending-device"), false)).toEqual([
      "active-device",
    ]);
  });
  it("offers forget for a secret hold without reconstructing hidden heads", () => {
    const item = decodeItem({
      memorySpaceId: id(1),
      memoryId: id(2),
      status: "blocked",
      scope: { kind: "user" },
      failureCode: "secret_detected",
      pendingSync: false,
      localAvailability: {
        exposure: "held",
        reasons: ["secret_detected"],
        deferred: [],
        cleanupPending: false,
      },
    });
    expect(memoryForgetIntent(item, MemoryOperationId.make(id(4)))).toEqual({
      memorySpaceId: id(1),
      memoryId: id(2),
      expectedHeads: [],
      operationId: id(4),
    });
  });
});

import {
  MemorySpaceId,
  MemoryResetReportAttemptsInput,
  type MemoryReportDelivery,
} from "@goat/contracts";
import { memoryReportRetryIntent } from "./MemorySettings.logic";
const decodeRetry = Schema.decodeUnknownSync(MemoryResetReportAttemptsInput);
it("builds a valid bounded retry command from current exhausted exact-owner rows", () => {
  const owner = EnvironmentId.make("owner");
  const space = MemorySpaceId.make(id(1));
  const reports = Array.from({ length: 40 }, (_, index) => ({
    reportId: String(index).padStart(64, "0"),
    state: "failed",
    automaticAttempts: 10,
    resolvingEnvironmentId: owner,
  })) as MemoryReportDelivery[];
  const intent = memoryReportRetryIntent(
    owner,
    space,
    [...reports, reports[0]!],
    reports.map((r) => r.reportId),
  );
  expect(decodeRetry(intent).reportIds).toHaveLength(32);
  expect(
    memoryReportRetryIntent(
      EnvironmentId.make("foreign"),
      space,
      reports,
      reports.map((r) => r.reportId),
    ),
  ).toBeNull();
  expect(
    memoryReportRetryIntent(
      owner,
      space,
      reports.map(({ automaticAttempts: _attempts, ...r }) => r),
      reports.map((r) => r.reportId),
    ),
  ).toBeNull();
  expect(
    memoryReportRetryIntent(
      owner,
      space,
      [],
      reports.map((r) => r.reportId),
    ),
  ).toBeNull();
});
