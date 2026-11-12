/**
 * A fake remote GOAT for SSH launch tests: it answers tools/list with the goat_thread_launch
 * arguments a test declares and records every launch it receives.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, vi } from "@effect/vitest";
import { EnvironmentId, NodeId, RunId, ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as SshConfig from "@goat/ssh/config";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as LaunchWatchService from "../mcp/LaunchWatchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import Migration0062 from "../persistence/Migrations/081_RemoteReports.ts";
import Migration0063 from "../persistence/Migrations/082_RemoteDispatches.ts";
import Migration0065 from "../persistence/Migrations/084_RemoteDispatchQuestions.ts";
import Migration0068 from "../persistence/Migrations/086_RemoteReportRelay.ts";
import Migration0073 from "../persistence/Migrations/091_MemoryTaskGrantCeiling.ts";
import * as Coordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

export const launcher = {
  kind: "launch" as const,
  threadId: ThreadId.make("orchestrator"),
  environmentId: EnvironmentId.make("launcher-environment"),
  environmentLabel: "studio",
  threadTitle: "Orchestrator",
};

export const reportBinding = {
  correlationId: "rr-lineage",
  originLabel: "studio",
  originThreadId: ThreadId.make("orchestrator"),
  readKeyHash: "0".repeat(64),
};

/** Launches against a fake remote and returns the arguments goat_thread_launch received. */
export const launchAgainst = (remote: {
  readonly permissionProfileCeiling?: import("@goat/contracts").PermissionProfile;
  readonly declaresPermissionProfile?: boolean;
  readonly declaresLaunchedBy: boolean;
  readonly coordinatorKind?: "thread" | "task";
  readonly refuseLaunchedBy?: boolean;
  readonly afterLaunchedByRefusal?: {
    readonly advertisesMemory: boolean;
    readonly declaresMemoryCeiling: boolean;
    readonly listFailure?: "failed" | "timeout" | "malformed" | "malformed-entry";
  };
  readonly callerRuntimeMode?: SshRemoteDispatch.SshLaunchInput["callerRuntimeMode"];
  readonly standingInstructions?: false;
  readonly refuseReport?: boolean;
  readonly afterReportRefusal?: {
    readonly advertisesMemory: boolean;
    readonly declaresMemoryCeiling: boolean;
    readonly listFailure?: "failed" | "timeout" | "malformed" | "malformed-entry";
  };
  readonly afterFirstLaunch?: {
    readonly advertisesMemory: boolean;
    readonly declaresMemoryCeiling: boolean;
    readonly listFailure?: "failed" | "timeout" | "malformed" | "malformed-entry";
  };
  readonly declaresStandingInstructions?: boolean;
  readonly listFailure?: "failed" | "timeout" | "malformed" | "malformed-entry";
  readonly onList?: () => void;
  readonly memoryCeilings?: ReadonlyArray<import("@goat/contracts").MemoryTaskGrantCeiling>;
  readonly declaresMemoryCeiling?: boolean;
  readonly advertisesMemory?: boolean;
  readonly onMemoryLaunch?: () => void;
  readonly declaresReport?: boolean;
  readonly declaresNotifyOnCompletion?: boolean;
  /** The remote's launcher schema lists workKind, as GOAT Bot's chore marking needs. */
  readonly declaresLauncherWorkKind?: boolean;
  /** The forwarded launcher carries this work kind. */
  readonly launcherWorkKind?: "chore" | "coding";
  /** What goat_environment_read answers; the fixture's project reply when absent. */
  readonly remoteEnvironmentId?: string;
  /** Launch for an outside client, with no launching thread. */
  readonly outside?: boolean;
  /** Launch with a report binding and its agent note. */
  readonly withReport?: boolean;
  /** Launch twice through one dispatch service; the remote declares report from the second. */
  readonly upgradeBetweenLaunches?: boolean;
  readonly listFails?: boolean;
  /** The listing never answers until the caller gives up and aborts it. */
  readonly onListStalled?: () => void;
  readonly declaresPlacement?: boolean;
  readonly placement?: import("../fleet/admission/PlacementKey.ts").PlacementArgument;
  /** Launch twice; only the second carries placement. */
  readonly placementOnSecondLaunch?: import("../fleet/admission/PlacementKey.ts").PlacementArgument;
  /** goat_thread_launch refuses with this payload, as a remote GOAT encodes a failure. */
  /** A structured refusal, or bare text sent as the error's only content. */
  readonly launchRefusal?: Record<string, unknown> | string;
  /** Merged into goat_thread_launch's answer. */
  readonly launchAnswer?: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const host = "lineage-host";
    const target = { alias: host, hostname: host, username: null, port: null };
    const launches: Array<Record<string, unknown>> = [];
    const memorySessions: Array<ReadonlyArray<string>> = [];
    const presentedTokens: Array<string | null> = [];
    let declaresReport = remote.declaresReport === true;
    let reportRefused = false;
    let launchedByRefused = false;
    const fetchEndpoint = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id?: string;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      switch (request.method) {
        case "initialize":
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "GOAT", version: "fixture" },
            },
          });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list": {
          remote.onList?.();
          const catalog =
            launchedByRefused && remote.afterLaunchedByRefusal !== undefined
              ? remote.afterLaunchedByRefusal
              : reportRefused && remote.afterReportRefusal !== undefined
                ? remote.afterReportRefusal
                : launches.length > 0 && remote.afterFirstLaunch !== undefined
                  ? remote.afterFirstLaunch
                  : remote;
          const listFailure = "listFailure" in catalog ? catalog.listFailure : undefined;
          if (listFailure === "failed") return new Response(null, { status: 500 });
          if (listFailure === "malformed" || listFailure === "malformed-entry")
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: { tools: listFailure === "malformed" ? {} : [null] },
            });
          if (remote.listFails === true) return new Response(null, { status: 500 });
          if (
            listFailure === "timeout" ||
            (remote.onListStalled !== undefined &&
              remote.listFailure === undefined &&
              remote.afterReportRefusal?.listFailure === undefined &&
              remote.afterLaunchedByRefusal?.listFailure === undefined &&
              remote.afterFirstLaunch?.listFailure === undefined)
          ) {
            remote.onListStalled?.();
            return new Promise<Response>((_resolve, reject) =>
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
            );
          }
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              tools: [
                ...(catalog.advertisesMemory
                  ? [{ name: "memory_search", inputSchema: { type: "object", properties: {} } }]
                  : []),
                {
                  name: "goat_thread_launch",
                  inputSchema: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      ...(remote.declaresPermissionProfile
                        ? { permissionProfileCeiling: { type: "object" } }
                        : {}),
                      ...(catalog.declaresMemoryCeiling
                        ? { memoryGrantCeiling: { type: "string" } }
                        : {}),
                      ...(remote.declaresLaunchedBy
                        ? {
                            launchedBy:
                              remote.declaresLauncherWorkKind === true
                                ? {
                                    anyOf: [
                                      {
                                        type: "object",
                                        properties: {
                                          kind: { type: "string" },
                                          threadId: { type: "string" },
                                          workKind: {
                                            anyOf: [
                                              { type: "string", enum: ["coding", "chore"] },
                                              { type: "null" },
                                            ],
                                          },
                                        },
                                      },
                                      { type: "null" },
                                    ],
                                  }
                                : { type: "object" },
                          }
                        : {}),
                      ...(declaresReport ? { report: { type: "object" } } : {}),
                      ...(remote.declaresStandingInstructions
                        ? { standingInstructions: { type: "boolean" } }
                        : {}),
                      ...(remote.declaresNotifyOnCompletion === true
                        ? { notifyOnCompletion: { type: "boolean" } }
                        : {}),
                      ...(remote.declaresPlacement === true
                        ? { placement: { type: "object" } }
                        : {}),
                    },
                  },
                },
              ],
            },
          });
        }
        case "tools/call": {
          if (
            request.params?.name === "goat_environment_read" &&
            remote.remoteEnvironmentId !== undefined
          )
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: { structuredContent: { environmentId: remote.remoteEnvironmentId } },
            });
          if (request.params?.name === "goat_thread_launch") {
            remote.onMemoryLaunch?.();
            presentedTokens.push(new Headers(init?.headers).get("authorization"));
            launches.push(request.params.arguments ?? {});
          }
          if (
            remote.refuseLaunchedBy &&
            request.params?.name === "goat_thread_launch" &&
            request.params.arguments?.launchedBy !== undefined
          ) {
            launchedByRefused = true;
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    // What GOAT's admission answers for an undeclared argument.
                    text: JSON.stringify({
                      _tag: "OrchestratorMcpFailure",
                      code: "invalid_request",
                      message:
                        "goat_thread_launch does not take launchedBy, so nothing ran. It takes projectId, title.",
                    }),
                  },
                ],
              },
            });
          }
          if (request.params?.name === "goat_thread_launch" && remote.launchRefusal !== undefined)
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text:
                      typeof remote.launchRefusal === "string"
                        ? remote.launchRefusal
                        : JSON.stringify(remote.launchRefusal),
                  },
                ],
              },
            });
          const report = request.params?.arguments?.report as
            | { readonly correlationId: string }
            | undefined;
          if (remote.refuseReport && report !== undefined) {
            reportRefused = true;
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      _tag: "OrchestratorMcpFailure",
                      code: "invalid_request",
                      message: "goat_thread_launch does not take report, so nothing ran.",
                    }),
                  },
                ],
              },
            });
          }
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              structuredContent: {
                projects: [],
                id: "new-project",
                threadId: "new-thread",
                ...(report === undefined
                  ? {}
                  : { report: { correlationId: report.correlationId } }),
                ...(request.params?.name === "goat_thread_launch" ? remote.launchAnswer : {}),
              },
            },
          });
        }
        default:
          throw new Error(`Unexpected remote method: ${request.method}`);
      }
    });
    const manager = SshTunnel.SshEnvironmentManager.of({
      status: () => Effect.die("Unexpected runtime status"),
      ensureEnvironment: () =>
        Effect.succeed({
          target,
          httpBaseUrl: "http://lineage-host:3773/",
          wsBaseUrl: "ws://lineage-host:3773/",
          pairingToken: null,
        }),
      readyEnvironment: () => Effect.die("Unexpected ready environment"),
      beginSetupOperation: () => Effect.die("Unexpected setup operation"),
      publishSetupOutcome: () => Effect.succeed(true),
      publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
      forgetEnvironment: () => Effect.die("Unexpected forget"),
      disconnectEnvironment: () => Effect.die("Unexpected SSH disconnect"),
      revalidateTunnels: () => Effect.void,
      issueClientSession: () => Effect.die("unused"),
      issueMcpClientSession: (_target, options) =>
        Effect.sync(() => {
          memorySessions.push(options.memoryScopes ?? []);
          return {
            token: `fixture-session-${memorySessions.length}`,
            expiresAt: null,
            runtimeModeCeilingApplied: true,
          };
        }),
      runRemoteScript: () =>
        Effect.succeed({
          stdout:
            "T3B\t1\nHOME\t/home/agent\nOS\tLinux\nPATH\t/home/agent/repo\nREAL\t/home/agent/repo\n",
          stderr: "",
        }),
    });
    const discoverHosts = vi
      .spyOn(SshConfig, "discoverSshHosts")
      .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
    const managerLayer = vi
      .spyOn(SshTunnel.SshEnvironmentManager, "layer")
      .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
    vi.stubGlobal("fetch", fetchEndpoint);
    try {
      const result = yield* Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        const launch = (
          memoryGrantCeiling?: import("@goat/contracts").MemoryTaskGrantCeiling,
          placement = remote.placement,
        ) => {
          const input: SshRemoteDispatch.SshLaunchInput = {
            ...(placement === undefined ? {} : { placement, message: "Placed work" }),
            host,
            cwd: "/home/agent/repo",
            workspace: { type: "cwd" },
            title: "Lineage probe",
            ...(remote.permissionProfileCeiling === undefined
              ? {}
              : { permissionProfileCeiling: remote.permissionProfileCeiling }),
            ...(memoryGrantCeiling === undefined ? {} : { memoryGrantCeiling }),
            runtimeMode: "approval-required",
            callerRuntimeMode: remote.callerRuntimeMode ?? "approval-required",
            ...(remote.standingInstructions === false ? { standingInstructions: false } : {}),
            ...(remote.outside === true
              ? {}
              : {
                  launchedBy:
                    remote.launcherWorkKind === undefined
                      ? launcher
                      : { ...launcher, workKind: remote.launcherWorkKind },
                }),
            ...(remote.withReport === true
              ? { message: "Do the work", report: reportBinding, reportNote: "Report back." }
              : {}),
          };
          const coordinatorKind = remote.coordinatorKind;
          if (coordinatorKind === undefined) return dispatch.launchThread(input, Effect.void);
          return Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* Migration0062;
            yield* Migration0063;
            yield* Migration0065;
            yield* Migration0068;
            yield* sql`CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY)`;
            yield* Migration0073;
            return yield* Effect.gen(function* () {
              const coordinator = yield* Coordinator.RemoteDispatchCoordinator;
              const launched = yield* coordinator.launch(
                {
                  kind: coordinatorKind,
                  originThreadId: launcher.threadId,
                  delivery: "notify_only",
                  launch: input,
                  ...(coordinatorKind === "task"
                    ? {
                        task: {
                          taskId: NodeId.make("fixture-task"),
                          parentRunId: RunId.make("fixture-parent-run"),
                        },
                      }
                    : {}),
                },
                Effect.void,
              );
              const stored = yield* coordinator.get(launched.correlationId);
              expect(stored?.memoryGrantCeiling).toBe(memoryGrantCeiling ?? "none");
              return launched.launch;
            }).pipe(
              Effect.provide(
                Coordinator.layer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      Layer.succeed(SqlClient.SqlClient, sql),
                      Layer.succeed(SshRemoteDispatch.SshRemoteDispatch, dispatch),
                      Layer.mock(ThreadManagement.ThreadManagementService)({
                        getThreadShell: () => Effect.succeed(null),
                        dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
                      }),
                      Layer.mock(LaunchWatchService.LaunchWatchService)({}),
                    ),
                  ),
                ),
              ),
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
        };
        const [firstCeiling, ...moreCeilings] = remote.memoryCeilings ?? [];
        if (firstCeiling !== undefined) {
          let result = yield* launch(firstCeiling);
          for (const ceiling of moreCeilings) result = yield* launch(ceiling);
          return result;
        }
        if (remote.placementOnSecondLaunch !== undefined) {
          yield* launch();
          return yield* launch(undefined, remote.placementOnSecondLaunch);
        }
        if (remote.upgradeBetweenLaunches !== true) return yield* launch();
        yield* launch();
        declaresReport = true;
        return yield* launch();
      }).pipe(
        Effect.provide(
          SshRemoteDispatch.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-dispatch-test-" })),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      return { result, launches, memorySessions, presentedTokens };
    } finally {
      vi.unstubAllGlobals();
      managerLayer.mockRestore();
      discoverHosts.mockRestore();
    }
  });
