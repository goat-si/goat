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
  "environment.settings_read": entry({
    resource: "environment",
    verb: "settings_read",
    name: "goat_environment_settings_read",
    toolkit: "environment",
    summary: "List every server setting with who may change it, and the values agents may change.",
    description:
      "List every server setting of this environment: access agent (value shown; change it with goat_environment_settings_update), path (the path that owns it) or person (only a person changes it, with the reason). keys limits the list and adds each key's input schema.",
    guide:
      "Values come from the same redacted snapshot GOAT's clients receive, and only for agent keys. A key without a value, such as setModelFavorites, is an action applied by an update. Ask for keys to get each one's JSON input schema before writing it.\n\nClient settings such as fonts, notifications and sidebar layout live on each device and are not listed.",
    parameters: {
      keys: "Setting keys to read, each with its input schema. Omit for every key without schemas.",
    },
    examples: [
      {
        title: "Read one setting with its schema",
        args: { keys: ["branchNamePrefix"] },
      },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
  "environment.settings_update": entry({
    resource: "environment",
    verb: "settings_update",
    name: "goat_environment_settings_update",
    toolkit: "environment",
    summary: "Change server settings agents may change, through normal settings persistence.",
    description:
      "Change server settings in one atomic patch. patch maps setting keys to the values Settings would send. Only keys goat_environment_settings_read lists with access agent are accepted; others are refused with the path that owns them or the reason a person must change them.",
    guide:
      "Use a live full-access/default calling thread, or a full-access client with live settings:write, checked again inside the settings write lock. Values decode exactly as the Settings page sends them, and nested objects merge the same way. Nothing is written when any key is refused or any value fails to decode. The result lists the changed keys with their new values.",
    parameters: {
      patch:
        "Setting keys with their new values, for example {branchNamePrefix:'goat/'}. goat_environment_settings_read with keys returns each key's schema.",
    },
    examples: [
      {
        title: "Set the branch name prefix",
        args: { patch: { branchNamePrefix: "goat/" } },
      },
    ],
    effect: "destructive",
    capability: "settings.write",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "The handler applies the supplied values through the settings service; repeating the same patch leaves the same settings, except action keys such as setModelFavorites, which apply again.",
    annotations: {
      idempotentHint: false,
      openWorldHint: false,
    },
  }),
} as const;
