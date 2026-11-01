import { entry } from "../entry.ts";

export const projectEntries = {
  "project.list": entry({
    resource: "project",
    verb: "list",
    name: "goat_project_list",
    toolkit: "project",
    summary: "List registered projects in this environment.",
    description:
      "Read a page of registered projects in this environment or on host. Pages may shift between calls. Remote project ids belong to that machine; keep passing the same host when using them.",
    guide:
      "Pages use the current project snapshot rather than a snapshot pinned across calls.\n\nPass host from goat_ssh_host_list or goat_host_link_list to use another machine's GOAT environment. Remote project ids belong to that machine; pass the same host with those ids, including to goat_thread_list. Host calls require a live caller permitted to reach other machines with this machine's credentials. host_unavailable means the machine, transport, or GOAT server cannot be reached.",
    effect: "read",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "project.read": entry({
    resource: "project",
    verb: "read",
    name: "goat_project_read",
    toolkit: "project",
    summary:
      "Read a registered project in this environment, including its workspace and saved scripts.",
    description:
      "Read a registered project, including its workspace and saved scripts, locally or on host. Remote project ids belong to that machine; keep passing the same host when using them.",
    guide:
      "Pass host from goat_ssh_host_list or goat_host_link_list to use another machine's GOAT environment. Remote project ids belong to that machine; pass the same host with those ids, including to goat_thread_list. Host calls require a live caller permitted to reach other machines with this machine's credentials. host_unavailable means the machine, transport, or GOAT server cannot be reached.",
    effect: "read",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "project.create": entry({
    resource: "project",
    verb: "create",
    name: "goat_project_create",
    toolkit: "project",
    summary: "Register a project directory through the existing project service.",
    description:
      "Register a project directory, optionally creating it. Omit workspaceRoot to create a Git repository from a title with a README, icon and attempted first commit. Retry with the same clientRequestId to reuse the first project; commit failure still leaves it registered.",
    guide:
      "Set createWorkspaceRootIfMissing to create a missing directory. With workspaceRoot omitted, supply only the title; GOAT creates the repository in its own projects folder. commitError explains a failed initial commit; the project exists either way.\n\nRetry with the same clientRequestId and arguments to reuse the first creation. Without a key each call is a new request; an already registered workspace is rejected. Clone separately with goat_project_clone, then register the returned cwd with goat_project_create.\n\nRegistration goes through the existing project service, for an explicit workspace and for title-only creation alike.",
    idempotency: "key",
    reconcile: "project.list",
    effect: "destructive",
    // Worker and manager agents set up the projects they work in (#858); changing or deleting
    // a project stays with settings.write.
    capability: "worktree.create",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "project.update": entry({
    resource: "project",
    verb: "update",
    name: "goat_project_update",
    toolkit: "project",
    summary: "Update a registered project's settings.",
    description: "Update a registered project's settings. Omitted fields stay unchanged.",
    guide:
      "The handler uses ProjectService.update and supplies only the requested changes.\n\nUpdates go through the same project service as the app.",
    idempotencyReason:
      "ProjectService.update assigns only supplied settings to the same project id. Repeating the patch preserves omitted fields and does not create a project, workspace or provider run.",
    effect: "destructive",
    capability: "settings.write",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "project.delete": entry({
    resource: "project",
    verb: "delete",
    name: "goat_project_delete",
    toolkit: "project",
    summary: "Delete a project using the existing project deletion lifecycle.",
    description:
      "Delete a registered project and its threads. The repository directory stays on disk. Nonempty projects require force=true; the result does not promise a deleted-thread count.",
    guide:
      "Use force=true when the project contains active or archived threads. Deletion durably deletes child threads before deleting the project. The result is the project record, without a promised deleted-thread count.\n\nDeletion runs through the project deletion lifecycle.",
    effect: "destructive",
    capability: "settings.write",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
    idempotency: "key",
    reconcile: "project.list",
  }),
  "project.clone": entry({
    resource: "project",
    verb: "clone",
    name: "goat_project_clone",
    toolkit: "project",
    summary: "Clone a repository using the app's source-control service.",
    description:
      "Clone a repository. Register the returned cwd with goat_project_create. This call does not adopt an existing checkout or remove the destination on failure.",
    guide:
      "The tool only clones; it does not register a project. An existing empty destination directory is allowed; a nonempty destination is rejected. The handler does not clean up the destination on failure.\n\nCloning uses the app's source-control service.",
    idempotencyReason:
      "SourceControlRepositoryService.prepareDestination refuses a nonempty destination and git clone targets that exact path. Retrying cannot create a second checkout or adopt/overwrite the completed clone.",
    effect: "destructive",
    capability: "worktree.create",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
