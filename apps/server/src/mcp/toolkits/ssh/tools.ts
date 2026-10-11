import {
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  ProviderInteractionMode,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SshRemoteDispatch.SshRemoteDispatch,
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

const SshHostListTool = Tool.make("goat_ssh_host_list", {
  ...shared,
  description:
    "List the SSH hosts this environment's machine knows from ~/.ssh/config and known_hosts. These are other machines you can browse with goat_ssh_browse and start threads on with goat_ssh_thread_launch. Set probe:true to try a key-based SSH login to each host (a few seconds; reports reachable and the error).",
  parameters: Schema.Struct({ probe: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ hosts: Schema.Array(SshHost) }),
})
  .annotate(Tool.Title, "List SSH hosts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SshBrowseTool = Tool.make("goat_ssh_browse", {
  ...shared,
  description:
    "List the folders in a directory on another machine over SSH, to pick where a remote thread should run. Omit path for the remote home directory; ~ and ~/sub are expanded there. Reports whether the directory is in a Git repository, its checked-out branch and its Git worktrees, and marks child folders that are repositories. Only SSH keys or a running ssh-agent are used; a host that needs a password fails.",
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
})
  .annotate(Tool.Title, "Browse folders over SSH")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const SshLaunchWorkspace = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cwd") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    branch: TrimmedNonEmptyString,
    baseRef: Schema.optional(TrimmedNonEmptyString),
    startFromOrigin: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktreePath: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
]).annotate({
  description:
    "cwd runs in the folder itself. worktree creates a new Git worktree of the folder's repository on the remote, on a new branch from baseRef (default: the folder's checked-out branch). existing_worktree reuses one of the worktrees goat_ssh_browse reported. Default cwd.",
});

const SshThreadLaunchTool = Tool.make("goat_ssh_thread_launch", {
  ...shared,
  description:
    "Start a thread on ANOTHER machine, in that machine's own GOAT environment, over SSH. Use it when the user asks to run work on a different computer. Pick host from goat_ssh_host_list and cwd from goat_ssh_browse. cwd must be a project folder: the filesystem root, the home directory, a folder above home, or another top-level folder is refused unless the user explicitly asked for it and allowBroadWorkspaceRoot is true. The folder becomes (or reuses) a project on the remote, then the thread starts in the folder or in a worktree per workspace, and its agent gets message. GOAT is launched on the remote if it is not running. Omitted modelSelection uses the calling thread's model, which the remote must also offer. Needs a full-access caller. The thread lives on the remote: follow it from here with goat_thread_wait / goat_thread_read and steer it with goat_thread_send, passing the same host and the returned threadId; the user can watch it by connecting to that host in Settings → Connections. Each call creates a new thread; after a lost response, check goat_thread_list with host before retrying.",
  parameters: Schema.Struct({
    host: HostAlias,
    cwd: TrimmedNonEmptyString.annotate({
      description: "Absolute path (or ~/path) of the folder on the remote machine.",
    }),
    workspace: Schema.optional(SshLaunchWorkspace),
    title: TrimmedNonEmptyString,
    message: Schema.optional(Schema.String.check(Schema.isMaxLength(120000))),
    projectTitle: Schema.optional(TrimmedNonEmptyString),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    allowBroadWorkspaceRoot: Schema.optional(Schema.Boolean).annotate({
      description:
        "Set true only when the user explicitly wants the filesystem root, the home directory, a folder above home, or another top-level folder as the workspace. Otherwise such a cwd is refused.",
    }),
  }),
  success: Schema.Struct({
    host: Schema.String,
    cwd: Schema.String,
    projectId: Schema.String,
    projectCreated: Schema.Boolean,
    threadId: Schema.String,
    workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
    runtimeMode: RuntimeMode,
    remoteServerKind: Schema.NullOr(Schema.Literals(["external", "managed"])),
    notes: Schema.Array(Schema.String),
  }),
})
  .annotate(Tool.Title, "Start a thread on another machine")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const SshToolkit = Toolkit.make(SshHostListTool, SshBrowseTool, SshThreadLaunchTool);
