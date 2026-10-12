import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import { OrchestratorMcpFailure, RunId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { resolveRuntimeMode } from "../../OrchestratorMcpService.ts";
import { SshToolkit } from "./tools.ts";

const isRemoteDispatchError = Schema.is(RemoteDispatchCoordinator.RemoteDispatchError);

const toMcpFailure = (error: SshRemoteDispatch.SshRemoteDispatchError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "invalid_request" || error.reason === "host_unknown"
        ? "invalid_request"
        : "orchestration_error",
    message: Array.from(error.message).slice(0, 2000).join(""),
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

export const layer = McpToolAccess.toLayer(SshToolkit, {
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
  // Browsing changes nothing remote, but it runs commands there with this
  // machine's SSH keys, so read-only clients may not.
  goat_ssh_browse: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const result = yield* dispatch.browse(input).pipe(Effect.mapError(toMcpFailure));
      return { ...result, worktrees: [...result.worktrees], entries: [...result.entries] };
    }),
  ),
  goat_ssh_thread_launch: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const caller = yield* check;
      const runtimeMode = yield* resolveRuntimeMode(caller.limits.runtimeMode, input.runtimeMode);
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
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
      const launch: SshRemoteDispatch.SshLaunchInput = {
        host: input.host,
        cwd: input.cwd,
        workspace: input.workspace ?? { type: "cwd" },
        title: input.title,
        message: input.message,
        projectTitle: input.projectTitle,
        // The remote project usually has no default model, so a thread caller's own
        // model is the sensible default; an outside client must pass one.
        modelSelection: input.modelSelection ?? caller.caller?.modelSelection,
        runtimeMode,
        callerRuntimeMode: caller.limits.runtimeMode,
        interactionMode: input.interactionMode,
        attachments,
        allowBroadWorkspaceRoot: input.allowBroadWorkspaceRoot,
        launchedBy,
        standingInstructions: input.standingInstructions,
      };
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const result = yield* Effect.gen(function* () {
        if (scope.thread === undefined) {
          const value = yield* dispatch.launchThread(launch, check.pipe(Effect.asVoid));
          return { ...value, correlationId: null };
        }
        const value = yield* coordinator.launch(
          {
            kind: "thread",
            originThreadId: scope.thread.threadId,
            delivery: input.reportDelivery ?? "wake",
            launch,
          },
          check.pipe(Effect.asVoid),
        );
        return { ...value.launch, correlationId: value.correlationId };
      }).pipe(
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
      const watching =
        launcher !== undefined && input.notifyOnCompletion !== false
          ? yield* LaunchWatchService.LaunchWatchService.pipe(
              Effect.flatMap((watches) =>
                watches.register({
                  launcherThreadId: launcher.id,
                  host: result.host,
                  threadId: ThreadId.make(result.threadId),
                  projectId: null,
                  title: input.title,
                  runId: result.runId === null ? null : RunId.make(result.runId),
                  notifyWebhook: input.notifyWebhook ?? false,
                }),
              ),
              Effect.as(true),
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
        notes: [
          ...result.notes,
          ...(watching
            ? [
                `This machine follows the thread over SSH and wakes this thread when its run ends, when it waits on a question, or if ${result.host} stays unreachable; do not poll it. goat_thread_unwatch stops that.`,
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
});
