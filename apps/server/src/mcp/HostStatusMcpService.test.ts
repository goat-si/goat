import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  GoatHostStatusResult,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type OpenCodexInventorySnapshot,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { servedRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import packageJson from "../../package.json" with { type: "json" };
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OpenCodexInventory from "../opencodex/OpenCodexInventory.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HostStatusMcpService from "./HostStatusMcpService.ts";
import { HOST_STATUS_REMOTE_TIMEOUT_MS } from "./HostStatusMcpService.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const threadId = ThreadId.make("caller-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const now = Date.parse("2026-10-12T16:00:00.000Z");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("host-status-test"),
  requestNamespace: "thread:caller",
  thread: { threadId, providerSessionId: "session", providerInstanceId },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const capacity = {
  sampledAt: 1_791_823_810_477,
  cpuUtilization: 0.12,
  cpuCount: 8,
  availableMemoryBytes: 12_000_000_000,
  totalMemoryBytes: 16_000_000_000,
  loadAvg: { oneMinute: 1.2, fiveMinutes: 0.9, fifteenMinutes: 0.7 },
  disk: { path: "/", availableBytes: 100_000_000_000, totalBytes: 500_000_000_000 },
};
const decode = Schema.decodeUnknownSync(GoatHostStatusResult);

const limits = (checkedAt: string, reason?: "unsupported"): ServerProviderUsageLimits => ({
  checkedAt,
  windows:
    reason === undefined ? [{ id: "primary", kind: "session", label: "5h", usedPercent: 40 }] : [],
  ...(reason === undefined ? {} : { unavailable: { reason, message: "API key" } }),
});

const provider = (
  instanceId: string,
  usageLimits: ServerProviderUsageLimits | undefined,
  displayName?: string,
  enabled = true,
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId),
    ...(displayName === undefined ? {} : { displayName }),
    enabled,
    usageLimits,
  }) as ServerProvider;

const remoteOk = (sampledAt: number, opencodex?: OpenCodexInventorySnapshot) => ({
  hosts: [
    {
      host: null,
      reachability: "ok",
      metrics: {
        ...capacity,
        sampledAt,
        threads: { running: 1, waiting: 0, queued: 0 },
        quotas: [],
        ...(opencodex ? { opencodex } : {}),
      },
    },
  ],
});

