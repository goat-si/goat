import {
  AuthSessionId,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as McpClientAuthority from "../../auth/McpClientAuthority.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as FleetSync from "../../goatclaw/FleetSync.ts";
import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import * as HostThreadsMcpService from "../../mcp/HostThreadsMcpService.ts";
import * as LaunchWatchService from "../../mcp/LaunchWatchService.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadLaunchMcpService from "../../mcp/ThreadLaunchMcpService.ts";
import { DispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import {
  GoalOwnerAuthorityLost,
  layer as runtimeLayer,
  type OwnerAccess,
} from "./GoalWorkerRuntime.ts";

import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import Migration0139 from "../../persistence/Migrations/139_PlacementAdmission.ts";
import * as PlacementAttempts from "../admission/PlacementAttempts.ts";
import { PlacementAdmissionEnabled } from "../admission/PlacementKey.ts";
import * as PlacementPlacer from "../admission/PlacementPlacer.ts";

export interface Seen {
  readonly dispatched: Array<{
    readonly command: OrchestrationV2ServerCommand;
    readonly limit: unknown;
  }>;
  readonly launches: Array<{
    readonly modes: unknown;
    readonly threadId: unknown;
    readonly workspace: unknown;
  }>;
  workerMode: RuntimeMode;
  lookup: "found" | "missing" | "error";
  /** What happened, in order: thread reads, confirms and dispatches. */
  readonly steps: Array<string>;
  /** Client sessions that are live; any other reads as revoked. */
  readonly liveClients: Set<string>;
  /** The mode the caller's goatclaw profile allows now; null leaves the requested mode. */
  profileMode: RuntimeMode | null;
  /** Tool calls that reached another host, with the session ceiling each ran under. */
  readonly remote: Array<{
    readonly host: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly ceiling: RuntimeMode;
  }>;
  /** Launches that reached another host. */
  readonly remoteLaunches: Array<SshRemoteDispatch.SshLaunchInput>;
  /** Threads on other hosts, as goat_thread_list lists them. */
  readonly remoteThreads: Array<{ readonly threadId: string; readonly title: string }>;
  /** Runs once, between a remote write's first authorization and its last, as SSH steps do. */
  duringWrite: (() => void) | null;
  /** The next remote launch creates its thread and loses its answer. */
  loseLaunchAnswer: boolean;
  /** The next placed remote launch is fenced by its target: "not started", leaving an idle thread. */
  fenceNextPlacement: boolean;
  /** goatclaw: on with this host allowlist, or off. */
  profileHosts: ReadonlyArray<string> | "off";
  /** The profile narrowed since it was admitted. */
  narrowed: boolean;
}

export const ownerAccess = (runtimeMode: RuntimeMode): OwnerAccess => ({
  scope: {
    environmentId: EnvironmentId.make("env:test"),
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
    requestNamespace: "test",
    thread: {
      threadId: ThreadId.make("thread:owner"),
      providerSessionId: "s",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  },
  runtimeMode,
  canReachHosts: runtimeMode === "full-access",
});

const between = (seen: Seen) => {
  const step = seen.duringWrite;
  seen.duringWrite = null;
  step?.();
};

export const layerFor = (seen: Seen, options: { readonly placement?: boolean } = {}) => {
  const dispatch = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
    // Like SshRemoteDispatch.callHostTool: the caller is authorized for the session, then
    // again right before the tool request; a refusal sends nothing.
    callHostTool: (call, authorize) =>
      Effect.gen(function* () {
        const ceiling = yield* authorize;
        if (call.writes) {
          between(seen);
          yield* authorize;
          seen.remote.push({
            host: call.host,
            tool: call.tool,
            args: { ...call.arguments },
            ceiling,
          });
          return { threadId: call.arguments.threadId, runId: "run:2", status: "running" };
        }
        if (call.tool === "goat_thread_list")
          return {
            threads: seen.remoteThreads.filter((thread) =>
              thread.title.includes(String(call.arguments.titleContains)),
            ),
            nextCursor: null,
          };
        if (call.tool === "goat_project_list") {
          // 150 projects, served a page at a time like the destination's own list.
          const start = Number(call.arguments.cursor ?? 0);
          const end = start + Number(call.arguments.limit ?? 20);
          const all = Array.from({ length: 150 }, (_, index) => ({
            id: "project:" + index,
            workspaceRoot: "/projects/" + index,
          }));
          return {
            projects: all.slice(start, end),
            nextCursor: end < all.length ? end : null,
          };
        }
        return yield* new SshRemoteDispatch.SshRemoteDispatchError({
          reason: "remote_refused",
          message: "unused",
        });
      }) as never,
    // Like launchThread: checks before the project, the session and the launch itself.
    launchThread: (input, beforeLaunch) =>
      Effect.gen(function* () {
        yield* beforeLaunch;
        between(seen);
        yield* beforeLaunch;
        // A target with placement admission answers a retried key from its record.
        const same = seen.remoteLaunches.findIndex(
          (earlier) =>
            input.placement !== undefined &&
            earlier.placement?.ownerKey === input.placement.ownerKey &&
            earlier.placement.attempt === input.placement.attempt &&
            earlier.placement.issuedAt === input.placement.issuedAt,
        );
        if (same >= 0) return { threadId: "thread:remote-" + (same + 1), runId: "run:1" } as never;
        if (input.placement !== undefined && seen.fenceNextPlacement) {
          seen.fenceNextPlacement = false;
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            message: "This placement did not start here: lease lapsed.",
            remoteClassification: "placement_not_started",
            remoteThreadId: "thread:idle",
            launchMayHaveStarted: false,
          });
        }
        seen.remoteLaunches.push(input);
        const threadId = "thread:remote-" + seen.remoteLaunches.length;
        seen.remoteThreads.push({ threadId, title: input.title });
        if (seen.loseLaunchAnswer) {
          seen.loseLaunchAnswer = false;
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "the connection dropped before the answer",
            launchMayHaveStarted: true,
          });
        }
        return { threadId, runId: "run:1" } as never;
      }) as never,
  });
  return runtimeLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.sync(() => seen.steps.push("read")).pipe(
              Effect.andThen(
                seen.lookup === "error"
                  ? Effect.fail(new Error("database busy") as never)
                  : Effect.succeed(
                      seen.lookup === "missing"
                        ? null
                        : liveThreadShell(threadId, {
                            runtimeMode: seen.workerMode,
                            activeRunId: RunId.make("run:active"),
                          }),
                    ),
              ),
            ),
          assertReviewTaskSendAllowed: () => Effect.void,
          dispatch: (command) =>
            Effect.gen(function* () {
              seen.steps.push("dispatch");
              seen.dispatched.push({ command, limit: yield* DispatchModeLimit });
              return {} as never;
            }),
        }),
        Layer.mock(ThreadLaunchMcpService.ThreadLaunchMcpService)({
          launch: (_scope, input, modes, stable) =>
            Effect.gen(function* () {
              // ThreadLaunchService asks this right before it hands over the thread's creation.
              if (stable?.confirm !== undefined && !(yield* stable.confirm))
                return yield* new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "The launcher may no longer start this work.",
                });
              seen.launches.push({
                modes,
                threadId: stable?.threadId,
                workspace: input.workspaceStrategy,
              });
              // Goal workers always launch into their stable thread id.
              const threadId = stable?.threadId;
              if (threadId === undefined)
                throw new Error("goal worker launched without a thread id");
              return {
                threadId,
                // Goal workers always name both.
                projectId: input.projectId as never,
                modelSelection: input.modelSelection as never,
                runId: null,
                status: null,
                watching: false,
                standingInstructionsVersion: null,
              };
            }),
        }),
        Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({}),
        Layer.mock(LaunchWatchService.LaunchWatchService)({}),
        Layer.mock(PullRequestService.PullRequestService)({}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({ environmentId: EnvironmentId.make("env:test") } as never),
        }),
        Layer.succeed(McpClientAuthority.McpClientAuthority, {
          load: (sessionId) =>
            Effect.succeed(
              seen.liveClients.has(sessionId)
                ? {
                    sessionId: AuthSessionId.make(sessionId),
                    grantedScopes: ["orchestration:operate" as const],
                    reauthorize: () => Effect.void,
                  }
                : { unavailable: "The MCP client session was revoked or has expired." },
            ),
        }),
        Layer.mock(Profiles.PermissionProfiles)({
          resolve: (_scope, runtimeMode) =>
            Effect.succeed({
              enabled: seen.profileHosts !== "off",
              profile: (seen.profileHosts === "off"
                ? {}
                : { id: "worker", hosts: seen.profileHosts }) as never,
              runtimeMode: seen.profileMode ?? runtimeMode ?? "approval-required",
            }),
          require: (_scope, capability, context) =>
            seen.profileHosts !== "off" &&
            context?.host !== undefined &&
            !seen.profileHosts.includes(context.host)
              ? Effect.fail(
                  new OrchestratorMcpFailure({
                    code: "capability_denied",
                    message: "The profile does not allow host " + context.host + ".",
                  }),
                )
              : Effect.sync(() => {
                  seen.steps.push("require " + capability);
                  return {
                    runtimeMode: seen.profileMode ?? context?.runtimeMode ?? "approval-required",
                  } as never;
                }),
          recheck: () =>
            seen.narrowed
              ? Effect.fail(
                  new OrchestratorMcpFailure({
                    code: "capability_denied",
                    message: "The permission profile narrowed while this launch was preparing.",
                  }),
                )
              : Effect.void,
        }),
        Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}),
        Layer.mock(FleetSync.GoatclawFleetSync)({
          ensure: (host) =>
            Effect.sync(() => {
              seen.steps.push("sync " + host);
              return { enforcesCeilings: true } as never;
            }),
        }),
        Layer.mock(ProjectStoreV2)({}),
        dispatch,
        options.placement === true
          ? PlacementPlacer.layer.pipe(
              Layer.provideMerge(PlacementAttempts.layer),
              Layer.provide(dispatch),
              Layer.provideMerge(
                Layer.effectDiscard(Effect.ignore(Migration0139)).pipe(
                  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
                ),
              ),
            )
          : Layer.empty,
      ),
    ),
    Layer.provide(Layer.succeed(PlacementAdmissionEnabled, options.placement === true)),
  );
};

export const makeSeen = (): Seen => ({
  dispatched: [],
  launches: [],
  workerMode: "approval-required",
  lookup: "found",
  steps: [],
  liveClients: new Set(["session:bot"]),
  profileMode: null,
  remote: [],
  remoteLaunches: [],
  remoteThreads: [],
  duringWrite: null,
  loseLaunchAnswer: false,
  fenceNextPlacement: false,
  profileHosts: "off",
  narrowed: false,
});

export const confirmed = (seen: Seen) => Effect.sync(() => void seen.steps.push("confirm"));
export const refused = (seen: Seen) =>
  Effect.sync(() => void seen.steps.push("confirm")).pipe(
    Effect.andThen(
      Effect.fail(new GoalOwnerAuthorityLost({ message: "revoked", goalChanged: false })),
    ),
  );
