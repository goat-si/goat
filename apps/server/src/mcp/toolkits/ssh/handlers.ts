import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as FleetSync from "../../../goatclaw/FleetSync.ts";
import {
  goatclawRoleBrief,
  missingRoleCapabilities,
  roleRefusal,
} from "../../../goatclaw/RoleTemplates.ts";
import { newCommandId } from "../../threadAccess.ts";
import { addDevice } from "./addDevice.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import {
  type CloudMachineError,
  OrchestratorMcpFailure,
  RunId,
  type ServerActivityBlocker,
  type SshHostResult,
  SshWorkspaceError,
  type SshLaunchWorkspace,
  ThreadId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as CloudMachineService from "../../../cloudMachines/CloudMachineService.ts";
import * as LinkedHosts from "../../../linkedHosts/LinkedHosts.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as SshHostSetup from "../../../sshRemote/SshHostSetup.ts";
import * as SshWorkspaceSync from "../../../sshRemote/SshWorkspaceSync.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import * as RepositoryLaunchMcpService from "../../RepositoryLaunchMcpService.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as HostStatusMcpService from "../../HostStatusMcpService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { resolveRuntimeMode } from "../../OrchestratorMcpService.ts";
import { admitLaunch } from "../../pressureAdmission.ts";
import { SshToolkit, SshThreadHandoffFailure } from "./tools.ts";

// Resolved per call: the coordinator sits on an import cycle through LaunchWatchService and
// the MCP services, so its exports can still be undefined while this module evaluates.
const isRemoteDispatchError = (u: unknown): u is RemoteDispatchCoordinator.RemoteDispatchError =>
  Schema.is(RemoteDispatchCoordinator.RemoteDispatchError)(u);

/**
 * The remote's local branches are usually behind origin, so a dispatched
 * worktree starts from origin unless the caller says otherwise. The remote
 * falls back to its local base when origin or the remote branch is missing.
 */
const sshLaunchWorkspace = (workspace: SshLaunchWorkspace | undefined): SshLaunchWorkspace =>
  workspace === undefined
    ? { type: "cwd" }
    : workspace.type === "worktree"
      ? { ...workspace, startFromOrigin: workspace.startFromOrigin ?? true }
      : workspace;

const toMcpFailure = (error: SshRemoteDispatch.SshRemoteDispatchError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "invalid_request" || error.reason === "host_unknown"
        ? "invalid_request"
        : "orchestration_error",
    message: Array.from(error.message).slice(0, 2000).join(""),
  });

/** Names what a busy host is running, so a waiting update says what it waits for. */
export const withUpdateBlockers = (
  result: SshHostResult,
  blockers: ReadonlyArray<ServerActivityBlocker>,
): SshHostResult => {
  if (result.kind !== "ok" || blockers.length === 0) return result;
  const shown = blockers
    .slice(0, 3)
    .map(
      (blocker) =>
        `${blocker.title === null ? blocker.threadId : `"${blocker.title}" (${blocker.threadId})`} ${blocker.reason} since ${blocker.since}`,
    );
  const more = blockers.length > shown.length ? `, and ${blockers.length - shown.length} more` : "";
  return {
    ...result,
    status: {
      ...result.status,
      blockers,
      detail: `Update to ${result.status.requestedVersion} waits for ${shown.join("; ")}${more}. goat_ssh_runtime_update with mode now stops that work after a person approves.`,
    },
  };
};

/** The host's own activity check, read through its goat_host_status; empty when it cannot say. */
const readUpdateBlockers = Effect.fn("SshToolkit.readUpdateBlockers")(
  function* (host: string) {
    const statusService = yield* Effect.serviceOption(HostStatusMcpService.HostStatusMcpService);
    if (statusService._tag === "None") return [];
    // Same gate as goat_host_status reaching a host; a refused caller keeps the plain status.
    yield* McpToolAccess.hostReachingCaller;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    // Ready-only reads refuse update_waiting, the one state this explains. This reads like
    // goat_host_status for the host: busy waiting keeps the old runtime attached, so it answers there.
    const result = yield* statusService.value.read(scope, { host });
    const entry = result.hosts.find((candidate) => candidate.host === host);
    return entry?.reachability === "ok" ? (entry.metrics?.threads.blockers ?? []) : [];
  },
  (effect) => effect.pipe(Effect.orElseSucceed((): ReadonlyArray<ServerActivityBlocker> => [])),
);