it.effect("fan-out preserves a host's inventory and accepts older hosts that omit it", () =>
  Effect.gen(function* () {
    const inventory: OpenCodexInventorySnapshot = {
      installed: true,
      binaries: [{ path: "/fixture/ocx", version: "2.86.0" }],
      ownership: "adopted",
      service: { available: false },
      runtime: { port: 10100, version: "2.86.0", role: "client", healthy: true, ready: true },
      link: { role: "child", available: true, links: [], childSettingsApplied: true },
    };
    const { value } = yield* run(
      {
        hosts: ["child", "legacy"],
        hostCall: (call) =>
          Effect.succeed(remoteOk(9, call.host === "child" ? inventory : undefined)),
      },
      (service) => service.read(scope, {}),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    const hosts = decode(value.success).hosts;
    expect(hosts.find((host) => host.host === "child")?.metrics?.opencodex).toEqual(inventory);
    expect(hosts.find((host) => host.host === "legacy")?.metrics?.opencodex).toBeUndefined();
    expect(hosts.find((host) => host.host === null)?.metrics?.opencodex?.ownership).toBe("none");
  }),
);

const sshError = (reason: SshRemoteDispatch.SshRemoteDispatchError["reason"], message: string) =>
  new SshRemoteDispatch.SshRemoteDispatchError({ reason, message });

const run = <A, E>(
  options: {
    readonly hosts?: ReadonlyArray<string>;
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly refreshFails?: ReadonlySet<string>;
    readonly listFails?: boolean;
    readonly shell?: ReturnType<typeof liveThreadShell>;
    readonly hostCall?: (
      call: SshRemoteDispatch.SshHostToolCall,
    ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
  },
  body: (service: HostStatusMcpService.HostStatusMcpServiceShape) => Effect.Effect<A, E>,
) => {
  const calls: Array<SshRemoteDispatch.SshHostToolCall> = [];
  const refreshes: Array<string> = [];
  const queries: Array<{ projectId: unknown; includeSubagents: boolean }> = [];
  let connectedReads = 0;
  const providers = { current: options.providers ?? [] };
  const layer = HostStatusMcpService.layer.pipe(
    Layer.provide(
      Layer.succeed(OpenCodexInventory.OpenCodexInventory, {
        read: Effect.succeed({
          installed: false,
          binaries: [],
          ownership: "none" as const,
          service: { available: false },
          runtime: { port: 10100, healthy: false, ready: false },
          link: { role: "none" as const, available: false, links: [], childSettingsApplied: false },
        }),
      }),
    ),
    Layer.provide(HostThreadsMcpService.layer),
    Layer.provide(
      Layer.mock(ThreadResultService.ThreadResultService)({
        forRun: () => Effect.succeed(null),
      }),
    ),
    Layer.provide(Layer.mock(HostResources.HostResources)({ read: Effect.succeed(capacity) })),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.sync(() => providers.current),
        refreshInstance: (instanceId) =>
          Effect.gen(function* () {
            refreshes.push(instanceId);
            if (options.refreshFails?.has(instanceId)) {
              // refreshInstance does not fail in its type. This still fails at
              // runtime so the status read's Effect.ignore can be observed.
              return yield* Effect.fail("probe failed" as never);
            }
            providers.current = providers.current.map((item) =>
              item.instanceId === instanceId && item.usageLimits !== undefined
                ? {
                    ...item,
                    usageLimits: { ...item.usageLimits, checkedAt: "2026-10-12T16:00:00.000Z" },
                  }
                : item,
            );
            return providers.current;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        connectedHosts: Effect.sync(() => {
          connectedReads += 1;
          return options.hosts ?? [];
        }),
        callHostTool: (call, authorize) =>
          authorize.pipe(
            Effect.tap(() => Effect.sync(() => calls.push(call))),
            Effect.andThen(() => options.hostCall?.(call) ?? Effect.succeed(remoteOk(2))),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(options.shell ?? liveThreadShell(threadId)),
        listProjectThreads: (input) => {
          queries.push({
            projectId: input.projectId,
            includeSubagents: input.includeSubagents,
          });
          const shells = [
            liveThreadShell(ThreadId.make("running")),
            {
              ...liveThreadShell(ThreadId.make("waiting")),
              status: "waiting" as const,
            },
            {
              ...liveThreadShell(ThreadId.make("queued")),
              status: "queued" as const,
              activeRunId: null,
            },
          ];
          return options.listFails
            ? Effect.fail(new Error("storage failed") as never)
            : Effect.succeed(shells);
        },
      }),
    ),
    Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
    Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
    Layer.provide(Layer.mock(LaunchWatchService.LaunchWatchService)({})),
  );
  return Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const service = yield* HostStatusMcpService.HostStatusMcpService;
    const value = yield* body(service).pipe(Effect.result);
    return { value, calls, refreshes, queries, connectedReads: () => connectedReads };
  }).pipe(Effect.provide(layer));
};

