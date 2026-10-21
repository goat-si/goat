// @effect-diagnostics nodeBuiltinImport:off - hashes bounded replica bytes, never credentials.
import { PressureAdmissionService } from "../fleet/pressure/PressureAdmissionService.ts";
import { admitLaunch } from "./pressureAdmission.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeBuffer from "node:buffer";
import {
  CommandId,
  ProjectId,
  MessageId,
  OrchestratorMcpFailure,
  ThreadId,
  ServerSettingsError,
  type ThreadReplicaSettingInput,
  type ThreadReplicaReconcileInput,
  ThreadReplicaPayload,
  ThreadReplicaRestoreResult,
  THREAD_REPLICA_MAX_BYTES,
  THREAD_REPLICA_RETENTION_MS,
  type ThreadReplicaCaptureInput,
  type ThreadReplicaCaptureResult,
  ThreadReplicaRestoreInput,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@goat/contracts";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Launches from "../orchestration-v2/ThreadLaunchService.ts";
import { summarizeConversationForHandoff } from "../orchestration-v2/ContextHandoffService.ts";
import * as RepositoryIdentity from "../project/RepositoryIdentityResolver.ts";
import * as Providers from "../provider/ProviderInstanceRegistry.ts";
import { isCloudExecution } from "@goat/provider-core/server/cloudTask";
import * as ProcessRunner from "../processRunner.ts";
import { shellSingleQuote as quote } from "../sshRemote/remoteBrowse.ts";
import {
  captureReplicaScript,
  applyReplicaScript,
  parseReplicaOutput,
  parseApplyOutput,
  replicaRefFor,
  DEFAULT_MAX_UNTRACKED_FILE_BYTES,
} from "../channels/channelReplica.ts";

export interface ReplicaAuthority {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}
export type ReplicaAuthorization = Effect.Effect<ReplicaAuthority, OrchestratorMcpFailure>;

const refused = (reason: string) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `Checkpoint recovery refused: ${reason}.`,
  });
export const replicaDigest = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** A valid hash alone says nothing about repository identity or caller authority. */
export const validateReplica = (replica: ThreadReplicaPayload, now: number) => {
  if (replica.bundleBase64.length > Math.ceil(THREAD_REPLICA_MAX_BYTES / 3) * 4) return "oversized";
  const bytes = NodeBuffer.Buffer.from(replica.bundleBase64, "base64");
  if (bytes.length > THREAD_REPLICA_MAX_BYTES) return "oversized";
  if (
    bytes.length !== replica.bytes ||
    bytes.toString("base64") !== replica.bundleBase64 ||
    replicaDigest(bytes) !== replica.sha256 ||
    replicaDigest(replica.context) !== replica.contextSha256
  )
    return "corrupt";
  const capturedAt = Date.parse(replica.capturedAt);
  if (
    !Number.isFinite(capturedAt) ||
    capturedAt > now ||
    now - capturedAt >= THREAD_REPLICA_RETENTION_MS
  )
    return "stale";
  return null;
};

const encodeRestoreInput = Schema.encodeEffect(Schema.fromJsonString(ThreadReplicaRestoreInput));
export const replicaRestoreDigest = Effect.fn("replicaRestoreDigest")(function* (
  input: ThreadReplicaRestoreInput,
) {
  return replicaDigest(yield* encodeRestoreInput(input));
});
const isMcpFailure = Schema.is(OrchestratorMcpFailure);

const RestoreOperation = Schema.Struct({
  digest: Schema.String,
  phase: Schema.Literals(["reserved", "launch_unknown", "launched", "refused"]),
  projectId: Schema.NullOr(ProjectId),
  result: ThreadReplicaRestoreResult,
});

export class ThreadReplicaService extends Context.Service<
  ThreadReplicaService,
  {
    readonly configureHost: (
      input: ThreadReplicaSettingInput,
      authorize: ReplicaAuthorization,
    ) => Effect.Effect<ThreadReplicaSettingInput, OrchestratorMcpFailure>;
    readonly reconcile: (
      input: ThreadReplicaReconcileInput,
      authorize: ReplicaAuthorization,
    ) => Effect.Effect<ThreadReplicaRestoreResult, OrchestratorMcpFailure>;
    readonly capture: (
      input: ThreadReplicaCaptureInput,
      authorize: ReplicaAuthorization,
    ) => Effect.Effect<ThreadReplicaCaptureResult, OrchestratorMcpFailure>;
    readonly restore: (
      input: ThreadReplicaRestoreInput,
      authorize: ReplicaAuthorization,
    ) => Effect.Effect<ThreadReplicaRestoreResult, OrchestratorMcpFailure>;
  }
