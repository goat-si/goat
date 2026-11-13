// Shared harness for the host-status service tests.
import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  GoatHostStatusResult,
  ProviderDriverKind,
  ProviderInstanceId,
  QuotaPool,
  ThreadId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type OpenCodexChildBootstrapStatus,
  type OpenCodexInventorySnapshot,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OpenCodexInventory from "../opencodex/OpenCodexInventory.ts";
import * as OpenCodexChildBootstrap from "../opencodex/OpenCodexChildBootstrap.ts";
import * as HubParity from "../hub/HubParity.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HostStatusMcpService from "./HostStatusMcpService.ts";
import * as RepositoryInventory from "../project/RepositoryInventory.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import payload from "../usage/fixtures/opencodex-quota-pool.json" with { type: "json" };
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

export const pool = Schema.decodeUnknownSync(QuotaPool)(payload);
export const threadId = ThreadId.make("caller-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
export const now = Date.parse("2026-10-12T16:00:00.000Z");
export const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("host-status-test"),
  requestNamespace: "thread:caller",
  thread: { threadId, providerSessionId: "session", providerInstanceId },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
export const capacity = {
  sampledAt: 1_791_823_810_477,
  cpuUtilization: 0.12,
  cpuCount: 8,
  availableMemoryBytes: 12_000_000_000,
  totalMemoryBytes: 16_000_000_000,
  loadAvg: { oneMinute: 1.2, fiveMinutes: 0.9, fifteenMinutes: 0.7 },
  disk: { path: "/", availableBytes: 100_000_000_000, totalBytes: 500_000_000_000 },
};
export const decode = Schema.decodeUnknownSync(GoatHostStatusResult);
export const encodeHostStatus = Schema.encodeUnknownEffect(GoatHostStatusResult);

export const limits = (checkedAt: string, reason?: "unsupported"): ServerProviderUsageLimits => ({
  checkedAt,
  windows:
    reason === undefined ? [{ id: "primary", kind: "session", label: "5h", usedPercent: 40 }] : [],
  ...(reason === undefined ? {} : { unavailable: { reason, message: "API key" } }),
});

export const provider = (
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

export const remoteOk = (sampledAt: number, opencodex?: OpenCodexInventorySnapshot) => ({
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

export const sshError = (
  reason: SshRemoteDispatch.SshRemoteDispatchError["reason"],
  message: string,
) => new SshRemoteDispatch.SshRemoteDispatchError({ reason, message });

export const run = <A, E>(
  options: {
    readonly hosts?: ReadonlyArray<string>;
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly quotaPool?: QuotaPool;
    readonly refreshFails?: ReadonlySet<string>;
    readonly listFails?: boolean;
    readonly shell?: ReturnType<typeof liveThreadShell>;
    readonly children?: Readonly<Record<string, OpenCodexChildBootstrapStatus>>;
    readonly opencodex?: OpenCodexInventorySnapshot;
    readonly opencodexRead?: Effect.Effect<OpenCodexInventorySnapshot>;
    /** SSH hosts the hub offers the Child setup switch for, and whether it is on. */
    readonly optIns?: Readonly<Record<string, boolean>>;
    readonly hostCall?: (
      call: SshRemoteDispatch.SshHostToolCall,
    ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    /** Runs inside each provider refresh, after it starts; a slow probe sleeps on the TestClock. */
    readonly probe?: (instanceId: string) => Effect.Effect<void>;
  },
  body: (
    service: HostStatusMcpService.HostStatusMcpServiceShape,
    probes: Probes,
  ) => Effect.Effect<A, E>,
) => {
  const calls: Array<SshRemoteDispatch.SshHostToolCall> = [];
  const refreshes: Array<string> = [];
  const queries: Array<{ projectId: unknown; includeSubagents: boolean }> = [];
  let connectedReads = 0;
  let repositoryReads = 0;
  let parityReads = 0;
  const inventory = {
    installed: false,
    binaries: [],
    ownership: "none" as const,
    service: { available: false },
    runtime: { port: 10100, healthy: false, ready: false },
    link: { role: "none" as const, available: false, links: [], childSettingsApplied: false },
  };
  const providers = { current: options.providers ?? [] };
  const interrupted = { value: false };
  const makeLayer = (probes: Probes) =>
    HostStatusMcpService.layer.pipe(
      Layer.provide(ServerSettings.layerTest(options.settings)),
      Layer.provide(
        Layer.mock(HubParity.HubParity)({
          latest: () => Effect.sync(() => undefined),
          readLocal: Effect.sync(() => {
            parityReads += 1;
            return inventory;
          }),
        }),
      ),
      Layer.provide(
        Layer.succeed(RepositoryInventory.RepositoryInventory, {
          read: Effect.sync(() => {
            repositoryReads += 1;
            return { sampledAt: 0, entries: [], truncated: false };
          }),
          readFresh: Effect.succeed({ sampledAt: 0, entries: [], truncated: false }),
        }),
      ),
      Layer.provide(
        Layer.mock(OpenCodexInventory.OpenCodexInventory)({
          read: options.opencodexRead ?? Effect.succeed(options.opencodex ?? inventory),
        }),
      ),
      Layer.provide(
        Layer.mock(UsageLimitSources.UsageLimitSources)({
          quotaPool: Effect.succeed(options.quotaPool),
          projectProviders: (providers) => Effect.succeed(providers),
        }),
      ),
      Layer.provide(HostThreadsMcpService.layer.pipe(Layer.provide(layerNoFleetSync))),
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
              yield* Queue.offer(probes.started, instanceId);
              if (options.refreshFails?.has(instanceId)) {
                // refreshInstance does not fail in its type. This still fails at
                // runtime so the status read's failure handling can be observed.
                return yield* Effect.fail("probe failed" as never);
              }
              if (options.probe !== undefined) yield* options.probe(instanceId);
              const checkedAt = DateTime.formatIso(yield* DateTime.now);
              providers.current = providers.current.map((item) =>
                item.instanceId === instanceId && item.usageLimits !== undefined
                  ? { ...item, usageLimits: { ...item.usageLimits, checkedAt } }
                  : item,
              );
              return providers.current;
            }).pipe(
              Effect.onInterrupt(() => Effect.sync(() => (interrupted.value = true))),
              Effect.ensuring(Queue.offer(probes.finished, instanceId)),
            ),
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
      Layer.provide(
        Layer.mock(OpenCodexChildBootstrap.OpenCodexChildBootstrap)({
          status: (alias) => Effect.succeed(options.children?.[alias]),
          sshOptIn: (alias) => Effect.succeed(options.optIns?.[alias]),
        }),
      ),
      Layer.provide(
        Layer.mock(LaunchWatchService.LaunchWatchService)({
          find: () => Effect.succeed(null),
        }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
      ),
    );
  return Effect.gen(function* () {
    const probes: Probes = {
      started: yield* Queue.unbounded<string>(),
      finished: yield* Queue.unbounded<string>(),
      count: () => refreshes.length,
    };
    yield* TestClock.setTime(now);
    const value = yield* Effect.gen(function* () {
      const service = yield* HostStatusMcpService.HostStatusMcpService;
      return yield* body(service, probes).pipe(Effect.result);
    }).pipe(Effect.provide(makeLayer(probes)));
    return {
      value,
      calls,
      refreshes,
      queries,
      connectedReads: () => connectedReads,
      repositoryReads,
      parityReads,
      interrupted: interrupted.value,
    };
  });
};

/** A provider refresh started, and one finished (either way). */
export interface Probes {
  readonly started: Queue.Queue<string>;
  readonly finished: Queue.Queue<string>;
  /** Refreshes started so far. */
  readonly count: () => number;
}

it.effect.each([
  { repositories: false, parityEvidence: false },
  { repositories: true, parityEvidence: false },
  { repositories: false, parityEvidence: true },
  { repositories: true, parityEvidence: true },
])("keeps repository and parity collection independent: %j", (flags) =>
  Effect.gen(function* () {
    const result = yield* run({}, (service) => service.read(scope, { local: true, ...flags }));
    expect(result.value._tag).toBe("Success");
    expect(result.repositoryReads).toBe(Number(flags.repositories));
    expect(result.parityReads).toBe(Number(flags.parityEvidence));
    expect(result.calls).toHaveLength(0);
    if (result.value._tag === "Success")
      expect(result.value.success.hosts[0]?.repositories !== undefined).toBe(flags.repositories);
  }),
);

export const staleCodex = () => [provider("codex", limits("2026-10-12T15:00:00.000Z"), "Codex")];