it.effect("fans out to this machine and each connected host, sorted", () =>
  Effect.gen(function* () {
    const { value, calls, queries, refreshes } = yield* run(
      {
        hosts: ["zeta", "box"],
        providers: [
          provider("codex", limits("2026-10-12T15:00:00.000Z"), "Codex"),
          provider("claude", undefined),
          provider("api", limits("2026-10-12T15:00:00.000Z", "unsupported"), "API"),
        ],
        hostCall: (call) =>
          call.host === "box"
            ? Effect.succeed(remoteOk(9))
            : Effect.fail(
                sshError(
                  "remote_refused",
                  "GOAT on zeta could not run goat_host_status: Tool 'goat_host_status' not found",
                ),
              ),
      },
      (service) => service.read(scope, {}),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    const decoded = decode(value.success);
    expect(decoded.hosts.map((host) => [host.host, host.reachability])).toEqual([
      [null, "ok"],
      ["box", "ok"],
      ["zeta", "unsupported"],
    ]);
    expect(decoded.hosts[0]?.metrics).toMatchObject({
      ...capacity,
      threads: { running: 1, waiting: 1, queued: 1 },
      quotas: [
        { instanceId: "codex", displayName: "Codex", fromCache: false },
        { instanceId: "api", displayName: "API", fromCache: true },
      ],
    });
    // Quotas omit claude, which reports no usage limits. Providers lists every instance.
    expect(decoded.hosts[0]?.metrics?.providers).toEqual([
      { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true },
      { instanceId: "claude", driver: "claude", enabled: true },
      { instanceId: "api", driver: "api", displayName: "API", enabled: true },
    ]);
    expect(decoded.hosts[1]).toMatchObject({ host: "box", metrics: { sampledAt: 9 } });
    expect(decoded.hosts[2]).toEqual({
      host: "zeta",
      reachability: "unsupported",
      message: "GOAT on zeta does not offer goat_host_status. Update GOAT on that machine.",
    });
    expect(calls.map((call) => call.host).toSorted()).toEqual(["box", "zeta"]);
    expect(calls.every((call) => call.tool === "goat_host_status")).toBe(true);
    expect(calls.every((call) => call.writes === false)).toBe(true);
    expect(calls.every((call) => call.timeoutMs === HOST_STATUS_REMOTE_TIMEOUT_MS)).toBe(true);
    expect(calls.every((call) => call.arguments.local === true)).toBe(true);
    expect(queries).toEqual([{ projectId: undefined, includeSubagents: false }]);
    expect(refreshes).toEqual(["codex"]);
  }),
);

it.effect("judges each host by the protocols it serves, not by its version string", () =>
  Effect.gen(function* () {
    const served = servedRuntimeProtocolRanges();
    const answers: Record<string, { serverVersion?: string; protocol?: unknown }> = {
      same: { serverVersion: packageJson.version, protocol: served },
      // Another channel's build that serves the same protocols works with this machine.
      nightly: { serverVersion: "0.1.0-nightly.20261019.195", protocol: served },
      // Older than protocol reporting: it answers, but cannot show compatibility.
      old: {},
      ancient: {
        serverVersion: "0.0.9",
        protocol: { ssh: served.ssh, orchestration: { min: 1, max: 1 } },
      },
    };
    const { value } = yield* run(
      {
        hosts: Object.keys(answers),
        hostCall: (call) => {
          const answer = remoteOk(3);
          return Effect.succeed({
            hosts: answer.hosts.map((entry) => ({ ...entry, ...answers[call.host] })),
          });
        },
      },
      (service) => service.read(scope, {}),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    const byHost = new Map(decode(value.success).hosts.map((entry) => [entry.host, entry]));
    const local = byHost.get(null);
    expect(local).toMatchObject({ serverVersion: packageJson.version, protocol: served });
    expect(local?.compatibility).toBeUndefined();
    expect(local?.versionMismatch).toBeUndefined();

    const same = byHost.get("same");
    expect(same).toMatchObject({ compatibility: "compatible" });
    expect(same?.versionMismatch).toBeUndefined();
    expect(same?.message).toBeUndefined();

    const nightly = byHost.get("nightly");
    expect(nightly).toMatchObject({ compatibility: "compatible", versionMismatch: true });
    expect(nightly?.message).toBeUndefined();

    const old = byHost.get("old");
    expect(old).toMatchObject({ compatibility: "degraded", versionMismatch: true });
    expect(old?.message).toContain("does not report the protocols it serves");
    expect(old?.message).toContain("update GOAT on old");

    const ancient = byHost.get("ancient");
    expect(ancient).toMatchObject({ compatibility: "incompatible", versionMismatch: true });
    expect(ancient?.message).toContain("serving orchestration 1, SSH");
    expect(ancient?.message).toMatch(/Update GOAT on ancient\.$/);
  }),
);

it.effect("reads only this machine for a client session that may not reach hosts", () =>
  Effect.gen(function* () {
    const { value, calls, connectedReads } = yield* run(
      { hosts: ["box"], hostCall: () => Effect.die("read-only session reached SSH") },
      (service) =>
        service
          .readForClient({
            environmentId: EnvironmentId.make("host-status-test"),
            sessionId: "web-session",
            reachHosts: false,
          })
          .pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );
    expect(connectedReads()).toBe(0);
    expect(calls).toEqual([]);
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts).toHaveLength(1);
    expect(value.success.hosts[0]).toMatchObject({
      host: null,
      reachability: "ok",
      metrics: { platform: "win32", threads: { running: 1, waiting: 1, queued: 1 } },
    });
  }),
);

it.effect("reads only this machine when a client that may reach hosts asks for local", () =>
  Effect.gen(function* () {
    const { value, calls, connectedReads } = yield* run(
      { hosts: ["box"], hostCall: () => Effect.die("local read reached SSH") },
      (service) =>
        service.readForClient({
          environmentId: EnvironmentId.make("host-status-test"),
          sessionId: "web-session",
          reachHosts: true,
          local: true,
        }),
    );
    expect(connectedReads()).toBe(0);
    expect(calls).toEqual([]);
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts.map((host) => [host.host, host.reachability])).toEqual([
      [null, "ok"],
    ]);
  }),
);

