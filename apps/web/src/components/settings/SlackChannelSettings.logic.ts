/**
 * When the Slack section can offer controls for the selected environment. The server
 * owns the tokens and the socket; until it advertises `slackChannel`, the section only
 * explains why it is unavailable.
 */
export type SlackSettingsAvailability =
  | "no_environment"
  | "offline"
  | "unsupported"
  | "read_only"
  | "ready";

export function slackSettingsAvailability(input: {
  readonly environmentSelected: boolean;
  readonly connected: boolean;
  /** `capabilities.slackChannel`; absent on servers without the Slack adapter. */
  readonly slackChannel: boolean | undefined;
  readonly canConfigure: boolean;
}): SlackSettingsAvailability {
  if (!input.environmentSelected) return "no_environment";
  if (!input.connected) return "offline";
  if (input.slackChannel !== true) return "unsupported";
  if (!input.canConfigure) return "read_only";
  return "ready";
}

export function slackSettingsUnavailableMessage(
  availability: SlackSettingsAvailability,
): string | undefined {
  switch (availability) {
    case "no_environment":
      return "Choose an environment to connect Slack.";
    case "offline":
      return "Connect to this environment to manage Slack.";
    case "unsupported":
      return "Slack isn't available on this environment's server yet.";
    case "read_only":
      return "This connection can't change Slack settings.";
    case "ready":
      return undefined;
  }
}
