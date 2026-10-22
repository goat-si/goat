import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@goat/contracts";
import { GoatHostStatusResult, type RuntimeProtocolRanges } from "@goat/contracts";
import { ownRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import {
  HOST_STATUS_QUOTA_REFRESH_INTERVAL_MS,
  clipHostStatusMessage,
  countHostThreads,
  hostStatusProviders,
  hostStatusQuotas,
  isUnsupportedHostStatusMessage,
  markHostCompatibility,
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
  expect(
    isUnsupportedHostStatusMessage(
      "GOAT on old-mac does not have goat_host_status; it runs 0.1.0 and this machine runs 0.2.0.",
    ),
  ).toBe(true);
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

it("lists every configured provider, including one that reports no quota", () => {
  expect(
    hostStatusProviders([
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex",
        enabled: true,
      },
      {
        instanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claude"),
        enabled: false,
      },
    ]),
  ).toEqual([
    { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true },
    { instanceId: "claude", driver: "claude", enabled: false },
  ]);
});

describe("markHostCompatibility", () => {
  const speaks = ownRuntimeProtocolRanges(1001);
  const VERSIONS = {
    stable: "0.1.0",
    nightly: "0.1.0-nightly.20261019.195",
    preview: "0.1.0-preview.20261019.3",
    dev: "0.1.0-dev.1792420473.g7b523f265",
    pr: "0.1.0-pr.456.12",
  } as const;
  const PROTOCOLS = {
    same: speaks,
    newerRange: {
      ssh: { min: 1001, max: 1002 },
      orchestration: { min: 1001, max: 1004 },
    },
    tooOld: { ssh: speaks.ssh, orchestration: { min: 1, max: 1000 } },
    tooNew: { ssh: speaks.ssh, orchestration: { min: 1002, max: 1002 } },
    unreported: undefined,
  } as const;
  const EXPECTED = {
    same: "compatible",
    newerRange: "compatible",
    tooOld: "incompatible",
    tooNew: "incompatible",
    unreported: "degraded",
  } as const;

  // Every pairing of local and remote build strings gets the verdict its protocols give.
  const matrix = Object.entries(VERSIONS).flatMap(([localName, localVersion]) =>
    Object.entries(VERSIONS).flatMap(([remoteName, remoteVersion]) =>
      Object.keys(PROTOCOLS).map((protocolName) => ({
        name: `${localName} here, ${remoteName} there, ${protocolName} protocols`,
        localVersion,
        remoteVersion,
        key: protocolName as keyof typeof PROTOCOLS,
      })),
    ),
  );
  it.each(matrix)("$name", ({ localVersion, remoteVersion, key }) => {
    const protocol = PROTOCOLS[key];
    const marked = markHostCompatibility(
      {
        host: "box",
        reachability: "ok",
        serverVersion: remoteVersion,
        ...(protocol === undefined ? {} : { protocol }),
      },
      { version: localVersion, speaks },
    );
    expect(marked.compatibility).toBe(EXPECTED[key]);
    expect(marked.versionMismatch).toBe(localVersion === remoteVersion ? undefined : true);
    expect(marked.message === undefined).toBe(EXPECTED[key] === "compatible");
  });

  it("names the side to update", () => {
    const local = { version: VERSIONS.dev, speaks };
    const host = (protocol: RuntimeProtocolRanges) =>
      markHostCompatibility(
        { host: "mini", reachability: "ok", serverVersion: VERSIONS.nightly, protocol },
        local,
      ).message;
    expect(host(PROTOCOLS.tooOld)).toMatch(/Update GOAT on mini\.$/);
    expect(host(PROTOCOLS.tooNew)).toMatch(/Update GOAT on this machine\.$/);
  });

  it("leaves this machine, unreachable, and unsupported hosts alone", () => {
    const local = { version: VERSIONS.stable, speaks };
    const self = { host: null, reachability: "ok" as const, serverVersion: "9.9.9" };
    expect(markHostCompatibility(self, local)).toBe(self);
    const away = unreachableHostStatus("box", "timed out", undefined);
    expect(markHostCompatibility(away, local)).toBe(away);
    const old = unsupportedHostStatus("box");
    expect(markHostCompatibility(old, local)).toBe(old);
  });
});

describe("older host-status payloads", () => {
  const decode = Schema.decodeUnknownSync(GoatHostStatusResult);

  it("decodes an answer from a host that predates versions and protocols", () => {
    expect(
      decode({ hosts: [{ host: "box", reachability: "ok", versionMismatch: true }] }).hosts[0],
    ).toEqual({ host: "box", reachability: "ok", versionMismatch: true });
  });

  it("decodes the shape the previous release sent, message included", () => {
    const entry = decode({
      hosts: [
        {
          host: "mini",
          reachability: "ok",
          serverVersion: "0.1.0-nightly.20261019.195",
          versionMismatch: true,
          message: "mini runs GOAT 0.1.0-nightly.20261019.195; this machine runs GOAT 0.1.0.",
        },
      ],
    }).hosts[0];
    expect(entry?.compatibility).toBeUndefined();
    expect(entry?.protocol).toBeUndefined();
    expect(entry?.versionMismatch).toBe(true);
  });

  it("keeps a host with partial or malformed ranges reachable, and judges it degraded", () => {
    const speaks = ownRuntimeProtocolRanges(1001);
    for (const protocol of [
      { orchestration: { min: 1001, max: 1001 } },
      { ssh: { min: 0, max: 1001 }, orchestration: { min: 1001, max: 1001 } },
      "1001",
    ]) {
      const [entry] = decode({
        hosts: [{ host: "box", reachability: "ok", serverVersion: "0.1.0", protocol }],
      }).hosts;
      expect(entry?.reachability).toBe("ok");
      expect(entry?.protocol).toBeUndefined();
      expect(
        entry === undefined
          ? undefined
          : markHostCompatibility(entry, { version: "0.1.0", speaks }),
      ).toMatchObject({ compatibility: "degraded" });
    }
  });

  it("drops a verdict this build does not know instead of failing the answer", () => {
    const entry = decode({
      hosts: [{ host: "box", reachability: "ok", compatibility: "partially-compatible" }],
    }).hosts[0];
    expect(entry).toEqual({ host: "box", reachability: "ok" });
  });
});
