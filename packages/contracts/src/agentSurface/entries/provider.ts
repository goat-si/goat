import { providerSurfaceEntries } from "../providerEntries.ts";
import { entry } from "../entry.ts";

export const providerEntries = {
  "provider.list": entry({
    resource: "provider",
    verb: "list",
    name: "orchestrator_capabilities",
    toolkit: "orchestrator",
    summary: "Get orchestration capabilities",
    description:
      "List the V2 provider instances, a short list of their models from the same live catalog as the composer, inherited runtime settings, and app-owned orchestration features available to this caller. The list has the user's favorite and custom models, your own model, every current Codex, Claude, Muse and Grok model, and the first 8 current models of other providers. Other legacy models are left out. omittedModels counts models left out; pass search, such as 'sonnet 4.6', to find them. goat_task_create accepts any catalog model, listed or not. For a separate top-level thread in a new or existing worktree, use goat_thread_launch with workspaceStrategy.",
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