/** The server always provides it; a test layer without it has no links. */
const linkedHostsService = Effect.serviceOption(LinkedHosts.LinkedHosts).pipe(
  Effect.flatMap((service) =>
    service._tag === "Some"
      ? Effect.succeed(service.value)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "This GOAT server cannot link hosts.",
          }),
        ),
  ),
);

const toHandoffFailure = (error: SshWorkspaceError) =>
  new SshThreadHandoffFailure({
    code: error.code,
    message:
      error.code === "thread_busy"
        ? "The source thread has another active or queued run. Wait for it to finish before handing off."
        : error.message,
  });

/** SSH reaches other machines with this machine's keys, so it is an orchestration capability. */
const requireOrchestration = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This credential cannot reach other machines.",
          }),
        ),
  ),
);

/**
 * Cloud machines bill the user's Boat account, so changing them needs what changing settings
 * needs: a live settings:write grant that is reconfirmed for this call (as memory's settings tools).
 */
const requireSettingsWrite = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => {
    const deny = () =>
      new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          "Changing cloud machines needs a caller allowed to change this machine's settings.",
      });
    if (
      scope.readOnly ||
      scope.client?.access === "read-only" ||
      !scope.grantedScopes?.includes("settings:write") ||
      !scope.reauthorize
    )
      return Effect.fail(deny());
    return scope.reauthorize(["settings:write"]).pipe(Effect.mapError(deny));
  }),
);

const toCloudFailure = (error: CloudMachineError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "not_found" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const toLinkFailure = (error: LinkedHosts.LinkedHostError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "invalid_request"
        ? "invalid_request"
        : error.reason === "link_refused"
          ? "capability_denied"
          : "orchestration_error",
    message: Array.from(error.message).slice(0, 2000).join(""),
  });

