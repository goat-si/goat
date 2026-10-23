import * as Crypto from "effect/Crypto";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as SshDeviceAdd from "../../../sshRemote/SshDeviceAdd.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import { GoatclawRole, RemoteReportDeliveryMode, RemoteDispatchView } from "@goat/contracts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import {
  AuthMcpClientAccess,
  CloudMachine,
  CloudMachineAlias,
  CloudMachinesCreateInput,
  CloudMachinesListResult,
  HostPressureAdvice,
  ModelSelection,
  ProjectId,
  ThreadId,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  ProviderInteractionMode,
  RuntimeMode,
  RepositoryLaunchSelection,
  RepositoryReferences,
  TrimmedNonEmptyString,
  SshLaunchWorkspace,
  SshWorkspaceCode,
  SshHostPrepareInput,
  SshHostForgetInput,
  SshHostStatusInput,
  SshRuntimeUpdateInput,
  SshHostResult,
  SshHostSettledResult,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as CloudMachineService from "../../../cloudMachines/CloudMachineService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as SshHostSetup from "../../../sshRemote/SshHostSetup.ts";
import * as SshWorkspaceSync from "../../../sshRemote/SshWorkspaceSync.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import * as RepositoryLaunchMcpService from "../../RepositoryLaunchMcpService.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

import { McpAttachmentInput } from "../attachment/input.ts";
import { NotifyTargetInput } from "../../completionWebhook.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    Profiles.PermissionProfiles,
    Crypto.Crypto,
    ThreadManagementService.ThreadManagementService,
    SshRemoteDispatch.SshRemoteDispatch,
    SshHostSetup.SshHostSetup,
    LaunchWatchService.LaunchWatchService,
    ServerEnvironment.ServerEnvironment,
    RemoteDispatchCoordinator.RemoteDispatchCoordinator,
  ],
};

const SshHost = Schema.Struct({
  alias: Schema.String,
  source: Schema.Literals(["ssh-config", "known-hosts"]),
  reachable: Schema.optional(Schema.Boolean),
  probeError: Schema.optional(Schema.String),
});

const RemoteWorktree = Schema.Struct({
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  bare: Schema.Boolean,
  detached: Schema.Boolean,
});

const RemoteEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["directory", "symlink"]),
  isGitRepository: Schema.Boolean,
});

const HostAlias = TrimmedNonEmptyString.annotate({
  description:
    "An SSH host alias from goat_ssh_host_list (this machine's ~/.ssh/config or known_hosts).",
});

