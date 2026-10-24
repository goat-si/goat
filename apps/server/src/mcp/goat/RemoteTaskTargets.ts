import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import {
  ModelSelection,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpFailure,
  type OrchestratorMcpTarget,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadStatusResult,
  type ProjectId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RunId,
  ThreadId,
} from "@goat/contracts";
import { isCloudExecution } from "@goat/provider-core/server/cloudTask";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as CloudSource from "../../orchestration-v2/CloudTaskSourceService.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import { cloudTaskView } from "../cloudTaskView.ts";
import { hostFailure } from "../hostFailure.ts";
import { overrideOptionSelections } from "../modelOptionOverrides.ts";
import { readAdvertisedModel } from "../OrchestratorMcpCapabilities.ts";

import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { type McpInvocationScope, type McpThreadInvocationScope } from "../McpInvocationContext.ts";

/**
 * The service closures that remote and cloud delegation need. OrchestratorMcpService passes
 * them in so this module never imports the service at runtime.
 */
export interface RemoteTaskTargetDeps {
  readonly permissions: Profiles.PermissionProfiles["Service"];
  readonly projects: ProjectService.ProjectService["Service"];
  readonly providerAdapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"];
  readonly ssh: SshRemoteDispatch.SshRemoteDispatch["Service"];
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly cloudSources: Option.Option<CloudSource.CloudTaskSourceService["Service"]>;
  readonly requireCapability: (
    scope: McpInvocationScope,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly failure: (
    code: OrchestratorMcpFailure["code"],
    message: string,
  ) => OrchestratorMcpFailure;
  readonly threadManagementFailure: (error: unknown) => OrchestratorMcpFailure;
  readonly advertisedOptionDescriptors: (
    options: OrchestratorMcpCapabilitiesResult["providers"][number]["models"][number]["options"] & {},
  ) => ReadonlyArray<ProviderOptionDescriptor>;
  readonly invalidOptionSelections: (
    selections: ReadonlyArray<ProviderOptionSelection>,
    descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
  ) => ReadonlyArray<string>;
}

/** Authorizing, preflighting and resolving delegated tasks that run on another host or in the cloud. */
export const makeRemoteTaskTargets = (deps: RemoteTaskTargetDeps) => {
  const {
    permissions,
    projects,
    providerAdapters,
    ssh,
    threadManagement,
    cloudSources,
    requireCapability,
    failure,
    threadManagementFailure,
    advertisedOptionDescriptors,
    invalidOptionSelections,
  } = deps;

  const authorizeRemoteWrite = Effect.fnUntraced(function* (
    scope: McpThreadInvocationScope,
    expectedRunId?: RunId,
  ) {
    yield* requireCapability(scope);
    if (scope.client?.access === "read-only")
      return yield* failure(
        "capability_denied",
        "A read-only MCP client cannot reach another machine.",
      );
    const caller = yield* threadManagement
      .getThreadShell(scope.thread.threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (caller === null || caller.deletedAt !== null)
      return yield* failure("thread_not_found", "The calling thread was not found.");
    if (
      caller.archivedAt !== null ||
      caller.activeRunId === null ||
      caller.providerInstanceId !== scope.thread.providerInstanceId
    )
      return yield* failure(
        "parent_not_active",
        "The calling provider no longer owns an active thread run.",
      );
    if (caller.runtimeMode !== "full-access" || caller.interactionMode !== "default")
      return yield* failure(
        "capability_denied",
        "SSH delegation needs a full-access/default caller.",
      );
    if (expectedRunId !== undefined && caller.activeRunId !== expectedRunId)
      return yield* failure(
        "parent_not_active",
        "The spawning parent run changed before remote launch.",
      );
    return caller.runtimeMode;
  });
  const preflightCloudLaunch = Effect.fnUntraced(function* (
    scope: McpInvocationScope,
    projectId: ProjectId,
    modelSelection: ModelSelection,
    worktreePath: string | null,
    branch: string | null,
  ) {
    const adapter = yield* providerAdapters
      .get(modelSelection.instanceId)
      .pipe(
        Effect.mapError(() =>
          failure("provider_unavailable", "The selected provider is unavailable."),
        ),
      );
    const capabilities = yield* adapter
      .getCapabilities()
      .pipe(
        Effect.mapError(() =>
          failure("provider_unavailable", "Provider capabilities are unavailable."),
        ),
      );
    if (!isCloudExecution(capabilities)) return;
    yield* permissions.requireCloudApproval(
      scope,
      yield* permissions.require(scope, "cloud.launch"),
      { target: `delegate:${modelSelection.instanceId}` },
    );
    if (Option.isNone(cloudSources))
      return yield* failure("orchestration_error", "Cloud source preflight is unavailable.");
    const project = Option.getOrUndefined(
      yield* projects
        .getById(projectId)
        .pipe(Effect.mapError(() => failure("orchestration_error", "Unable to read the project."))),
    );
    if (project === undefined)
      return yield* failure("invalid_request", "The project was not found.");
    yield* cloudSources.value
      .resolve({
        cwd:
          capabilities.sessions.sourceRestriction === "project-folder"
            ? project.workspaceRoot
            : (worktreePath ?? project.workspaceRoot),
        restriction: capabilities.sessions.sourceRestriction ?? "published-ref",
        ...(branch === null ? {} : { branch }),
      })
      .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
  });

  const ensureCloudCancellationSupported = Effect.fnUntraced(function* (
    projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerThreads">,
    code: "task_not_cancellable" | "invalid_request",
    runId?: RunId,
  ) {
    const run =
      runId === undefined
        ? (ThreadManagementService.latestActiveRun(projection) ??
          ThreadManagementService.latestRun(projection))
        : projection.runs.find((candidate) => candidate.id === runId);
    const thread = projection.providerThreads.find(
      (candidate) => candidate.id === run?.providerThreadId,
    );
    if (thread?.cloudTask?.status !== "running" && thread?.cloudTask?.status !== "submitting")
      return;
    const adapter = yield* providerAdapters
      .get(thread.providerInstanceId)
      .pipe(
        Effect.mapError(() =>
          failure(
            "provider_unavailable",
            "Cloud tracking is unavailable; remote work may continue.",
          ),
        ),
      );
    const capabilities = yield* adapter
      .getCapabilities()
      .pipe(
        Effect.mapError(() =>
          failure(
            "provider_unavailable",
            "Cloud capabilities are unavailable; remote work may continue.",
          ),
        ),
      );
    if (!capabilities.turns.supportsInterrupt)
      return yield* failure(
        code,
        `Cloud cancellation is not supported by ${thread.providerInstanceId}. Remote work may continue.`,
      );
  });

  const decodeRemoteThreadStatus = Schema.decodeUnknownEffect(OrchestratorMcpThreadStatusResult);
  const decodeRemoteThreadRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
  const readRemoteCloudTask = (
    scope: McpThreadInvocationScope,
    host: string,
    threadId: ThreadId,
  ) => {
    const read = (tool: string, args: Readonly<Record<string, unknown>>) =>
      ssh
        .callHostTool(
          {
            host,
            tool,
            arguments: args,
            writes: false,
            timeoutMs: 120_000,
          },
          authorizeRemoteWrite(scope),
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof SshRemoteDispatch.SshRemoteDispatchError ? hostFailure(error) : error,
          ),
        );
    const decodeFailure = () =>
      failure("orchestration_error", "Remote cloud task metadata is invalid.");
    return read("goat_thread_status", { threadId }).pipe(
      Effect.flatMap((value) =>
        decodeRemoteThreadStatus(value).pipe(Effect.mapError(decodeFailure)),
      ),
      Effect.map((status) => cloudTaskView(status.cloudTask)),
      Effect.catchIf(
        (error) => error.message.includes(SshRemoteDispatch.REMOTE_THREAD_STATUS_UNSUPPORTED),
        () =>
          read("goat_thread_read", { threadId, limit: 1, runLimit: 2 }).pipe(
            Effect.flatMap((value) =>
              decodeRemoteThreadRead(value).pipe(Effect.mapError(decodeFailure)),
            ),
            Effect.map((result) => cloudTaskView(result.cloudTask)),
          ),
      ),
    );
  };

  const decodeRemoteCapabilities = Schema.decodeUnknownEffect(OrchestratorMcpCapabilitiesResult);
  const resolveRemoteTarget = Effect.fn("orchestratorMcp.resolveRemoteTarget")(function* (
    scope: McpThreadInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
    target: OrchestratorMcpTarget & { readonly host: string },
  ) {
    const catalog = yield* ssh
      .callHostTool(
        {
          host: target.host,
          tool: "orchestrator_capabilities",
          arguments: {},
          writes: false,
          timeoutMs: 120_000,
        },
        authorizeRemoteWrite(scope),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof SshRemoteDispatch.SshRemoteDispatchError ? hostFailure(error) : error,
        ),
        Effect.flatMap((value) =>
          decodeRemoteCapabilities(value).pipe(
            Effect.mapError(() =>
              failure("orchestration_error", "Remote capability response is invalid."),
            ),
          ),
        ),
      );
    const inherited = parent.thread.modelSelection;
    const candidates = catalog.providers.filter((provider) => provider.canRunChildTask);
    const instanceId =
      target.providerInstanceId ??
      (target.driverKind === undefined
        ? inherited.instanceId
        : (candidates.find(
            (provider) =>
              provider.driverKind === target.driverKind &&
              provider.providerInstanceId === inherited.instanceId,
          )?.providerInstanceId ??
          candidates.find((provider) => provider.driverKind === target.driverKind)
            ?.providerInstanceId));
    const provider = candidates.find((row) => row.providerInstanceId === instanceId);
    if (provider === undefined)
      return yield* failure(
        "provider_unavailable",
        "The selected provider is unavailable on this host.",
      );
    if (target.driverKind !== undefined && target.driverKind !== provider.driverKind)
      return yield* failure("invalid_request", "Remote provider and driver do not match.");
    const model =
      target.model ??
      (instanceId === inherited.instanceId ? inherited.model : provider.models[0]?.id);
    // The untargeted listing truncates, so a missing row is not conclusive: re-ask for the
    // exact model before refusing. A model defaulted from provider.models[0] cannot be absent.
    let advertised = provider.models.find((row) => row.id === model);
    if (advertised === undefined && model !== undefined) {
      const probed = yield* readAdvertisedModel(ssh, authorizeRemoteWrite(scope), {
        host: target.host,
        providerInstanceId: provider.providerInstanceId,
        model,
      });
      if (Option.isSome(probed)) advertised = probed.value;
    }
    if (advertised === undefined)
      return yield* failure(
        "model_unavailable",
        "The selected model is not advertised on this host.",
      );
    const options = overrideOptionSelections(
      instanceId === inherited.instanceId && model === inherited.model
        ? inherited.options
        : undefined,
      target.options,
    );
    const descriptors = advertisedOptionDescriptors(advertised.options ?? []);
    // The merge folds repeated ids together, so the request is checked on its own too.
    const invalid = [
      ...new Set([
        ...(target.options === undefined
          ? []
          : invalidOptionSelections(target.options, descriptors)),
        ...(options === undefined ? [] : invalidOptionSelections(options, descriptors)),
      ]),
    ];
    if (invalid.length > 0) return yield* failure("invalid_request", invalid.join(" "));
    const modelSelection: ModelSelection = {
      instanceId: provider.providerInstanceId,
      model: advertised.id,
      ...(options === undefined ? {} : { options }),
    };
    return { modelSelection, driver: provider.driverKind };
  });

  return {
    authorizeRemoteWrite,
    preflightCloudLaunch,
    ensureCloudCancellationSupported,
    readRemoteCloudTask,
    resolveRemoteTarget,
  };
};