it.effect("fans out for a client session that may reach hosts, reading only", () =>
  Effect.gen(function* () {
    const { value, calls } = yield* run({ hosts: ["box"] }, (service) =>
      service.readForClient({
        environmentId: EnvironmentId.make("host-status-test"),
        sessionId: "web-session",
        reachHosts: true,
      }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts.map((host) => [host.host, host.reachability])).toEqual([
      [null, "ok"],
      ["box", "ok"],
    ]);
    expect(calls).toMatchObject([
      { host: "box", tool: "goat_host_status", writes: false, arguments: { local: true } },
    ]);
  }),
);

it.effect("returns the last sample when a host that answered goes unreachable", () =>
  Effect.gen(function* () {
    let down = false;
    const { value } = yield* run(
      {
        hosts: ["box", "old-mac"],
        hostCall: (call) => {
          if (call.host === "old-mac") {
            return Effect.fail(sshError("remote_refused", "Tool 'goat_host_status' not found"));
          }
          return down
            ? Effect.fail(sshError("host_unavailable", "box is unavailable: timed out"))
            : Effect.succeed(remoteOk(9));
        },
      },
      (service) =>
        Effect.gen(function* () {
          const first = yield* service.read(scope, {});
          down = true;
          const second = yield* service.read(scope, {});
          return { first, second };
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    const box = value.success.second.hosts.find((host) => host.host === "box");
    const old = value.success.second.hosts.find((host) => host.host === "old-mac");
    expect(box).toMatchObject({
      reachability: "unreachable",
      lastKnown: true,
      message: "box is unavailable: timed out",
      metrics: { sampledAt: 9 },
    });
    expect(old).toEqual({
      host: "old-mac",
      reachability: "unsupported",
      message: "GOAT on old-mac does not offer goat_host_status. Update GOAT on that machine.",
    });
    expect(old?.metrics).toBeUndefined();
    expect(old?.lastKnown).toBeUndefined();
  }),
);

it.effect("reports this machine from its last sample when counting threads fails", () =>
  Effect.gen(function* () {
    let listFails = false;
    const { value, connectedReads } = yield* run(
      {
        get listFails() {
          return listFails;
        },
        hostCall: () => Effect.die("local read reached SSH"),
      },
      (service) =>
        Effect.gen(function* () {
          const first = yield* service.read(scope, { local: true });
          listFails = true;
          const second = yield* service.read(scope, { local: true });
          return { first, second };
        }),
    );
    expect(connectedReads()).toBe(0);
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.first.hosts).toMatchObject([
      {
        host: null,
        reachability: "ok",
        metrics: { threads: { running: 1, waiting: 1, queued: 1 } },
      },
    ]);
    expect(value.success.second.hosts[0]).toMatchObject({
      host: null,
      reachability: "unreachable",
      lastKnown: true,
      message: "Could not count threads on this machine.",
    });
  }),
);

it.effect("refuses host and local together, and an unknown named host", () =>
  Effect.gen(function* () {
    const { value, calls, connectedReads } = yield* run(
      {
        hostCall: () => Effect.fail(sshError("host_unknown", "No SSH host named ghost.")),
      },
      (service) =>
        Effect.gen(function* () {
          const both = yield* service.read(scope, { host: "box", local: true }).pipe(Effect.result);
          const ghost = yield* service.read(scope, { host: "ghost" }).pipe(Effect.result);
          return { both, ghost };
        }),
    );
    expect(connectedReads()).toBe(0);
    expect(calls.map((call) => call.host)).toEqual(["ghost"]);
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.both._tag === "Failure" && value.success.both.failure.code).toBe(
      "invalid_request",
    );
    expect(value.success.ghost._tag === "Failure" && value.success.ghost.failure.code).toBe(
      "invalid_request",
    );
  }),
);

it.effect("keeps a fan-out going when one host never finishes connecting", () =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const { value } = yield* run(
      {
        hosts: ["box", "stuck"],
        // Connecting never finishes, so the call's own deadline never starts.
        hostCall: (call) =>
          call.host === "stuck"
            ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(remoteOk(5)),
      },
      (service) =>
        Effect.gen(function* () {
          const read = yield* Effect.forkChild(service.read(scope, {}));
          yield* Deferred.await(reached);
          yield* TestClock.adjust(HOST_STATUS_REMOTE_TIMEOUT_MS);
          return yield* Fiber.join(read);
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts.map((host) => [host.host, host.reachability])).toEqual([
      [null, "ok"],
      ["box", "ok"],
      ["stuck", "unreachable"],
    ]);
    expect(value.success.hosts[1]?.metrics?.sampledAt).toBe(5);
    expect(value.success.hosts[2]?.message).toBe("stuck did not answer within 10s.");
  }),
);

it.effect("keeps a slow host's connection going across polls and keeps its late answer", () =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const connected = yield* Deferred.make<void>();
    let down = false;
    let slowCalls = 0;
    const { value, calls } = yield* run(
      {
        hosts: ["slow"],
        hostCall: () => {
          slowCalls += 1;
          return down
            ? Effect.fail(sshError("host_unavailable", "slow is unavailable: refused"))
            : Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(connected)),
                Effect.as(remoteOk(7)),
              );
        },
      },
      (service) =>
        Effect.gen(function* () {
          const firstRead = yield* Effect.forkChild(service.read(scope, {}));
          yield* Deferred.await(reached);
          yield* TestClock.adjust(HOST_STATUS_REMOTE_TIMEOUT_MS);
          const first = yield* Fiber.join(firstRead);
          const secondRead = yield* Effect.forkChild(service.read(scope, {}));
          yield* TestClock.adjust(HOST_STATUS_REMOTE_TIMEOUT_MS);
          const second = yield* Fiber.join(secondRead);
          const callsWhileConnecting = slowCalls;
          yield* Deferred.succeed(connected, undefined);
          down = true;
          const third = yield* service.read(scope, {});
          return { first, second, third, callsWhileConnecting };
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.first.hosts[1]).toMatchObject({
      host: "slow",
      reachability: "unreachable",
    });
    expect(value.success.second.hosts[1]).toMatchObject({
      host: "slow",
      reachability: "unreachable",
    });
    // The second poll waited on the connection already under way instead of starting another.
    expect(value.success.callsWhileConnecting).toBe(1);
    // The answer that arrived after both deadlines stands in once the host stops answering.
    expect(value.success.third.hosts[1]).toMatchObject({
      host: "slow",
      reachability: "unreachable",
      lastKnown: true,
      metrics: { sampledAt: 7 },
    });
    expect(calls).toHaveLength(2);
  }),
);

