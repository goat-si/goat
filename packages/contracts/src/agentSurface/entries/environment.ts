import { entry } from "../entry.ts";

export const environmentEntries = {
  "environment.read": entry({
    resource: "environment",
    verb: "read",
    name: "goat_environment_read",
    toolkit: "environment",
    summary: "Read this server's identity and selected environment preferences.",
    description:
      "Read this server's identity and selected environment preferences. Provider/model availability is exposed by goat_provider_list. Writing instructions are limited to 4,000 characters. standingInstructions is the policy GOAT prepends to the first message of every thread an agent launches here (goat_thread_launch, and goat_ssh_thread_launch from other machines); projectStandingInstructions replaces it for those projects.",
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
      "Update selected environment-wide preferences through normal settings persistence and notifications. Requires a live full-access/default calling thread. Omitted fields are preserved; empty customInstructions clears them. Empty standingInstructions clears them. In projectStandingInstructions, a project's text replaces the environment's for threads launched in that project (empty turns them off there) and null removes the override.",
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
