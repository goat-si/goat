import {
  GoatclawRole,
  HostPressureAdvice,
  MemoryTaskGrantCeiling,
  PermissionProfile,
  ModelSelection,
  NonNegativeInt,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestrationV2ThreadLauncher,
  OrchestratorMcpFailure,
  OrchestratorMcpHost,
  Project,
  ProjectCreatePayload,
  ProjectId,
  ProjectUpdatePayload,
  ProviderInteractionMode,
  RemoteReportBindingInput,
  RunId,
  RuntimeMode,
  RepositoryReferenceRequest,
  RepositoryReferenceSnapshot,
  RepositoryReferences,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  ThreadId,
  TrimmedNonEmptyString,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadLaunchMcpService from "../../ThreadLaunchMcpService.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import { NotifyTargetInput } from "../../completionWebhook.ts";
import { McpAttachmentInput } from "../attachment/input.ts";

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

const resultHost = Schema.optional(Schema.String).annotate({
  description: "The SSH host this came from; absent for this environment.",
});
const ProjectListTool = Tool.make(agentSurfaceRegistry["project.list"].name, {
  ...shared,
  description: agentSurfaceRegistry["project.list"].description,
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
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["project.list"]));
const ProjectReadTool = Tool.make(agentSurfaceRegistry["project.read"].name, {
  ...shared,
  description: agentSurfaceRegistry["project.read"].description,
  parameters: Schema.Struct({ projectId: ProjectId, host: Schema.optional(OrchestratorMcpHost) }),
  success: Schema.Struct({ ...Project.fields, host: resultHost }),
  dependencies: hostProjectDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["project.read"]));
const ProjectCreateTool = Tool.make(agentSurfaceRegistry["project.create"].name, {
  ...shared,
  description: agentSurfaceRegistry["project.create"].description,
  parameters: Schema.Struct({
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
  }),
  success: Schema.Struct({ ...Project.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["project.create"]));
const ProjectUpdateTool = Tool.make(agentSurfaceRegistry["project.update"].name, {
  ...shared,
  description: agentSurfaceRegistry["project.update"].description,
  parameters: Schema.Struct({ projectId: ProjectId, ...ProjectUpdatePayload.fields }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["project.update"]));
const ProjectDeleteTool = Tool.make(agentSurfaceRegistry["project.delete"].name, {
  ...shared,
  description: agentSurfaceRegistry["project.delete"].description,
  parameters: Schema.Struct({ projectId: ProjectId, force: Schema.optionalKey(Schema.Boolean) }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["project.delete"]));
const ProjectCloneTool = Tool.make(agentSurfaceRegistry["project.clone"].name, {
  ...shared,
  description: agentSurfaceRegistry["project.clone"].description,
  parameters: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["project.clone"]));
export const ThreadLaunchParameters = Schema.Struct({
  references: Schema.optional(RepositoryReferences),
  projectId: Schema.optional(ProjectId),
  scratch: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Launch without a project, in its own folder under the environment's Scratch project. Not with projectId or workspaceStrategy.",
    }),
  ),
  title: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  memoryGrantCeiling: Schema.optional(MemoryTaskGrantCeiling),
  permissionProfileCeiling: Schema.optional(PermissionProfile),
  goatclawRole: Schema.optional(
    GoatclawRole.annotate({
      description:
        "Only while goatclaw is on: launch as a goatclaw role. The thread runs under that role's permission profile, narrowed by yours, and its message is preceded by the role's instructions and report protocol. supervisor reads, plans and asks; domain-manager owns one goal; merge-manager lands green pull requests one at a time; issue-sweeper triages and fixes small issues. Needs message.",
    }),
  ),
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
        "Also post this launch watch's reports (run ended, waiting on a question, host unavailable) to the server's default completion webhook (completionWebhook.url in settings), for an agent outside GOAT. Prefer notifyTarget when several agents share this server. Needs the launch watch (notifyOnCompletion not false). From a client outside any GOAT thread, this asks for a watch that reports only to the webhook; the result says watching:true when one was recorded. Does nothing while the webhook is off. Default false: no launch posts anywhere unless it opts in.",
    }),
  ),
  notifyTarget: Schema.optional(
    NotifyTargetInput.annotate({
      description:
        "Route this launch's watch reports (run ended, waiting on a question, host unavailable) to ONE webhook receiver, for the agent outside GOAT that dispatched it: {name} for a target configured in server settings (completionWebhook.targets), or {url, secretRef?} for an inline receiver, where secretRef comes from request_secret and signs each post. Only this receiver gets the reports; the server's default webhook does not. Needs the launch watch (notifyOnCompletion not false). An unknown name, a non-http(s) url, a url that resolves to a loopback, private, or link-local address (a local receiver needs a named target), or webhooks switched off in settings refuse the launch before any thread is created.",
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
});

export const ThreadLaunchSuccess = Schema.Struct({
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
  /** Set when this machine is under resource pressure; see goat_host_status placement. */
  pressure: Schema.optional(HostPressureAdvice),
});

const ThreadLaunchTool = Tool.make(agentSurfaceRegistry["thread.launch"].name, {
  ...shared,
  description: agentSurfaceRegistry["thread.launch"].description,
  parameters: ThreadLaunchParameters,
  success: ThreadLaunchSuccess,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadLaunchMcpService.ThreadLaunchMcpService,
    RepositoryReferenceMcpService.RepositoryReferenceMcpService,
    ThreadManagementService.ThreadManagementService,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.launch"]));

const RepositorySnapshotTool = Tool.make(agentSurfaceRegistry["repository.snapshot"].name, {
  description: agentSurfaceRegistry["repository.snapshot"].description,
  parameters: RepositoryReferenceRequest,
  success: RepositoryReferenceSnapshot,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    RepositoryReferenceMcpService.RepositoryReferenceMcpService,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["repository.snapshot"]));

export const ProjectToolkit = Toolkit.make(
  RepositorySnapshotTool,
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
);
