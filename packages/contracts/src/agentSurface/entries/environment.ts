import { entry } from "../entry.ts";

export const environmentEntries = {
  "environment.read": entry({
    resource: "environment",
    verb: "read",
    name: "goat_environment_read",
    toolkit: "environment",
    summary: "Read this server's identity and selected environment preferences.",
    description:
      "Read this server's identity and selected environment preferences, including standing instructions and project overrides. Custom instructions over 4,000 characters come back truncated. Use goat_provider_list for provider and model availability.",
    guide:
      "Returned source-control customInstructions is truncated to 4,000 Unicode characters; truncated indicates whether text was cut.\n\nGOAT prepends standingInstructions to the first message of agent-launched threads by default, through goat_thread_launch and goat_ssh_thread_launch from other machines. A launch can disable this with standingInstructions:false. Project standing instructions replace the environment policy for that project.",
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