>()("goat/mcp/ThreadReplicaService") {}

/** Recovery has no profile-ceiling transfer or lane accounting yet. */
export const assertCheckpointProfilesDisabled = (
  settings: ServerSettings.ServerSettingsService["Service"],
) =>
  settings.getSettings.pipe(
    Effect.mapError(() => refused("settings_unavailable")),
    Effect.flatMap((current) =>
      current.goatclaw.enabled
        ? Effect.fail(refused("permission_profiles_not_supported"))
        : Effect.void,
    ),
  );

const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectStoreV2;
  const launches = yield* Launches.ThreadLaunchService;
  const repositories = yield* RepositoryIdentity.RepositoryIdentityResolver;
  const providers = yield* Providers.ProviderInstanceRegistry;
  const runner = yield* ProcessRunner.ProcessRunner;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const pressure = yield* Effect.serviceOption(PressureAdmissionService);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "thread-recovery");
  const encodeOperation = Schema.encodeEffect(Schema.fromJsonString(RestoreOperation));
  const decodeOperation = Schema.decodeUnknownEffect(Schema.fromJsonString(RestoreOperation));

  const allowed = Effect.fn("ThreadReplicaService.allowed")(function* (
    authorize: ReplicaAuthorization,
  ) {
    const caller = yield* authorize;
    yield* assertCheckpointProfilesDisabled(settings);
    // Filesystem export/import cannot be represented by an approval-required remote session.
    if (caller.runtimeMode !== "full-access" || caller.interactionMode !== "default")
      return yield* refused("full_access_default_required");
    return caller;
  });

  const script = Effect.fn("ThreadReplicaService.script")(function* (text: string) {
    const result = yield* runner
      .run({
        command: "sh",
        args: ["-s"],
        stdin: text,
        timeout: "120 seconds",
        maxOutputBytes: THREAD_REPLICA_MAX_BYTES * 2,
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_COMMON_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_OBJECT_DIRECTORY: undefined,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
          GIT_TERMINAL_PROMPT: "0",
        },
      })
      .pipe(Effect.mapError(() => refused("git_operation_failed")));
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated)
      return yield* refused("git_operation_failed");
    return result.stdout;
  });

  const capture = Effect.fn("ThreadReplicaService.capture")(function* (
    input: ThreadReplicaCaptureInput,
    authorize: ReplicaAuthorization,
  ): Effect.fn.Return<ThreadReplicaCaptureResult, OrchestratorMcpFailure> {
    yield* allowed(authorize);
    const records = yield* threads
      .getThreadRecords(input.threadId, ["runs", "checkpoints", "turnItems"], {
        runIds: [input.runId],
        turnItemRunId: input.runId,
        turnItemTypes: ["checkpoint"],
      })
      .pipe(Effect.mapError(() => refused("thread_missing")));
    const run = records.runs.find((r) => r.id === input.runId);
    const checkpoint = records.checkpoints.find(
      (c) => c.id === run?.checkpointId && c.runId === input.runId && c.status === "ready",
    );
    const anchor = records.turnItems.find(
      (item) => item.type === "checkpoint" && item.checkpointId === checkpoint?.id,
    );
    if (run?.status !== "completed" || checkpoint === undefined || anchor === undefined)
      return { status: "skipped", reason: "checkpoint_not_ready" };
    if (checkpoint.replicationEvidence?.complete !== true)
      return { status: "skipped", reason: "incomplete_checkpoint" };
    const projection = yield* threads
      .getThreadSnapshotWindow(input.threadId, {
        rowLimit: 200,
        anchorItemId: anchor.id,
        requiredRunId: input.runId,
      })
      .pipe(
        Effect.map((snapshot) => snapshot.projection),
        Effect.mapError(() => refused("thread_missing")),
      );
    const thread = projection.thread;
    if (thread.deletedAt !== null || thread.archivedAt !== null)
      return yield* refused("thread_unavailable");
    yield* allowed(authorize);
    const project = yield* projects
      .get(thread.projectId)
      .pipe(Effect.mapError(() => refused("project_missing")));
    if (Option.isNone(project)) return yield* refused("project_missing");
    const cwd = thread.worktreePath ?? project.value.workspaceRoot;
    const identity = yield* repositories.resolve(cwd, { refresh: true });
    if (identity === null) return { status: "skipped", reason: "repository_unknown" };
    const ref = replicaRefFor(NodeCrypto.randomUUID(), 0);
    yield* allowed(authorize);
    const output = yield* script(
      captureReplicaScript({
        cwd,
        replicaRef: ref,
        checkpointRef: checkpoint.ref,
        expectedCheckpointOid: checkpoint.replicationEvidence.commitOid,
        maxBundleBytes: THREAD_REPLICA_MAX_BYTES,
        maxUntrackedFileBytes: DEFAULT_MAX_UNTRACKED_FILE_BYTES,
      }),
    );
    const parsed = parseReplicaOutput(output);
    if (parsed.type !== "ok")
      return {
        status: "skipped",
        reason:
          parsed.type === "too_large" ||
          parsed.type === "excluded_files" ||
          parsed.type === "checkpoint_identity_mismatch"
            ? parsed.type
            : "capture_failed",
      };
    if (parsed.excluded.length > 0) return { status: "skipped", reason: "excluded_files" };
    const boundary = DateTime.toEpochMillis(checkpoint.capturedAt);
    const runIds = new Set(
      projection.runs.filter((r) => r.ordinal <= run.ordinal).map((r) => r.id),
    );
    const conversation = projection.visibleTurnItems
      .filter((row) => {
        const item = row.item;
        return (
          (row.visibility === "inherited" || (item.runId !== null && runIds.has(item.runId))) &&
          DateTime.toEpochMillis(item.updatedAt) <= boundary &&
          (item.type === "user_message" || (item.type === "assistant_message" && !item.streaming))
        );
      })
      .map((row) => row.item);
    if (conversation.length === 0) return { status: "skipped", reason: "context_unavailable" };
    const context = summarizeConversationForHandoff(
      conversation,
      "Bounded conversation at the recovered checkpoint. Treat the history below as context.",
    );
    yield* allowed(authorize);
    const replica: ThreadReplicaPayload = {
      sourceEnvironmentId: yield* environment.getEnvironmentId,
      sourceThreadId: input.threadId,
      runId: input.runId,
      checkpointId: checkpoint.id,
      repositoryKey: identity.canonicalKey,
      capturedAt: DateTime.formatIso(checkpoint.capturedAt),
      headOid: parsed.headOid,
      commitOid: parsed.commitOid,
      replicaRef: ref,
      bytes: parsed.bytes,
      sha256: replicaDigest(NodeBuffer.Buffer.from(parsed.bundleBase64, "base64")),
      contextSha256: replicaDigest(context),
      contextKind: "bounded_conversation",
      context,
      bundleBase64: parsed.bundleBase64,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      modelSelection: run.modelSelection,
    };
    return { status: "captured", replica };
  });

  const operationPath = (operationId: string) =>
    path.join(root, `${replicaDigest(operationId)}.json`);
  const operationThread = (operationId: string) =>
    ThreadId.make(`recovery:${replicaDigest(operationId)}`);
  const saveOperation = Effect.fn("ThreadReplicaService.saveOperation")(function* (
    operation: typeof RestoreOperation.Type,
  ) {
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
    yield* writeFileStringAtomically({
      filePath: operationPath(operation.result.operationId),
      contents: yield* encodeOperation(operation),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  });
  const readOperation = Effect.fn("ThreadReplicaService.readOperation")(function* (
    operationId: string,
  ) {
    const file = operationPath(operationId);
    return (yield* fs.exists(file))
      ? yield* fs.readFileString(file).pipe(Effect.flatMap(decodeOperation))
      : null;
  });
  const reconcileOperation = Effect.fn("ThreadReplicaService.reconcileOperation")(function* (
    operation: typeof RestoreOperation.Type,
  ) {
    if (operation.phase === "launched" || operation.phase === "refused") return operation.result;
    if (operation.phase === "reserved") {
      const stopped: typeof RestoreOperation.Type = {
        ...operation,
        phase: "refused",
        result: { ...operation.result, status: "refused", reason: "launch_not_started" },
      };
      // A delayed launch request with this ID will now observe the terminal refusal.
      yield* saveOperation(stopped);
      return stopped.result;
    }
    const threadId = operation.result.threadId;
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(() => refused("reconciliation_failed")));
    if (shell !== null) {
      const records = yield* threads
        .getThreadRecords(threadId, ["runs"])
        .pipe(Effect.mapError(() => refused("reconciliation_failed")));
      const messageId = MessageId.make(
        `recovery:${replicaDigest(operation.result.operationId)}:message`,
      );
      const run = records.runs.find((r) => r.userMessageId === messageId);
      if (
        run !== undefined &&
        shell.projectId === operation.projectId &&
        shell.worktreePath ===
          path.join(root, "worktrees", replicaDigest(operation.result.operationId))
      ) {
        const complete: typeof RestoreOperation.Type = {
          ...operation,
          phase: "launched",
          result: { ...operation.result, status: "launched", runId: run.id },
        };
        yield* saveOperation(complete);
        return complete.result;
      }
    }
    return operation.result;
  });

  const reconcile = Effect.fn("ThreadReplicaService.reconcile")(function* (
    input: ThreadReplicaReconcileInput,
    authorize: ReplicaAuthorization,
  ) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* allowed(authorize);
          const operation = yield* readOperation(input.operationId);
          if (operation === null) {
            const stopped: typeof RestoreOperation.Type = {
              digest: input.requestDigest,
              projectId: null,
              phase: "refused",
              result: {
                operationId: input.operationId,
                status: "refused",
                threadId: operationThread(input.operationId),
                runId: null,
                reason: "launch_not_started",
              },
            };
            yield* saveOperation(stopped);
            return stopped.result;
          }
          if (operation.digest !== input.requestDigest) return yield* refused("operation_conflict");
          return yield* reconcileOperation(operation);
        }),
      )
      .pipe(Effect.mapError((cause) => (isMcpFailure(cause) ? cause : refused("storage_failed"))));
  });

  const restore = Effect.fn("ThreadReplicaService.restore")(function* (
    input: ThreadReplicaRestoreInput,
    authorize: ReplicaAuthorization,
  ) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* allowed(authorize);
          const key = replicaDigest(input.operationId);
          const digest = yield* replicaRestoreDigest(input);
          const existing = yield* readOperation(input.operationId);
          if (existing !== null) {
            if (existing.digest !== digest) return yield* refused("operation_conflict");
            return yield* reconcileOperation(existing);
          }
          if (pressure._tag === "Some")
            yield* admitLaunch(null).pipe(
              Effect.provideService(PressureAdmissionService, pressure.value),
            );
          const worktreePath = path.join(root, "worktrees", key);
          const branch = `goat/recovery/${key}`;
          const threadId = operationThread(input.operationId);
          const messageId = MessageId.make(`recovery:${key}:message`);
          let operation: typeof RestoreOperation.Type = {
            digest,
            projectId: input.projectId,
            phase: "reserved",
            result: {
              operationId: input.operationId,
              status: "launch_unknown",
              threadId,
              runId: null,
            },
          };
          yield* saveOperation(operation);
          const prepared = yield* Effect.gen(function* () {
            const model = input.modelSelection ?? input.replica.modelSelection;
            const provider = yield* providers.getInstance(model.instanceId);
            if (provider === undefined || !provider.enabled)
              return yield* refused("provider_unavailable");
            const readiness = yield* provider.snapshot.getSnapshot;
            if (
              !readiness.installed ||
              !readiness.enabled ||
              readiness.availability === "unavailable" ||
              readiness.status === "error" ||
              readiness.status === "disabled" ||
              readiness.auth.status === "unauthenticated"
            )
              return yield* refused("provider_not_ready");
            const capabilities = yield* provider.orchestrationAdapter
              .getCapabilities()
              .pipe(Effect.mapError(() => refused("provider_unavailable")));
            if (isCloudExecution(capabilities))
              return yield* refused("cloud_destination_cannot_restore_worktree");
            const invalid = validateReplica(input.replica, yield* Clock.currentTimeMillis);
            if (invalid !== null) return yield* refused(invalid);
            const project = yield* projects
              .get(input.projectId)
              .pipe(Effect.mapError(() => refused("project_missing")));
            if (Option.isNone(project)) return yield* refused("project_missing");
            const cwd = project.value.workspaceRoot;
            const identity = yield* repositories.resolve(cwd, { refresh: true });
            if (identity === null || identity.canonicalKey !== input.replica.repositoryKey)
              return yield* refused("repository_mismatch");
            yield* allowed(authorize);
            const applied = parseApplyOutput(
              yield* script(
                applyReplicaScript({
                  cwd,
                  replicaRef: input.replica.replicaRef,
                  targetRef: `refs/heads/goat/recovery-snapshots/${key}`,
                  bundleBase64: input.replica.bundleBase64,
                  fetchRemotes: false,
                  expectedCommitOid: input.replica.commitOid,
                  expectedHeadOid: input.replica.headOid,
                }),
              ),
            );
            if (applied.type !== "applied" || applied.oid !== input.replica.commitOid)
              return yield* refused(
                applied.type === "base_missing" ? "base_missing" : "bundle_identity_mismatch",
              );
            yield* fs.makeDirectory(path.dirname(worktreePath), { recursive: true });
            // Only this operation's private worktree is reset; captured changes remain uncommitted.
            yield* script(
              `set -eu\ncd ${quote(cwd)}\nif [ ! -d ${quote(worktreePath)} ]; then git -c core.hooksPath=/dev/null worktree add --quiet -b ${quote(branch)} ${quote(worktreePath)} ${quote(`refs/heads/goat/recovery-snapshots/${key}`)}; fi\ncd ${quote(worktreePath)}\n[ "$(git rev-parse HEAD)" = ${quote(input.replica.commitOid)} ]\ngit -c core.hooksPath=/dev/null reset --mixed ${quote(input.replica.headOid)} >/dev/null\n`,
            );
            yield* allowed(authorize);
          }).pipe(Effect.result);
          if (prepared._tag === "Failure") {
            operation = {
              ...operation,
              phase: "refused",
              result: {
                ...operation.result,
                status: "refused",
                reason: isMcpFailure(prepared.failure)
                  ? prepared.failure.message
                  : "preparation_failed",
              },
            };
            yield* saveOperation(operation);
            return operation.result;
          }
          operation = { ...operation, phase: "launch_unknown" };
          yield* saveOperation(operation);
          const launchAuthority = yield* allowed(authorize).pipe(Effect.result);
          if (launchAuthority._tag === "Failure") {
            operation = {
              ...operation,
              phase: "refused",
              result: { ...operation.result, status: "refused", reason: "authorization_changed" },
            };
            yield* saveOperation(operation);
            return operation.result;
          }
          const launched = yield* launches
            .launch({
              commandId: CommandId.make(`recovery:${key}`),
              threadId,
              projectId: input.projectId,
              title: "Recovered checkpoint",
              modelSelection: input.modelSelection ?? input.replica.modelSelection,
              runtimeMode: input.replica.runtimeMode,
              interactionMode: input.replica.interactionMode,
              workspaceStrategy: { type: "existing_worktree", branch, worktreePath },
              initialMessage: {
                messageId,
                text: `${input.replica.context}\n\nContinue from this checkpoint. The disconnected source may still be running; avoid repeating external side effects without checking.`,
                attachments: [],
                memoryGrantCeiling: "none",
              },
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.result);
          if (launched._tag === "Failure") return operation.result;
          const run = launched.success.projection.runs.find((r) => r.userMessageId === messageId);
          if (run === undefined) return operation.result;
          operation = {
            ...operation,
            phase: "launched",
            result: { ...operation.result, status: "launched", runId: run.id },
          };
          yield* saveOperation(operation);
          return operation.result;
        }),
      )
      .pipe(Effect.mapError((cause) => (isMcpFailure(cause) ? cause : refused("storage_failed"))));
  });
  const configureHost = Effect.fn("ThreadReplicaService.configureHost")(function* (
    input: ThreadReplicaSettingInput,
    authorize: ReplicaAuthorization,
  ) {
    yield* allowed(authorize);
    yield* settings
      .updateSettingsWith(
        (current) =>
          Effect.succeed({
            fleet: {
              hosts: {
                ...current.fleet.hosts,
                [input.host]: {
                  ...current.fleet.hosts?.[input.host],
                  checkpointReplication: input.checkpointReplication,
                },
              },
            },
          }),
        allowed(authorize).pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new ServerSettingsError({
                settingsPath: "checkpointReplication",
                operation: "normalize",
              }),
          ),
        ),
      )
      .pipe(Effect.mapError(() => refused("settings_update_denied")));
    return input;
  });
  return ThreadReplicaService.of({ capture, restore, reconcile, configureHost });
});

export const layer = Layer.effect(ThreadReplicaService, make);