export const layer = McpToolAccess.toLayer(SshToolkit, {
  goat_ssh_host_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* requireOrchestration;
      const setup = yield* SshHostSetup.SshHostSetup;
      const result = yield* setup.status(input);
      if (
        result.kind !== "ok" ||
        result.status.state !== "update_waiting" ||
        result.status.waitingReason !== "busy"
      )
        return result;
      return withUpdateBlockers(result, yield* readUpdateBlockers(input.host));
    }),
  ),
  goat_ssh_host_add: addDevice,
  goat_ssh_host_prepare: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const setup = yield* SshHostSetup.SshHostSetup;
      return yield* setup.prepare(input, { kind: "mcp", scope }).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code:
                error._tag === "EnvironmentAuthorizationError"
                  ? "capability_denied"
                  : "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
  goat_ssh_host_forget: McpToolAccess.destructive(
    McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const setup = yield* SshHostSetup.SshHostSetup;
        return yield* setup.forget(input, { kind: "mcp", scope }).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code:
                  error._tag === "EnvironmentAuthorizationError"
                    ? "capability_denied"
                    : "orchestration_error",
                message: error.message,
              }),
          ),
        );
      }),
    ),
  ),
  goat_ssh_runtime_update: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const caller = yield* check;
      const setup = yield* SshHostSetup.SshHostSetup;
      return yield* setup
        .update(input, { kind: "mcp", scope: caller.scope })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "capability_denied", message: error.message }),
          ),
        );
    }),
  ),
  // Reading ~/.ssh/config changes nothing; probing logs in but runs only `true`.
  goat_ssh_host_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* requireOrchestration;
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const hosts = yield* dispatch
        .listHosts({ probe: input.probe === true })
        .pipe(Effect.mapError(toMcpFailure));
      return { hosts: [...hosts] };
    }),
  ),
  // Linking stores a session that reaches another machine, like saving a connection.
  goat_host_link_create: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      yield* requireOrchestration;
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const sshHosts = yield* dispatch
        .listHosts({ probe: false })
        .pipe(Effect.orElseSucceed((): ReadonlyArray<SshRemoteDispatch.SshDispatchHost> => []));
      if (sshHosts.some((host) => host.alias === input.name.trim())) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${input.name} is already an SSH host on this machine; pick another name for the link.`,
        });
      }
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const descriptor = yield* environment.getDescriptor;
      const linkedHosts = yield* linkedHostsService;
      const linked = yield* linkedHosts
        .link({
          name: input.name,
          url: input.url,
          code: input.code,
          access: input.access ?? "approval-required",
          beforeSave: check.pipe(Effect.asVoid),
          clientName: `GOAT on ${descriptor.label}`,
        })
        .pipe(
          Effect.mapError((error) =>
            error instanceof LinkedHosts.LinkedHostError ? toLinkFailure(error) : error,
          ),
        );
      return { host: linked.host, replaced: linked.replaced };
    }),
  ),
  goat_host_link_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* requireOrchestration;
      const linkedHosts = yield* Effect.serviceOption(LinkedHosts.LinkedHosts);
      if (linkedHosts._tag === "None") return { hosts: [] };
      const hosts = yield* linkedHosts.value.list.pipe(Effect.mapError(toLinkFailure));
      return { hosts: [...hosts] };
    }),
  ),
  goat_host_link_remove: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        const linkedHosts = yield* linkedHostsService;
        const removed = yield* linkedHosts.unlink(input.name).pipe(Effect.mapError(toLinkFailure));
        if (removed._tag === "None") {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `No host is linked as ${input.name}. Call goat_host_link_list for the linked hosts.`,
          });
        }
        return { removed: removed.value };
      }),
    ),
  ),
  // Browsing changes nothing remote, but it runs commands there with this
  // machine's SSH keys, so read-only clients may not.
  goat_ssh_browse: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const result = yield* dispatch.browse(input).pipe(Effect.mapError(toMcpFailure));
      return { ...result, worktrees: [...result.worktrees], entries: [...result.entries] };
    }),
  ),
  goat_ssh_thread_launch: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input, check) =>
      Effect.gen(function* () {
        const caller = yield* check;
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const permissions = yield* Profiles.PermissionProfiles;
        const laneId = yield* newCommandId();
        const effective = yield* permissions.require(scope, "threads.remote", {
          host: input.host,
          runtimeMode: caller.limits.runtimeMode,
        });
        const runtimeMode = yield* resolveRuntimeMode(effective.runtimeMode, input.runtimeMode);
        const role = input.goatclawRole;
        if (role !== undefined && !effective.enabled)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "goatclaw is off, so role launches are unavailable.",
          });
        const missing = role === undefined ? [] : missingRoleCapabilities(role, effective.profile);
        if (role !== undefined && missing.length > 0) return yield* roleRefusal(role, missing);
        if (role !== undefined && input.message === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A goatclaw role launch needs message: the task the role works on.",
          });
        const pressure = yield* admitLaunch(input.host);
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        // goatclaw applies fleet-wide: bring the destination's policy up to date before it must
        // enforce this ceiling. A host that cannot take it still refuses the launch clearly.
        if (effective.enabled) {
          const fleet = yield* Effect.serviceOption(FleetSync.GoatclawFleetSync);
          if (fleet._tag === "Some") yield* fleet.value.ensure(input.host);
        }
        // The thread on this machine that launches; an outside client has none to record.
        const launcher = caller.caller;
        const launchedBy =
          launcher === undefined
            ? undefined
            : yield* ServerEnvironment.ServerEnvironment.pipe(
                Effect.flatMap((environment) => environment.getDescriptor),
                Effect.map((descriptor) => ({
                  kind: "launch" as const,
                  threadId: launcher.id,
                  environmentId: descriptor.environmentId,
                  environmentLabel: descriptor.label,
                  threadTitle: launcher.title,
                  via: "ssh_thread_launch" as const,
                })),
              );
        const attachments = yield* dispatch
          .validateLaunchAttachments(input.attachments ?? [])
          .pipe(Effect.mapError(toMcpFailure));
        const coordinator = yield* RemoteDispatchCoordinator.RemoteDispatchCoordinator;
        const referenceMessage =
          input.references === undefined || input.references.length === 0
            ? input.message
            : yield* RepositoryReferenceMcpService.RepositoryReferenceMcpService.pipe(
                Effect.flatMap((references) =>
                  references.prepareBrief(caller.scope, {
                    message: input.message,
                    references: input.references!,
                    defaultHost: input.host,
                  }),
                ),
              );
        const launch: SshRemoteDispatch.SshLaunchInput = {
          host: input.host,
          cwd: input.cwd,
          workspace: sshLaunchWorkspace(input.workspace),
          title: input.title,
          message:
            role === undefined || referenceMessage === undefined
              ? referenceMessage
              : goatclawRoleBrief(role, referenceMessage),
          projectTitle: input.projectTitle,
          // The remote project usually has no default model, so a thread caller's own
          // model is the sensible default; an outside client must pass one.
          modelSelection: input.modelSelection ?? caller.caller?.modelSelection,
          runtimeMode,
          callerRuntimeMode: caller.limits.runtimeMode,
          ...(effective.enabled ? { permissionProfileCeiling: effective.profile } : {}),
          interactionMode: input.interactionMode,
          attachments,
          allowBroadWorkspaceRoot: input.allowBroadWorkspaceRoot,
          launchedBy,
          standingInstructions: input.standingInstructions,
        };
        // A webhook choice is checked, and an inline secret kept, before anything runs remotely.
        const launchWatches = yield* LaunchWatchService.LaunchWatchService;
        const repository = input.repository;
        const repositoryNotes =
          repository === undefined
            ? []
            : yield* RepositoryLaunchMcpService.RepositoryLaunchMcpService.pipe(
                Effect.flatMap((service) =>
                  service.check(scope, {
                    host: input.host,
                    path:
                      input.workspace?.type === "existing_worktree"
                        ? input.workspace.worktreePath
                        : input.cwd,
                    repository,
                  }),
                ),
              );
        // Set in the same uninterruptible step that saves the watch, which then holds the route.
        // Until then any exit, interruption included, frees the secret the route kept.
        let routeKept = false;
        return yield* Effect.acquireUseRelease(
          input.notifyTarget === undefined
            ? Effect.succeed({ notifyWebhook: input.notifyWebhook ?? false, webhookTarget: null })
            : launchWatches
                .resolveRoute({
                  notifyWebhook: input.notifyWebhook,
                  notifyOnCompletion: input.notifyOnCompletion,
                  notifyTarget: input.notifyTarget,
                  projectId: launcher?.projectId ?? null,
                })
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new OrchestratorMcpFailure({
                        code: "invalid_request",
                        message: error.message,
                      }),
                  ),
                ),
          (route) =>
            Effect.gen(function* () {
              const admitted = yield* permissions.claim(scope, {
                id: laneId,
                host: input.host,
                runtimeMode,
                worktree: input.workspace?.type === "worktree",
                ...(role === undefined ? {} : { role }),
              });
              const guardedLaunch = {
                ...launch,
                runtimeMode: admitted.runtimeMode,
                ...(admitted.enabled ? { permissionProfileCeiling: admitted.profile } : {}),
              };
              const authorize = check.pipe(
                Effect.andThen(permissions.recheck(scope, admitted, { host: input.host })),
              );
              const result = yield* Effect.gen(function* () {
                if (scope.thread === undefined) {
                  const value = yield* dispatch.launchThread(
                    guardedLaunch,
                    authorize.pipe(Effect.asVoid),
                  );
                  return { ...value, correlationId: null };
                }
                const value = yield* coordinator.launch(
                  {
                    kind: "thread",
                    originThreadId: scope.thread.threadId,
                    delivery: input.reportDelivery ?? "wake",
                    launch: guardedLaunch,
                  },
                  authorize.pipe(Effect.asVoid),
                );
                return { ...value.launch, correlationId: value.correlationId };
              }).pipe(
                Effect.tapError((error) => {
                  const underlying = isRemoteDispatchError(error) ? error.cause : error;
                  return admitted.enabled &&
                    underlying instanceof SshRemoteDispatch.SshRemoteDispatchError &&
                    (underlying.reason === "remote_refused" ||
                      underlying.reason === "invalid_request" ||
                      underlying.reason === "host_unknown") &&
                    underlying.launchMayHaveStarted !== true
                    ? permissions.release(laneId)
                    : Effect.void;
                }),
                Effect.mapError((error) =>
                  error instanceof SshRemoteDispatch.SshRemoteDispatchError
                    ? toMcpFailure(error)
                    : isRemoteDispatchError(error)
                      ? new OrchestratorMcpFailure({
                          code: "orchestration_error",
                          message: "SSH report coordination failed.",
                        })
                      : error,
                ),
              );
              if (admitted.enabled)
                yield* permissions.complete(
                  laneId,
                  result.threadId,
                  result.correlationId ?? undefined,
                );
              const runId = result.runId === null ? null : RunId.make(result.runId);
              const watching =
                input.notifyOnCompletion !== false && (launcher !== undefined || runId !== null)
                  ? yield* (
                      launcher !== undefined
                        ? launchWatches
                            .register({
                              launcherThreadId: launcher.id,
                              host: result.host,
                              threadId: ThreadId.make(result.threadId),
                              projectId: null,
                              title: input.title,
                              runId,
                              notifyWebhook: route.notifyWebhook,
                              webhookTarget: route.webhookTarget,
                            })
                            .pipe(
                              Effect.tap(() =>
                                Effect.sync(() => {
                                  routeKept = true;
                                }),
                              ),
                              Effect.as(true),
                              Effect.uninterruptible,
                            )
                        : runId === null
                          ? Effect.succeed(false)
                          : // An outside client's launch is watched only for the completion webhook.
                            launchWatches
                              .watchExternal({
                                owner: scope.requestNamespace,
                                host: result.host,
                                threadId: ThreadId.make(result.threadId),
                                projectId: null,
                                title: input.title,
                                runId,
                                ceiling: caller.limits.runtimeMode,
                                route,
                              })
                              .pipe(
                                Effect.map((watch) => {
                                  routeKept = watch !== null;
                                  return routeKept;
                                }),
                                Effect.uninterruptible,
                              )
                    ).pipe(
                      // The remote thread exists either way; a watch that failed to save is reported, not fatal.
                      Effect.catch((error) =>
                        Effect.logWarning("launch watch not recorded", {
                          host: result.host,
                          threadId: result.threadId,
                          cause: error,
                        }).pipe(Effect.as(false)),
                      ),
                    )
                  : false;
              return {
                ...result,
                watching,
                ...(pressure === undefined ? {} : { pressure }),
                notes: [
                  ...result.notes,
                  ...repositoryNotes,
                  ...(watching && launcher === undefined
                    ? [
                        `This machine follows the thread on ${result.host} and posts to its completion webhook when the run ends, waits on a question, or if ${result.host} stays unreachable.`,
                      ]
                    : watching
                      ? [
                          `This machine follows the thread on ${result.host} and wakes this thread when its run ends, when it waits on a question, or if ${result.host} stays unreachable; do not poll it. goat_thread_unwatch stops that.`,
                        ]
                      : scope.thread !== undefined
                        ? [
                            `${
                              input.notifyOnCompletion === false
                                ? "Run ends are not followed because completion notifications are disabled."
                                : "Run ends are not followed because no launch watch was recorded."
                            }${result.reportsSupported ? " Agent reports still arrive per reportDelivery." : ""}`,
                          ]
                        : []),
                ],
              };
            }),
          (route) =>
            routeKept || route.webhookTarget === null
              ? Effect.void
              : launchWatches.releaseRoute(route),
        );
      }),
    ),
  ),
  goat_ssh_thread_handoff: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input, check) =>
      Effect.gen(function* () {
        const caller = yield* check;
        const sourceThreadId = input.threadId ?? caller.caller?.id;
        if (sourceThreadId === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadId: this MCP client is not running inside a GOAT thread.",
          });
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        const hosts = yield* dispatch
          .listHosts({ probe: false })
          .pipe(Effect.mapError(toMcpFailure));
        const host = input.host.trim();
        if (!hosts.some((entry) => entry.alias === host))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `${host} is not in this machine's SSH config or known_hosts. Call goat_ssh_host_list for the hosts it can reach.`,
          });
        // Keep SSH-config routing, usernames and ports, like SshRemoteDispatch.resolveHost.
        const target = { alias: host, hostname: host, username: null, port: null };
        const current = yield* check;
        const callerContext = yield* Effect.context<
          | McpInvocationContext.McpInvocationContext
          | ThreadManagementService.ThreadManagementService
        >();
        const sync = yield* SshWorkspaceSync.SshWorkspaceSync;
        const result = yield* sync
          .handoffThread({
            sourceThreadId,
            target,
            expectedEnvironmentId: null,
            beforeRemoteChange: check.pipe(
              Effect.asVoid,
              Effect.provide(callerContext),
              Effect.mapError(
                () => new SshWorkspaceError({ stage: "validate", code: "caller_not_authorized" }),
              ),
            ),
            ...(sourceThreadId === current.caller?.id && current.caller.activeRunId !== null
              ? { allowRunId: current.caller.activeRunId }
              : {}),
            ...(input.message === undefined ? {} : { message: input.message }),
            ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
            ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
            ...(input.interactionMode === undefined
              ? {}
              : { interactionMode: input.interactionMode }),
          })
          .pipe(Effect.mapError(toHandoffFailure));
        return {
          host,
          operationId: result.operationId,
          remoteThreadId: result.remoteThreadId,
          remoteProjectId: result.remoteProjectId,
          remoteRepoPath: result.remoteRepoPath,
          branch: result.branch,
          notes: [
            `Read the remote thread with goat_thread_read({host:"${host}", threadId:"${result.remoteThreadId}"}).`,
            `Bring results back with Git actions → Fetch branch, using ${host}, ${result.remoteRepoPath} and branch ${result.branch}.`,
          ],
        };
      }),
    ),
  ),
  goat_ssh_reports: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const thread = yield* McpInvocationContext.requireThreadScope(scope, "goat_ssh_reports");
      const coordinator = yield* RemoteDispatchCoordinator.RemoteDispatchCoordinator;
      const records = yield* coordinator
        .listForOrigin(thread.thread.threadId, input.limit ?? 50)
        .pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Could not read SSH reports.",
              }),
          ),
        );
      return {
        dispatches: records.map(RemoteDispatchCoordinator.dispatchView),
      };
    }),
  ),
  goat_cloud_machine_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* requireOrchestration;
      const cloud = yield* CloudMachineService.CloudMachineService;
      return yield* cloud.list().pipe(Effect.mapError(toCloudFailure));
    }),
  ),
  goat_cloud_machine_create: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      yield* requireSettingsWrite;
      const cloud = yield* CloudMachineService.CloudMachineService;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      yield* Profiles.PermissionProfiles.pipe(
        Effect.flatMap((permissions) => permissions.require(scope, "boat.start")),
      );
      return yield* cloud.create(input).pipe(Effect.mapError(toCloudFailure));
    }),
  ),
  goat_cloud_machine_stop: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      yield* requireSettingsWrite;
      const cloud = yield* CloudMachineService.CloudMachineService;
      return yield* cloud.stop(input.alias).pipe(Effect.mapError(toCloudFailure));
    }),
  ),
  goat_cloud_machine_resume: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      yield* requireSettingsWrite;
      const cloud = yield* CloudMachineService.CloudMachineService;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      yield* Profiles.PermissionProfiles.pipe(
        Effect.flatMap((permissions) => permissions.require(scope, "boat.start")),
      );
      return yield* cloud.resume(input.alias).pipe(Effect.mapError(toCloudFailure));
    }),
  ),
});
