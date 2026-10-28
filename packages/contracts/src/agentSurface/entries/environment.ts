import { entry } from "../entry.ts";

export const environmentEntries = {
  "environment.usage": entry({
    resource: "environment",
    verb: "usage",
    name: "goat_environment_usage",
    toolkit: "environment",
    summary: "Read bounded provider usage for this environment.",
    description:
      "Read bounded provider usage for this environment. Requires an explicit diagnostics:read client grant and live reauthorization.",
    guide:
      "Returns usage buckets, source status and pricing for at most 31 inclusive days, with at most 256 buckets and 32 sources within 256 KiB. truncated marks omitted rows or cut metadata. Only outside MCP clients with an explicit diagnostics:read grant and live reauthorization may call this. GOAT thread credentials are refused, including full-access threads. Reads stay on this host.",
    parameters: {
      sinceDay: "First day, YYYY-MM-DD, inclusive.",
      untilDay: "Last day, YYYY-MM-DD, inclusive; at most 31 days after counting sinceDay.",
      timeZone: "IANA time zone for usage buckets.",
      resolution: "day (default) or hour.",
      sinceTime: "Start instant required for hourly resolution.",
      untilTime: "End instant required for hourly resolution; at most 24 hours after sinceTime.",
      awaitRefresh: "Wait for a fresh provider scan when true.",
    },
    examples: [
      {
        title: "Read bounded provider usage for this environment.",
        args: { sinceDay: "2026-01-01", untilDay: "2026-01-07", timeZone: "UTC" },
      },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "client",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
  "environment.read": entry({
    resource: "environment",
    verb: "read",
    name: "goat_environment_read",
    toolkit: "environment",
    summary: "Read this server's identity and selected environment preferences.",
    description:
      "Read this server's identity and selected environment preferences, including standing instructions and project overrides. Custom instructions over 4,000 characters come back truncated. Use goat_provider_list for provider and model availability.",
    guide:
      "Returned source-control customInstructions is truncated to 4,000 Unicode characters; truncated indicates whether text was cut.\n\nGOAT prepends standingInstructions to the first message of agent-launched threads by default, through goat_thread_launch and goat_ssh_thread_launch from other machines. A launch can disable this with standingInstructions:false. Project standing instructions replace the environment policy for that project.\n\nA non-null automationHold means this server runs on a nightly app's copy of another app's data: its scheduled tasks, channel bots, goal and Fleet dispatch, and hub and remote links stay paused until a person chooses Resume automation on this app in Settings.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "environment.preferences_update": entry({
    resource: "environment",
    verb: "preferences_update",
    name: "goat_environment_preferences_update",
    toolkit: "environment",
    summary:
      "Update selected environment-wide preferences through normal settings persistence and notifications.",
    description:
      "Update selected environment-wide preferences, including standing instructions and their project overrides.",
    guide:
      "Use a live full-access/default calling thread or a full-access client. Omitted fields stay unchanged. Empty customInstructions or standingInstructions clears that text.\n\nIn projectStandingInstructions, project text replaces the environment policy for launches in that project. An empty string disables it there; null removes the override and restores inheritance.\n\nUpdates go through normal settings persistence and change notifications.",
    effect: "destructive",
    capability: "settings.write",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "The handler assigns supplied preference values and sets or removes project standing-instruction overrides by project id; repeating the same patch leaves the same preferences.",
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