it.effect("keeps a fan-out going when one host is unknown", () =>
  Effect.gen(function* () {
    const { value } = yield* run(
      {
        hosts: ["ghost"],
        hostCall: () => Effect.fail(sshError("invalid_request", "No SSH host named ghost.")),
      },
      (service) => service.read(scope, {}),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts[1]).toMatchObject({
      host: "ghost",
      reachability: "unreachable",
      message: "No SSH host named ghost.",
    });
    expect(value.success.hosts[1]?.lastKnown).toBeUndefined();
  }),
);

it.effect("fails the whole call when the caller may not use SSH", () =>
  Effect.gen(function* () {
    const denied: McpInvocationScope = { ...scope, capabilities: new Set() };
    const { value: capability, calls: capabilityCalls } = yield* run(
      { hostCall: () => Effect.die("denied caller reached SSH") },
      (service) => service.read(denied, { host: "box" }),
    );
    const { value: inactive, calls: inactiveCalls } = yield* run(
      {
        shell: {
          ...liveThreadShell(threadId),
          archivedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
        },
        hostCall: () => Effect.die("inactive caller reached SSH"),
      },
      (service) => service.read(scope, { host: "box" }),
    );
    const { value: changed } = yield* run(
      {
        hosts: ["box"],
        hostCall: () => Effect.fail(sshError("caller_changed", "The caller changed.")),
      },
      (service) => service.read(scope, {}),
    );
    expect(capabilityCalls).toEqual([]);
    expect(inactiveCalls).toEqual([]);
    expect(capability._tag === "Failure" && capability.failure.code).toBe("capability_denied");
    expect(inactive._tag === "Failure" && inactive.failure.code).toBe("parent_not_active");
    expect(changed._tag === "Failure" && changed.failure.code).toBe(
      "runtime_mode_escalation_denied",
    );
  }),
);

