/**
 * GOAT's own Settings pages. Kept apart from upstream's SettingsPageTarget so neither union
 * grows past TypeScript's 25-member limit for discriminated route params.
 */
export type GoatSettingsPageTarget =
  | "SettingsGoatBot"
  | "SettingsHubNodes"
  | "SettingsDecisionInbox";
