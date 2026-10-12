import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import {
  HOST_STATUS_QUOTA_REFRESH_INTERVAL_MS,
  clipHostStatusMessage,
  countHostThreads,
  hostStatusQuotas,
  isUnsupportedHostStatusMessage,
  quotaRefreshDue,
  tagRemoteHostStatus,
  unreachableHostStatus,
  unsupportedHostStatus,
} from "./hostStatusModel.ts";

const thread = (
  id: string,
  patch: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(ThreadId.make(id)),
  ...patch,
  id: ThreadId.make(id),
});

const limits = (
  checkedAt: string,
  reason?: "unsupported" | "probeFailed",
): ServerProviderUsageLimits => ({
  checkedAt,
  windows:
    reason === undefined ? [{ id: "primary", kind: "session", label: "5h", usedPercent: 40 }] : [],
  ...(reason === undefined ? {} : { unavailable: { reason } }),
});

it("counts running, waiting, and queued threads and skips the rest", () => {
  const pending = {
    id: RuntimeRequestId.make("req"),
    kind: "user_input" as const,
    createdAt: DateTime.makeUnsafe("2026-10-12T00:00:00.000Z"),
  };
  const counts = countHostThreads([
    thread("running"),
    thread("preparing", { status: "idle", activityRunStatus: "preparing" }),
    thread("starting", { status: "starting" }),
    thread("waiting-status", { status: "waiting" }),
    thread("waiting-activity", { status: "idle", activityRunStatus: "waiting" }),
    thread("waiting-request", { status: "running", pendingRuntimeRequest: pending }),
    thread("queued", { status: "queued", activeRunId: null }),
    thread("idle", { status: "idle", activeRunId: null }),
    thread("null-request", { status: "idle", activeRunId: null, pendingRuntimeRequest: null }),
    thread("deleted", { deletedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z") }),
    thread("archived", { archivedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z") }),
    thread("sub", {
      lineage: {
        rootThreadId: ThreadId.make("running"),
        parentThreadId: ThreadId.make("running"),
        relationshipToParent: "subagent",
      },
    }),
  ]);
  expect(counts).toEqual({ running: 3, waiting: 3, queued: 1 });
});

it("recognises an older remote that has no goat_host_status tool", () => {
  const wrapped =
    "GOAT on old-mac could not run goat_host_status: GOAT MCP tool call failed: Tool 'goat_host_status' not found";
  expect(isUnsupportedHostStatusMessage(wrapped)).toBe(true);
  expect(isUnsupportedHostStatusMessage('tool "goat_host_status" not found')).toBe(true);
  expect(isUnsupportedHostStatusMessage("box is unavailable: connection timed out")).toBe(false);
});

it("clips a long unreachable message to 500 characters", () => {
  expect(clipHostStatusMessage("x".repeat(600))).toHaveLength(500);
  expect(clipHostStatusMessage("ok")).toBe("ok");
});

it("tags the remote's own entry and reports an empty answer", () => {
  const tagged = tagRemoteHostStatus(
    {
      hosts: [
        { host: "other", reachability: "ok" },
        {
          host: null,
          reachability: "ok",
          metrics: {
            sampledAt: 1,
            cpuUtilization: null,
            cpuCount: 1,
            availableMemoryBytes: 1,
            totalMemoryBytes: 1,
            loadAvg: null,
            disk: null,
            threads: { running: 0, waiting: 0, queued: 0 },
            quotas: [],
          },
        },
      ],
    },
    "box",
  );
  expect(tagged.host).toBe("box");
  expect(tagged.metrics?.cpuCount).toBe(1);
  expect(tagRemoteHostStatus({ hosts: [] }, "box")).toEqual({
    host: "box",
    reachability: "unreachable",
    message: "box returned no host status.",
  });
});

it("keeps the last successful sample only for an unreachable host", () => {
  const previous = tagRemoteHostStatus(
    {
      hosts: [
        {
          host: null,
          reachability: "ok",
          metrics: {
            sampledAt: 1,
            cpuUtilization: 0,
            cpuCount: 2,
            availableMemoryBytes: 1,
            totalMemoryBytes: 2,
            loadAvg: null,
            disk: null,
            threads: { running: 1, waiting: 0, queued: 0 },
            quotas: [],
          },
        },
      ],
    },
    "box",
  );
  expect(unreachableHostStatus("box", "y".repeat(600), previous)).toMatchObject({
    host: "box",
    reachability: "unreachable",
    lastKnown: true,
    metrics: previous.metrics,
  });
  expect(unreachableHostStatus("box", "y".repeat(600), previous).message).toHaveLength(500);
  expect(unreachableHostStatus("box", "down", undefined).lastKnown).toBeUndefined();
  expect(unsupportedHostStatus("old-mac")).toEqual({
    host: "old-mac",
    reachability: "unsupported",
    message: "GOAT on old-mac does not offer goat_host_status. Update GOAT on that machine.",
  });
});

it("refreshes stale quota and skips accounts that cannot report it", () => {
  const now = Date.parse("2026-10-12T16:00:00.000Z");
  const interval = HOST_STATUS_QUOTA_REFRESH_INTERVAL_MS;
  expect(quotaRefreshDue(undefined, now, interval)).toBe(false);
  expect(quotaRefreshDue(limits("2026-10-12T15:00:00.000Z", "unsupported"), now, interval)).toBe(
    false,
  );
  expect(quotaRefreshDue(limits("2026-10-12T15:00:00.000Z", "probeFailed"), now, interval)).toBe(
    true,
  );
  expect(quotaRefreshDue(limits("not-a-date"), now, interval)).toBe(true);
  expect(quotaRefreshDue(limits("2026-10-12T15:59:30.000Z"), now, interval)).toBe(false);
  expect(quotaRefreshDue(limits("2026-10-12T15:59:00.000Z"), now, interval)).toBe(true);

  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      usageLimits: limits("2026-10-12T15:00:00.000Z"),
    },
    {
      instanceId: ProviderInstanceId.make("claude"),
      driver: ProviderDriverKind.make("claude"),
      usageLimits: undefined,
    },
  ] as const satisfies ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "displayName" | "usageLimits">
  >;
  expect(hostStatusQuotas(providers, new Set(["codex"]))).toEqual([
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      limits: limits("2026-10-12T15:00:00.000Z"),
      fromCache: false,
    },
  ]);
});
