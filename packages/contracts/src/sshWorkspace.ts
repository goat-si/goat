import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DesktopSshEnvironmentTargetSchema } from "./ipc.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const SshWorkspaceDestination = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  expectedEnvironmentId: EnvironmentId,
  target: DesktopSshEnvironmentTargetSchema,
});
export type SshWorkspaceDestination = typeof SshWorkspaceDestination.Type;

export const SshWorkspaceLaunchInput = Schema.Struct({
  sourceProjectId: ProjectId,
  /** Continue this existing thread on the destination SSH host. */
  sourceThreadId: Schema.optional(ThreadId),
  destination: SshWorkspaceDestination,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  initialMessage: Schema.Struct({ text: Schema.String }),
});
export type SshWorkspaceLaunchInput = typeof SshWorkspaceLaunchInput.Type;

export const SshWorkspaceLaunchResult = Schema.Struct({
  operationId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}$/u)),
  snapshotRef: TrimmedNonEmptyString,
  snapshotOid: TrimmedNonEmptyString,
  remoteEnvironmentId: EnvironmentId,
  remoteProjectId: ProjectId,
  remoteThreadId: ThreadId,
  remoteRepoPath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type SshWorkspaceLaunchResult = typeof SshWorkspaceLaunchResult.Type;

export const SshWorkspaceFetchBackInput = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  remoteWorkspaceRoot: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type SshWorkspaceFetchBackInput = typeof SshWorkspaceFetchBackInput.Type;

export const SshWorkspaceFetchBackResult = Schema.Struct({
  sourceProjectId: ProjectId,
  localWorkspaceRoot: TrimmedNonEmptyString,
  localRef: TrimmedNonEmptyString,
  commitOid: TrimmedNonEmptyString,
  remoteBranch: TrimmedNonEmptyString,
});
export type SshWorkspaceFetchBackResult = typeof SshWorkspaceFetchBackResult.Type;

export const SshWorkspaceStage = Schema.Literals([
  "validate",
  "preflight",
  "snapshot",
  "remote_init",
  "push",
  "launch",
  "fetch",
]);
export type SshWorkspaceStage = typeof SshWorkspaceStage.Type;
export const SshWorkspaceCode = Schema.Literals([
  "invalid_target",
  "project_not_found",
  "thread_not_found",
  "thread_project_mismatch",
  "thread_busy",
  "caller_not_authorized",
  "thread_worktree_invalid",
  "not_git_repository",
  "project_not_repo_root",
  "project_read_failed",
  "host_unavailable",
  "remote_unsupported",
  "model_unavailable",
  "environment_mismatch",
  "invalid_remote_response",
  "snapshot_failed",
  "unsupported_snapshot",
  "head_changed",
  "secret_candidate",
  "foreign_path",
  "remote_init_failed",
  "push_failed",
  "push_ref_conflict",
  "push_oid_mismatch",
  "launch_refused",
  "launch_uncertain",
  "invalid_branch",
  "source_not_found",
  "source_ambiguous",
  "fetch_failed",
]);
export type SshWorkspaceCode = typeof SshWorkspaceCode.Type;

export class SshWorkspaceError extends Schema.TaggedError<SshWorkspaceError>()(
  "SshWorkspaceError",
  {
    stage: SshWorkspaceStage,
    code: SshWorkspaceCode,
    host: Schema.optional(Schema.String),
    operationId: Schema.optional(Schema.String),
    fileNames: Schema.optional(Schema.Array(Schema.String)),
  },
) {
  override get message(): string {
    if (this.code === "caller_not_authorized")
      return "The caller is no longer authorized to hand off this thread. Check its active run and access modes before trying again.";
    if (this.code === "project_not_repo_root")
      return "Add the repository root as the project before sending this workspace over SSH.";
    if (this.code === "secret_candidate")
      return "Early warning: untracked credential-like files were found; review them before sending.";
    if (this.code === "launch_uncertain")
      return `The thread may have started on ${this.host ?? "the SSH host"}; check its threads before sending again.`;
    return `SSH workspace ${this.stage} failed (${this.code}).`;
  }
}
