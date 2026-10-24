import { entry } from "../entry.ts";

export const cloudAgentEntries = {
  "cloud_agent.holders": entry({
    resource: "cloud_agent",
    verb: "holders",
    name: "goat_cloud_holders",
    toolkit: "provider",
    summary: "List cloud agent credential holders",
    description:
      "Find environments whose logins can launch and follow Claude Cloud, Cursor Cloud, or Devin Cloud runs. Results are cached for a minute except unreachable hosts; refresh to check again.",
    guide:
      "The search includes this environment and connected SSH hosts; local:true restricts it to this environment. Readiness comes from each host’s provider × host matrix cloud column, derived from provider diagnosis. Results contain readiness, an optional account label, failure reason and sign-in command, plus active-run counts and any hub preference; credentials stay on their holder. Hosts without the cloud column are queried through the older holder tool, then provider diagnosis if needed. runtime update_required marks a host reached through the diagnosis fallback whose runtime cannot accept routed launches; unreachable marks a failed query, not necessarily a powered-off host.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "List cloud credential holders",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "cloud_agent.launch": entry({
    resource: "cloud_agent",
    verb: "launch",
    name: "goat_cloud_launch",
    toolkit: "provider",
    summary: "Launch a cloud agent on a credential holder",
    description:
      "Start a Claude Cloud, Cursor Cloud, or Devin Cloud run in a new thread on the environment holding that login. Cloud runs bill the provider account; launch only when the user asked. Each call creates another thread: after a lost response, check goat_thread_list with the holder as host before retrying. Claude Cloud uses the holder's project folder; the others use a pushed branch.",
    guide:
      "An explicit holder wins; otherwise a configured hub wins, then a ready current holder with the fewest active cloud runs, preferring this environment on a tie. An unusable hub fails rather than switching accounts. The holder needs an existing project matching repo. Claude Cloud uses that project’s checked-out folder, including local changes; branch cannot select a different checkout. Cursor Cloud and Devin Cloud use the selected published branch, or the project’s current branch when omitted. Credentials remain on the holder, so no local sign-in is needed for a remote launch. The result identifies the holder and thread; goat_thread_status follows a remote thread when given its host, while goat_cloud_agent_run_list lists runs on the environment where it executes. dryRun selects the holder without launching. Cloud runs bill the provider account; launch only at the user’s request. With goatclaw enabled, cloud.launch is required and remote holder launches are currently refused. A launch not already admitted as human-started asks for approval: a handoff inside a thread, or a bound decision outside it. After approval, repeat the same launch with handoffId or decisionId. Approval is consumed once. Needs a full-access caller.",
    effect: "write",
    capability: "cloud.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "supported",
    humanSteps: ["approval"],
    annotations: { title: "Launch a cloud agent", idempotentHint: false, openWorldHint: true },
  }),
  "cloud_agent.run_register": entry({
    resource: "cloud_agent",
    verb: "run_register",
    name: "goat_cloud_run_register",
    toolkit: "provider",
    summary: "Track a cloud run launched outside GOAT",
    description:
      "Track a cloud run started outside GOAT in a thread labeled with its launcher. Registration reuses an existing registration on the chosen holder. Link-only tracking reports no run result; Devin Cloud registrations are always link-only.",
    guide:
      "Claude Cloud, Cursor Cloud and Devin Cloud are supported. Supply a provider run id or its HTTPS page on an accepted provider origin; GOAT validates the id and reconstructs the link without fetching the supplied URL. GOAT picks a ready holder, or keeps the registration locally as link-only if none is available (an unusable preferred hub can also fall back to local even when another holder is ready); an explicit holder overrides selection. Deduplication is local to the chosen holder. A usable login attempts to follow supported runs; if it cannot see the run, tracking falls back to link-only. Successful tracking reports completion to the launching thread and can post run.completed to the completion webhook when notifyWebhook is enabled. The initial response may say pending while attachment finishes; goat_cloud_agent_run_list on the holder shows the outcome. Fleet and thread lists show launchedBy. Needs a full-access caller.",
    effect: "write",
    capability: "cloud.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "Register a cloud run", idempotentHint: true, openWorldHint: true },
  }),
  "cloud_agent.run_list": entry({
    resource: "cloud_agent",
    verb: "run_list",
    name: "goat_cloud_run_list",
    toolkit: "provider",
    summary: "List cloud runs in this environment",
    description: "List cloud runs this environment follows or links, most recently updated first.",
    guide:
      "Each entry includes the provider, status, tracking mode, repository and optional link and branch; registered entries also identify their external launcher. A page holds up to limit runs (default 50); truncated means more match, and passing nextCursor as cursor with the same provider returns the next page. The query reads this environment’s stored runs, so execute it on the holder to inspect remote runs.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "List cloud runs", idempotentHint: true, openWorldHint: false },
  }),
  "cloud_agent.run_forget": entry({
    resource: "cloud_agent",
    verb: "run_forget",
    name: "goat_cloud_run_forget",
    toolkit: "provider",
    summary: "Stop tracking a registered cloud run",
    description:
      "Delete a registered cloud run’s GOAT thread and stop tracking it. The provider run keeps running; this never cancels it.",
    guide:
      "Only runs registered through goat_cloud_agent_run_register can be forgotten here; GOAT-launched runs remain ordinary threads. Register the external run again to track it anew. Needs a full-access caller.",
    effect: "destructive",
    capability: "cloud.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "Forget a cloud run", idempotentHint: true, openWorldHint: false },
  }),
} as const;