it.effect("refreshes stale quota at most once a minute", () =>
  Effect.gen(function* () {
    const { value, refreshes } = yield* run(
      {
        providers: [provider("codex", limits("2026-10-12T15:00:00.000Z"), "Codex")],
        refreshFails: new Set(),
      },
      (service) =>
        Effect.gen(function* () {
          const first = yield* service.read(scope, { local: true });
          const second = yield* service.read(scope, { local: true });
          yield* TestClock.adjust("1 minute");
          const third = yield* service.read(scope, { local: true });
          return { first, second, third };
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.first.hosts[0]?.metrics?.quotas[0]?.fromCache).toBe(false);
    expect(value.success.second.hosts[0]?.metrics?.quotas[0]?.fromCache).toBe(true);
    expect(value.success.third.hosts[0]?.metrics?.quotas[0]?.fromCache).toBe(false);
    expect(refreshes).toEqual(["codex", "codex"]);
  }),
);

it.effect("keeps cached quota when a refresh fails and does not retry immediately", () =>
  Effect.gen(function* () {
    const { value, refreshes } = yield* run(
      {
        providers: [provider("codex", limits("2026-10-12T15:00:00.000Z"))],
        refreshFails: new Set(["codex"]),
      },
      (service) =>
        Effect.gen(function* () {
          const first = yield* service.read(scope, { local: true });
          const second = yield* service.read(scope, { local: true });
          return { first, second };
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.first.hosts[0]?.metrics?.quotas[0]).toMatchObject({
      fromCache: true,
      limits: { checkedAt: "2026-10-12T15:00:00.000Z" },
    });
    expect(value.success.second.hosts[0]?.metrics?.quotas[0]?.fromCache).toBe(true);
    expect(refreshes).toEqual(["codex"]);
  }),
);

it.effect("treats a remote payload this tool cannot read as unreachable", () =>
  Effect.gen(function* () {
    const { value } = yield* run(
      {
        hostCall: () => Effect.succeed({ hosts: [{ host: null, reachability: "sometimes" }] }),
      },
      (service) => service.read(scope, { host: "box" }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts[0]).toMatchObject({
      host: "box",
      reachability: "unreachable",
      message: "box returned a result goat_host_status could not read.",
    });
  }),
);
