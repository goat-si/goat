import { providerSurfaceEntries } from "../providerEntries.ts";
import { entry } from "../entry.ts";

export const providerEntries = {
  "acp_session.list": entry({
    resource: "acp_session",
    verb: "list",
    name: "goat_acp_session_list",
    toolkit: "provider",
    summary: "List ACP provider sessions for a project",
    description:
      "List native ACP sessions and imported GOAT threads. Continue with nextCursor until it is null.",
    parameters: {
      instanceId: "ACP provider instance ID.",
      projectId: "Project whose workspace contains the sessions.",
      cursor: "Continuation cursor from the previous page.",
    },
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: true },
  }),
  "provider.list": entry({
    resource: "provider",
    verb: "list",
    name: "orchestrator_capabilities",
    toolkit: "orchestrator",
    summary: "Get orchestration capabilities",
    description:
      "List provider instances, a model shortlist, inherited runtime settings, and orchestration features. A missing model may only be omitted from the shortlist; search before treating it as unavailable. goat_task_create can use catalog models outside this shortlist.",
    guide:
      "The models come from the provider registry also streamed to clients. Without a search, the shortlist includes visible favorite, custom, and caller-selected models, including pinned legacy models. It includes all visible current Codex, Claude, Muse, and Grok models, and the first eight current models of other drivers in the user's model order. Hidden non-custom models are excluded even when pinned. Other visible legacy models are omitted. omittedModels counts visible models excluded from the current response; with a search, it counts unlisted matches. Search matches every term against the model slug, name, and subprovider, keeps exact slug matches above the limit, and otherwise lists up to eight matches. Task creation still checks provider readiness and model options. For a separate top-level thread in a new or existing worktree, call goat_thread_launch with workspaceStrategy.",
    examples: [
      { title: "List providers and the short model list", args: {} },
      { title: "Find a model by name", args: { search: "opus" } },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Get orchestration capabilities",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "provider.home_request": entry(providerSurfaceEntries.home_request),
  "provider.host_matrix": entry(providerSurfaceEntries.host_matrix),
  "provider.sync": entry(providerSurfaceEntries.sync),
  "provider.sync_read": entry(providerSurfaceEntries.sync_read),
  "provider.sync_cancel": entry(providerSurfaceEntries.sync_cancel),
  "provider.diagnose": entry(providerSurfaceEntries.diagnose),
  "provider.addable_list": entry(providerSurfaceEntries.addable_list),
  "provider.setup_open": entry(providerSurfaceEntries.setup_open),
  "provider.login_start": entry(providerSurfaceEntries.login_start),
  "provider.login_status": entry(providerSurfaceEntries.login_status),
  "provider.login_cancel": entry(providerSurfaceEntries.login_cancel),
  "provider.update": entry(providerSurfaceEntries.update),
  "provider.add": entry(providerSurfaceEntries.add),
  "provider.link": entry(providerSurfaceEntries.link),
  "provider.remove": entry(providerSurfaceEntries.remove),
} as const;
