import { McpAttachmentInput } from "../attachment/input.ts";
import {
  NonNegativeInt,
  ModelSelection,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestrationV2ThreadLauncher,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpFailure,
  OrchestratorMcpHost,
  RemoteReportBindingInput,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteReportService from "../../../remoteReports/RemoteReportService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
};
/** Project reads that can also reach another machine's projects. */
const hostProjectDependencies = [
  ...shared.dependencies,
  HostThreadsMcpService.HostThreadsMcpService,
];
const ON_ANOTHER_MACHINE =
  " Pass host (an SSH alias from goat_ssh_host_list) for another machine's GOAT environment; its project ids belong to that machine, so pass the same host wherever you use them, such as goat_thread_list. That needs a caller allowed to use this machine's SSH keys. host_unavailable means the machine, SSH, or its GOAT server could not be reached.";
const resultHost = Schema.optional(Schema.String).annotate({
  description: "The SSH host this came from; absent for this environment.",
});
const ProjectListTool = Tool.make("goat_project_list", {
  ...shared,
  description:
    "List registered projects in this environment. Pages use the current project snapshot and may shift between calls." +
    ON_ANOTHER_MACHINE,
  parameters: Schema.Struct({
    host: Schema.optional(OrchestratorMcpHost),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
    host: resultHost,
  }),
  dependencies: hostProjectDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadTool = Tool.make("goat_project_read", {
  ...shared,
  description:
    "Read a registered project in this environment, including its workspace and saved scripts." +
    ON_ANOTHER_MACHINE,
  parameters: Schema.Struct({ projectId: ProjectId, host: Schema.optional(OrchestratorMcpHost) }),
  success: Schema.Struct({ ...Project.fields, host: resultHost }),
  dependencies: hostProjectDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("goat_project_create", {
  ...shared,
  description:
    "Register a project directory through the existing project service. Set createWorkspaceRootIfMissing to create a directory. Omit workspaceRoot to start a new project from just its title: the app makes a Git repository for it in its own projects folder, with a README, an icon, and a first commit (commitError says why a commit failed; the project exists either way). Each call creates a new request; an existing registered workspace is rejected. Clone separately with goat_project_clone when needed.",
  parameters: Schema.Struct({
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
  }),
  success: Schema.Struct({ ...Project.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("goat_project_update", {
  ...shared,
  description:
    "Update a registered project's settings. Omitted fields are preserved. Uses the same project service as the app.",
  parameters: Schema.Struct({ projectId: ProjectId, ...ProjectUpdatePayload.fields }),
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("goat_project_delete", {
  ...shared,
  description:
    "Delete a project using the existing project deletion lifecycle. Nonempty projects require force=true. This does not delete the repository directory or promise a deleted-thread count.",
  parameters: Schema.Struct({ projectId: ProjectId, force: Schema.optionalKey(Schema.Boolean) }),
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("goat_project_clone", {
  ...shared,
  description:
    "Clone a repository using the app's source-control service. This only clones; register the returned cwd with goat_project_create. An existing destination is not adopted or removed on failure.",
  parameters: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const ThreadLaunchTool = Tool.make("goat_thread_launch", {
  ...shared,
  description:
    'Create an ordinary TOP-LEVEL thread with an explicit workspace binding before its agent starts. Use this when the user requests independent work, a new thread, or a PR stack in its own worktree, and for work that owns a goal, runs a loop (HOTL, cxc-loop, repeated PABCD), or spans several cycles, even when the user calls it a subagent: top-level threads appear in the sidebar, where the user can open, steer, and resume them. Use delegate_task for bounded child subagents that report back and end. Set workspaceStrategy to {type:"worktree",baseRef:"parent-branch",branch:"new-branch",startFromOrigin:false} for a new worktree based on local commits, or {type:"existing_worktree",worktreePath:"/absolute/path",branch:"existing-branch"} to use an existing checkout. For upstream commits, set startFromOrigin:true. Omitted workspaceStrategy means the project root, NOT the caller\'s worktree. Omit projectId/modelSelection/modes to inherit those settings from the calling thread; a caller outside a GOAT thread must pass projectId and gets the project\'s default model. Set scratch:true instead of projectId for a thread without a project: it runs in a fresh folder of its own, outside any repository. Put the task in message. Do not ask the agent to create its own worktree via shell: that does not update the thread binding. Each call creates a new launch with no retry key; retain threadId. A calling GOAT thread is woken with a message when the run of the new thread ends or waits on a question, so do not poll it with goat_thread_wait; notifyOnCompletion:false or goat_thread_unwatch stops run-end and host-outage reports. Only local user-input questions still arrive. SSH-host questions then need goat_thread_wait({host}) or goat_pending_request_list({scope:"launched", hosts}). Approvals are no longer reported; check goat_thread_read or tell the user the thread may be waiting. To link a thread for the user, write `[title](t3-thread://v1/<threadId>)` with the threadId exactly as returned, not URL-encoded; GOAT shows the thread\'s current title. After errors or lost responses, inspect goat_thread_list before retrying. Attachments must be pending uploads. The new thread may not run with broader runtime or interaction modes than the caller: the calling GOAT thread\'s own modes, or the permission mode an outside agent was approved with.',
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    scratch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Launch without a project, in its own folder under the environment's Scratch project. Not with projectId or workspaceStrategy.",
      }),
    ),
    title: TrimmedNonEmptyString,
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(
      OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
        description:
          "Choose where this thread runs before starting its agent: worktree creates and binds a new checkout from baseRef; existing_worktree binds worktreePath, which must be one of the project's git worktrees; root uses the project checkout. Omitted means root, not the caller's worktree. For a PR stack use the parent branch as baseRef and startFromOrigin:false. Uncommitted changes are not copied.",
      }),
    ),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description:
          "First task prompt, delivered after workspace preparation. Omit message and attachments to create an idle thread.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
    standingInstructions: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Default true: GOAT puts this environment's standing instructions (the project's own when it has them; see goat_environment_read) in front of message, in a block the user sees collapsed. Pass false to send message exactly as written.",
      }),
    ),
    notifyOnCompletion: Schema.optional(
      Schema.Boolean.annotate({
        description:
          'Default true for a calling GOAT thread: it is woken with a message when the new thread\'s run ends, waits on a question, or later runs you start with goat_thread_send end. Pass false to stop run-end and host-outage reports. Only local user-input questions still arrive. SSH-host questions then need goat_thread_wait({host}) or goat_pending_request_list({scope:"launched", hosts}). Approvals are no longer reported; check goat_thread_read or tell the user the thread may be waiting.',
      }),
    ),
    notifyWebhook: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Also post this launch watch's reports (run ended, waiting on a question, host unavailable) to the completion webhook configured in server settings, for an agent outside GOAT. Needs the launch watch (notifyOnCompletion not false). Does nothing while the webhook is off. Default false.",
      }),
    ),
    launchedBy: Schema.optional(
      OrchestrationV2ThreadLauncher.annotate({
        description:
          "Set by GOAT when it forwards a launch from another machine. Leave unset; a calling GOAT thread is recorded automatically.",
      }),
    ),
    report: Schema.optional(
      RemoteReportBindingInput.annotate({
        description:
          "Set only by another machine's GOAT when it launches this thread over SSH, so the thread can report back to its origin. Agents omit it.",
      }),
    ),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
    /** Whether the calling thread will be told when the new thread finishes. */
    watching: Schema.Boolean,
    /** Version of the standing instructions put in front of message; null when none were. */
    standingInstructionsVersion: Schema.NullOr(Schema.String),
    report: Schema.optional(
      Schema.Struct({ correlationId: RemoteReportBindingInput.fields.correlationId }),
    ),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    ManagedProjectFolders.ManagedProjectFolders,
    GitVcsDriver.GitVcsDriver,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
    LaunchWatchService.LaunchWatchService,
    RemoteReportService.RemoteReportService,
    ServerSettings.ServerSettingsService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
);