const SshHostListTool = Tool.make(agentSurfaceRegistry["ssh.host_list"].name, {
  ...shared,
  description: agentSurfaceRegistry["ssh.host_list"].description,
  parameters: Schema.Struct({ probe: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ hosts: Schema.Array(SshHost) }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["ssh.host_list"]));

const LinkedHost = Schema.Struct({
  name: Schema.String,
  baseUrl: Schema.String,
  environmentId: Schema.String,
  label: Schema.String,
  serverVersion: Schema.String,
  access: AuthMcpClientAccess,
  linkedAt: Schema.String,
  expiresAt: Schema.String,
});

const HostLinkCreateTool = Tool.make(agentSurfaceRegistry["host_link.create"].name, {
  ...shared,
  description: agentSurfaceRegistry["host_link.create"].description,
  parameters: Schema.Struct({
    name: TrimmedNonEmptyString.annotate({
      description:
        "What to call the host in the host parameter of other tools: lowercase letters, digits, '.', '_' and '-'. Must not be an SSH alias from goat_ssh_host_list.",
    }),
    url: TrimmedNonEmptyString.annotate({
      description:
        "The pairing URL from goat pair or goat auth pairing create on that host, or the host's https address (then pass code).",
    }),
    code: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "A pairing code from that host, when url is only its address.",
      }),
    ),
    access: Schema.optional(AuthMcpClientAccess),
  }),
  success: Schema.Struct({ host: LinkedHost, replaced: Schema.Boolean }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host_link.create"]));

const HostLinkListTool = Tool.make(agentSurfaceRegistry["host_link.list"].name, {
  ...shared,
  description: agentSurfaceRegistry["host_link.list"].description,
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ hosts: Schema.Array(LinkedHost) }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host_link.list"]));

const HostLinkRemoveTool = Tool.make(agentSurfaceRegistry["host_link.remove"].name, {
  ...shared,
  description: agentSurfaceRegistry["host_link.remove"].description,
  parameters: Schema.Struct({ name: TrimmedNonEmptyString }),
  success: Schema.Struct({ removed: LinkedHost }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host_link.remove"]));

// HandoffSummary contains DateTime.Utc. MCP structuredContent accepts JSON values,
// so encode the domain result through its JSON codec before CallToolResult validates it.
const SshHostResultJson = Schema.toCodecJson(SshHostResult);
const SshHostSettledResultJson = Schema.toCodecJson(SshHostSettledResult);

const SshHostStatusTool = Tool.make(agentSurfaceRegistry["ssh.host_status"].name, {
  ...shared,
  description: agentSurfaceRegistry["ssh.host_status"].description,
  parameters: SshHostStatusInput,
  success: SshHostSettledResultJson,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["ssh.host_status"]));

const SshHostAddTool = Tool.make(agentSurfaceRegistry["ssh.host_add"].name, {
  ...shared,
  description: agentSurfaceRegistry["ssh.host_add"].description,
  dependencies: [...shared.dependencies, SshDeviceAdd.SshDeviceAdd],
  parameters: SshDeviceAdd.SshDeviceAddInput,
  success: Schema.toCodecJson(SshDeviceAdd.SshDeviceAddResult),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["ssh.host_add"]));
const SshHostPrepareTool = Tool.make(agentSurfaceRegistry["ssh.host_prepare"].name, {
  ...shared,
  description: agentSurfaceRegistry["ssh.host_prepare"].description,
  parameters: SshHostPrepareInput,
  success: SshHostResultJson,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["ssh.host_prepare"]));
const SshHostForgetTool = Tool.make(agentSurfaceRegistry["ssh.host_forget"].name, {
  ...shared,
  description: agentSurfaceRegistry["ssh.host_forget"].description,
  parameters: SshHostForgetInput,
  success: SshHostSettledResultJson,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["ssh.host_forget"]));
const SshRuntimeUpdateTool = Tool.make(agentSurfaceRegistry["ssh.runtime_update"].name, {
  ...shared,
  description: agentSurfaceRegistry["ssh.runtime_update"].description,
  parameters: SshRuntimeUpdateInput,
  success: SshHostResultJson,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["ssh.runtime_update"]));

const SshBrowseTool = Tool.make(agentSurfaceRegistry["ssh.browse"].name, {
  ...shared,
  description: agentSurfaceRegistry["ssh.browse"].description,
  parameters: Schema.Struct({
    host: HostAlias,
    path: Schema.optional(Schema.String),
    showHidden: Schema.optional(Schema.Boolean),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
  }),
  success: Schema.Struct({
    host: Schema.String,
    os: Schema.NullOr(Schema.String),
    home: Schema.NullOr(Schema.String),
    path: Schema.String,
    realPath: Schema.String,
    gitRoot: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
    worktrees: Schema.Array(RemoteWorktree),
    entries: Schema.Array(RemoteEntry),
    truncated: Schema.Boolean,
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["ssh.browse"]));

const SshThreadLaunchTool = Tool.make(agentSurfaceRegistry["ssh.thread_launch"].name, {
  ...shared,
  dependencies: [
    ...shared.dependencies,
    RepositoryLaunchMcpService.RepositoryLaunchMcpService,
    RepositoryReferenceMcpService.RepositoryReferenceMcpService,
  ],
  description: agentSurfaceRegistry["ssh.thread_launch"].description,
  parameters: Schema.Struct({
    repository: Schema.optional(RepositoryLaunchSelection).annotate({
      description:
        "Verify this normalized origin key at the selected absolute cwd (or existing_worktree path) before launch. Refuses missing, mismatched or unsupported inventory; suggests matching local/explicit candidateHosts checkouts. Does not fetch, install, or choose a host.",
    }),
    references: Schema.optional(RepositoryReferences),
    host: TrimmedNonEmptyString.annotate({
      description:
        "An SSH host alias from goat_ssh_host_list, or a linked host name from goat_host_link_list.",
    }),
    cwd: TrimmedNonEmptyString.annotate({
      description: "Absolute path (or ~/path) of the folder on the remote machine.",
    }),
    workspace: Schema.optional(SshLaunchWorkspace),
    title: TrimmedNonEmptyString,
    message: Schema.optional(Schema.String.check(Schema.isMaxLength(120000))),
    projectTitle: Schema.optional(TrimmedNonEmptyString),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    goatclawRole: Schema.optional(
      GoatclawRole.annotate({
        description:
          "Only while goatclaw is on: launch as a goatclaw role (supervisor, domain-manager, merge-manager, issue-sweeper). The remote enforces that role's permission profile narrowed by yours, and message is preceded by the role's instructions and report protocol. Needs message.",
      }),
    ),
    interactionMode: Schema.optional(ProviderInteractionMode),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
    standingInstructions: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Default true: the remote GOAT puts its own standing instructions in front of message. Pass false to send message exactly as written; a remote too old to accept that is noted in notes.",
      }),
    ),
    reportDelivery: Schema.optional(
      RemoteReportDeliveryMode.annotate({
        description:
          "wake (default) wakes the origin only for needs_input questions that need an answer before continuing; completed, failed, progress and lost reports wait in the next-turn inbox. next_turn defers all reports; notify_only records them for goat_ssh_reports. The launch watch reports run ends. An imported report rides its wake turn if import finishes first; otherwise it arrives one turn later.",
      }),
    ),
    allowBroadWorkspaceRoot: Schema.optional(Schema.Boolean).annotate({
      description:
        "Set true only when the user explicitly wants the filesystem root, the home directory, a folder above home, or another top-level folder as the workspace. Otherwise such a cwd is refused.",
    }),
    notifyOnCompletion: Schema.optional(
      Schema.Boolean.annotate({
        description:
          'Default true for a calling GOAT thread: the launch watch follows the remote thread over SSH and wakes the caller when its run ends, waits on a question, or its host stays unreachable. Pass notifyOnCompletion:false or use goat_thread_unwatch to stop run-end and host-outage reports. None of this remote thread\'s questions arrive through the launch watch after opting out. SSH-host questions then need goat_thread_wait({host}) or goat_pending_request_list({scope:"launched", hosts}). Approvals are no longer reported; check goat_thread_read or tell the user the thread may be waiting. Agent reports still arrive per reportDelivery; wake (default) wakes only for needs_input questions, while completed and failed reports wait for the next origin turn.',
      }),
    ),
    notifyWebhook: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Also post this launch watch's reports (run ended, waiting on a question, host unavailable) to the default completion webhook in this machine's server settings (completionWebhook.url), for an agent outside GOAT. Prefer notifyTarget when several agents share this server. Needs the launch watch (notifyOnCompletion not false). From a client outside any GOAT thread, this asks for a watch that reports only to the webhook; the result says watching:true when one was recorded. Does nothing while the webhook is off. Default false: no launch posts anywhere unless it opts in.",
      }),
    ),
    notifyTarget: Schema.optional(
      NotifyTargetInput.annotate({
        description:
          "Route this launch's watch reports (run ended, waiting on a question, host unavailable) to ONE webhook receiver, for the agent outside GOAT that dispatched it: {name} for a target configured in this machine's server settings (completionWebhook.targets), or {url, secretRef?} for an inline receiver, where secretRef comes from request_secret and signs each post. Only this receiver gets the reports; the server's default webhook does not. Needs the launch watch (notifyOnCompletion not false). An unknown name, a non-http(s) url, a url that resolves to a loopback, private, or link-local address (a local receiver needs a named target), or webhooks switched off in settings refuse the launch before any thread is created.",
      }),
    ),
  }),
  success: Schema.Struct({
    host: Schema.String,
    cwd: Schema.String,
    projectId: Schema.String,
    projectCreated: Schema.Boolean,
    threadId: Schema.String,
    runId: Schema.NullOr(Schema.String),
    reportsSupported: Schema.Boolean,
    correlationId: Schema.NullOr(Schema.String),
    workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
    runtimeMode: RuntimeMode,
    remoteServerKind: Schema.NullOr(Schema.Literals(["external", "managed"])),
    /** Whether the calling thread will be told when the remote thread finishes. */
    watching: Schema.Boolean,
    notes: Schema.Array(Schema.String),
    /** Set when that host was under resource pressure at its last status read. */
    pressure: Schema.optional(HostPressureAdvice),
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["ssh.thread_launch"]));

/** Keeps workspace refusal codes intact when the MCP tool returns a declared failure. */
export class SshThreadHandoffFailure extends Schema.TaggedError<SshThreadHandoffFailure>()(
  "SshThreadHandoffFailure",
  { code: SshWorkspaceCode, message: Schema.String },
) {}

const SshThreadHandoffTool = Tool.make(agentSurfaceRegistry["ssh.thread_handoff"].name, {
  ...shared,
  dependencies: [...shared.dependencies, SshWorkspaceSync.SshWorkspaceSync],
  failure: Schema.Union([OrchestratorMcpFailure, SshThreadHandoffFailure]),
  description: agentSurfaceRegistry["ssh.thread_handoff"].description,
  parameters: Schema.Struct({
    host: HostAlias,
    threadId: Schema.optional(
      ThreadId.annotate({ description: "Defaults to the calling thread." }),
    ),
    message: Schema.optional(Schema.String.check(Schema.isMaxLength(120000))),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
  }),
  success: Schema.Struct({
    host: Schema.String,
    operationId: Schema.String,
    remoteThreadId: ThreadId,
    remoteProjectId: ProjectId,
    remoteRepoPath: Schema.String,
    branch: Schema.String,
    notes: Schema.Array(Schema.String),
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["ssh.thread_handoff"]));

const SshReportsTool = Tool.make(agentSurfaceRegistry["ssh.reports"].name, {
  ...shared,
  description: agentSurfaceRegistry["ssh.reports"].description,
  parameters: Schema.Struct({
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Struct({ dispatches: Schema.Array(RemoteDispatchView) }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["ssh.reports"]));

const cloudShared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CloudMachineService.CloudMachineService,
    Profiles.PermissionProfiles,
  ],
};
const CloudAliasParameters = Schema.Struct({
  alias: CloudMachineAlias.annotate({
    description: "The machine's SSH alias from goat_cloud_machine_list (boat-<sandbox id>).",
  }),
});

const CloudMachineListTool = Tool.make(agentSurfaceRegistry["cloud_machine.list"].name, {
  ...cloudShared,
  description: agentSurfaceRegistry["cloud_machine.list"].description,
  parameters: Tool.EmptyParams,
  success: CloudMachinesListResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["cloud_machine.list"]));

const CloudMachineCreateTool = Tool.make(agentSurfaceRegistry["cloud_machine.create"].name, {
  ...cloudShared,
  description: agentSurfaceRegistry["cloud_machine.create"].description,
  parameters: CloudMachinesCreateInput,
  success: CloudMachine,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["cloud_machine.create"]));

const CloudMachineStopTool = Tool.make(agentSurfaceRegistry["cloud_machine.stop"].name, {
  ...cloudShared,
  description: agentSurfaceRegistry["cloud_machine.stop"].description,
  parameters: CloudAliasParameters,
  success: CloudMachine,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["cloud_machine.stop"]));

const CloudMachineResumeTool = Tool.make(agentSurfaceRegistry["cloud_machine.resume"].name, {
  ...cloudShared,
  description: agentSurfaceRegistry["cloud_machine.resume"].description,
  parameters: CloudAliasParameters,
  success: CloudMachine,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["cloud_machine.resume"]));

export const SshToolkit = Toolkit.make(
  SshHostAddTool,
  SshHostPrepareTool,
  SshHostForgetTool,
  SshHostListTool,
  HostLinkCreateTool,
  HostLinkListTool,
  HostLinkRemoveTool,
  SshHostStatusTool,
  SshRuntimeUpdateTool,
  SshBrowseTool,
  SshThreadLaunchTool,
  SshThreadHandoffTool,
  SshReportsTool,
  CloudMachineListTool,
  CloudMachineCreateTool,
  CloudMachineStopTool,
  CloudMachineResumeTool,
);
