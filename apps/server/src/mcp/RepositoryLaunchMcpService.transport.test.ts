import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as HubParity from "../hub/HubParity.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as SshConfig from "@goat/ssh/config";
import { SshLaunchError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as OpenCodexInventory from "../opencodex/OpenCodexInventory.ts";
import * as RepositoryInventory from "../project/RepositoryInventory.ts";
import * as HostStatus from "./HostStatusMcpService.ts";
import * as HostThreads from "./HostThreadsMcpService.ts";
import * as Launch from "./RepositoryLaunchMcpService.ts";
import * as Orchestrator from "./OrchestratorMcpService.ts";
import * as Coordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as Watches from "./LaunchWatchService.ts";
import * as ThreadReplica from "./ThreadReplicaService.ts";
import * as ThreadResults from "../threadResults/ThreadResultService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("diagnostic-test"),
  requestNamespace: "diagnostic-test",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: undefined,
  client: { sessionId: "diagnostic-test", label: "Fixture", access: "full-access" },
};

it.effect(
  "repository diagnosis uses ready transports for selected and candidate hosts without preparing stopped hosts",
  () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const targets = ["selected", "candidate", "stopped-candidate"].map((alias) => ({
        alias,
        hostname: alias,
        username: null,
        port: null,
        source: "ssh-config" as const,
      }));
      const bootstrap = (target: (typeof targets)[number]) => ({
        target,
        httpBaseUrl: `http://${target.alias}:3773/`,
        wsBaseUrl: `ws://${target.alias}:3773/`,
        pairingToken: null,
      });
      using _discover = vi
        .spyOn(SshConfig, "discoverSshHosts")
        .mockReturnValue(Effect.succeed(targets));
      using _manager = vi.spyOn(SshTunnel.SshEnvironmentManager, "layer").mockReturnValue(
        Layer.mock(SshTunnel.SshEnvironmentManager)({
          attachedServerKind: () => Effect.succeed(null),
          readyEnvironment: (target) =>
            Effect.sync(() => {
              events.push(`ready:${target.alias}`);
            }).pipe(
              Effect.andThen(() =>
                target.alias !== "candidate"
                  ? Effect.fail(new SshLaunchError({ message: "Stopped fixture", stdout: "" }))
                  : Effect.succeed(bootstrap(targets[1]!)),
              ),
            ),
          ensureEnvironment: (target) =>
            Effect.sync(() => {
              events.push(`ensure:${target.alias}`);
              return bootstrap(targets.find((entry) => entry.alias === target.alias)!);
            }),
          issueMcpClientSession: (target) =>
            Effect.sync(() => {
              events.push(`session:${target.alias}`);
              return {
                token: "fixture-only-session",
                expiresAt: null,
                runtimeModeCeilingApplied: true,
              };
            }),
          runRemoteScript: () => Effect.die("Diagnosis cannot run remote setup or browse scripts"),
        }),
      );
      using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        const request = JSON.parse(String(init?.body)) as {
          id?: string;
          method: string;
          params?: { name?: string };
        };
        if (request.method === "notifications/initialized")
          return new Response(null, { status: 202 });
        if (request.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          });
        if (request.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: { tools: [{ name: "goat_host_status" }] },
          });
        expect(request.method).toBe("tools/call");
        expect(request.params?.name).toBe("goat_host_status");
        events.push(`read:${new URL(url).hostname}`);
        const entries = url.includes("candidate")
          ? [
              {
                path: "/registered/repo",
                originKey: "example.test/owner/repo",
                state: "available",
                head: "a".repeat(40),
                branch: "main",
                upstream: null,
                ahead: null,
                behind: null,
                dirty: false,
                dependencies: { state: "unknown", installedAt: null },
              },
            ]
          : [];
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            structuredContent: {
              hosts: [
                {
                  host: null,
                  reachability: "ok",
                  repositories: { sampledAt: 0, entries, truncated: false },
                },
              ],
            },
          },
        });
      });
      const dispatch = SshRemoteDispatch.layer.pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "repository-diagnostic-" })),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(NodeServices.layer),
      );
      const dependencies = Layer.mergeAll(
        Layer.mock(HubParity.HubParity)({ latest: () => Effect.succeed(undefined) }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({
          quotaPool: Effect.succeed(undefined),
          projectProviders: (providers) => Effect.succeed(providers),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          listProjectThreads: () => Effect.succeed([]),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(HostResources.HostResources)({
          read: Effect.succeed({
            sampledAt: 0,
            cpuCount: 1,
            cpuUtilization: 0,
            availableMemoryBytes: 1,
            totalMemoryBytes: 1,
            loadAvg: null,
            disk: null,
          }),
        }),
        Layer.mock(OpenCodexInventory.OpenCodexInventory)({
          read: Effect.succeed({
            installed: false,
            binaries: [],
            ownership: "none",
            service: { available: false },
            runtime: { port: 10100, healthy: false, ready: false },
            link: { role: "none", available: false, links: [], childSettingsApplied: false },
          }),
        }),
        Layer.mock(RepositoryInventory.RepositoryInventory)({
          read: Effect.succeed({ sampledAt: 0, entries: [], truncated: false }),
        }),
        Layer.mock(Orchestrator.OrchestratorMcpService)({}),
        Layer.mock(Coordinator.RemoteDispatchCoordinator)({}),
        Layer.mock(Watches.LaunchWatchService)({}),
        Layer.mock(ThreadReplica.ThreadReplicaService)({}),
        Layer.mock(ThreadResults.ThreadResultService)({}),
        dispatch,
      );
      const layer = Launch.layer.pipe(
        Layer.provideMerge(HostStatus.layer),
        Layer.provide(HostThreads.layer.pipe(Layer.provide(layerNoFleetSync))),
        Layer.provide(dependencies),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launch = yield* Launch.RepositoryLaunchMcpService;
        const result = yield* launch
          .check(scope, {
            host: "selected",
            path: "/registered/repo",
            repository: {
              key: "example.test/owner/repo",
              candidateHosts: ["candidate", "stopped-candidate"],
            },
          })
          .pipe(Effect.flip);
        expect(result.message).toContain("host unavailable");
        expect(result.message).toContain("candidate: /registered/repo");
        expect(events).toContain("ready:selected");
        expect(events).toContain("ready:candidate");
        expect(events).toContain("ready:stopped-candidate");
        expect(result.message).toContain("stopped-candidate: unavailable");
        expect(events).toContain("read:candidate");
        expect(
          events.filter(
            (event) =>
              event.startsWith("ensure:") ||
              event === "session:selected" ||
              event === "read:selected" ||
              event === "session:stopped-candidate" ||
              event === "read:stopped-candidate",
          ),
        ).toEqual([]);
        const beforeDenied = [...events];
        const denied = yield* launch
          .check(
            { ...scope, capabilities: new Set() },
            {
              host: "selected",
              path: "/registered/repo",
              repository: { key: "example.test/owner/repo" },
            },
          )
          .pipe(Effect.flip);
        expect(denied.code).toBe("capability_denied");
        expect(events).toEqual(beforeDenied);
        const alias = yield* launch
          .check(scope, {
            host: "candidate",
            path: "/alias",
            repository: { key: "example.test/owner/repo" },
          })
          .pipe(Effect.flip);
        expect(alias.message).toContain("canonical path");
        const status = yield* HostStatus.HostStatusMcpService;
        yield* status.read(scope, { host: "selected", repositories: true });
        expect(events).toContain("ensure:selected");
        expect(events).toContain("read:selected");
      }).pipe(Effect.provide(layer));
    }),
);
