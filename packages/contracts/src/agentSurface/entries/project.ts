import { entry } from "../entry.ts";

export const projectEntries = {
  "project.list": entry({
    resource: "project",
    verb: "list",
    name: "goat_project_list",
    toolkit: "project",
    summary: "List registered projects in this environment.",
    description:
      "List registered projects in this environment. Pages use the current project snapshot and may shift between calls. Pass host (an SSH alias from goat_ssh_host_list or a linked host from goat_host_link_list) for another machine's GOAT environment; its project ids belong to that machine, so pass the same host wherever you use them, such as goat_thread_list. That needs a caller allowed to use this machine's SSH keys. host_unavailable means the machine, SSH, or its GOAT server could not be reached.",
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
      "Read a registered project in this environment, including its workspace and saved scripts. Pass host (an SSH alias from goat_ssh_host_list or a linked host from goat_host_link_list) for another machine's GOAT environment; its project ids belong to that machine, so pass the same host wherever you use them, such as goat_thread_list. That needs a caller allowed to use this machine's SSH keys. host_unavailable means the machine, SSH, or its GOAT server could not be reached.",
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
      "Register a project directory through the existing project service. Set createWorkspaceRootIfMissing to create a directory. Omit workspaceRoot to start a new project from just its title: the app makes a Git repository for it in its own projects folder, with a README, an icon, and a first commit (commitError says why a commit failed; the project exists either way). Each call creates a new request; an existing registered workspace is rejected. Clone separately with goat_project_clone when needed.",
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
  "project.update": entry({
    resource: "project",
    verb: "update",
    name: "goat_project_update",
    toolkit: "project",
    summary: "Update a registered project's settings.",
    description:
      "Update a registered project's settings. Omitted fields are preserved. Uses the same project service as the app.",
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
      "Delete a project using the existing project deletion lifecycle. Nonempty projects require force=true. This does not delete the repository directory or promise a deleted-thread count.",
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
      "Clone a repository using the app's source-control service. This only clones; register the returned cwd with goat_project_create. An existing destination is not adopted or removed on failure.",
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
} as const;
