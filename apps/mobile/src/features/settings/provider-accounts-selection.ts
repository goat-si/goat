import {
  isProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@goat/contracts";

/** Route params for a `provider.setup` handoff. Omitted fields leave the screen unfiltered. */
export type ProviderAccountsRouteParams = {
  readonly environmentId?: EnvironmentId;
  readonly driver?: string;
  readonly instanceId?: ProviderInstanceId;
};

type ProviderAccountCandidate = {
  readonly instanceId: string;
  readonly driver: string;
  readonly auth?: { readonly status?: string };
};

/**
 * Accounts to show for a setup handoff. The named instance stays in the list
 * even without in-app sign-in, and is ordered first so the screen opens on it.
 */
export function selectProviderAccounts<T extends ProviderAccountCandidate>(
  providers: readonly T[],
  selection: Pick<ProviderAccountsRouteParams, "driver" | "instanceId"> | undefined,
  include: (provider: T) => boolean,
): { readonly accounts: readonly T[]; readonly highlighted: T | null } {
  const highlighted =
    selection?.driver || selection?.instanceId ? highlightProvider(providers, selection) : null;
  const accounts = providers.filter((provider) => include(provider) || provider === highlighted);
  if (!highlighted) return { accounts, highlighted: null };
  return {
    accounts: [highlighted, ...accounts.filter((provider) => provider !== highlighted)],
    highlighted,
  };
}

function highlightProvider<T extends ProviderAccountCandidate>(
  providers: readonly T[],
  selection: Pick<ProviderAccountsRouteParams, "driver" | "instanceId">,
): T | null {
  if (selection.instanceId) {
    const match = providers.find((provider) => provider.instanceId === selection.instanceId);
    if (match) return match;
  }
  if (!selection.driver) return null;
  const sameDriver = providers.filter((provider) => provider.driver === selection.driver);
  return (
    sameDriver.find((provider) => provider.auth?.status !== "authenticated") ??
    sameDriver[0] ??
    null
  );
}

/** Puts the handoff's environment first. An unknown id leaves the list unchanged. */
export function orderEnvironmentsForProviderSetup<T extends { readonly environmentId: string }>(
  targets: readonly T[],
  environmentId: string | undefined,
): readonly T[] {
  if (!environmentId) return targets;
  const index = targets.findIndex((target) => target.environmentId === environmentId);
  if (index <= 0) return targets;
  return [targets[index]!, ...targets.slice(0, index), ...targets.slice(index + 1)];
}

export function providerSetupLabel(
  selection: Pick<ProviderAccountsRouteParams, "driver" | "instanceId"> | undefined,
): string | null {
  const driver = selection?.driver;
  if (driver && isProviderDriverKind(driver)) return PROVIDER_DISPLAY_NAMES[driver] ?? driver;
  if (driver) return driver;
  return selection?.instanceId ?? null;
}

export function providerSetupPrompt(input: {
  readonly foundLabel: string | null;
  readonly requestedLabel: string | null;
}): string {
  if (input.foundLabel) return `Set up ${input.foundLabel}.`;
  if (input.requestedLabel)
    return `${input.requestedLabel} isn't on this environment yet. Add it in web or desktop Settings, then sign in here.`;
  return "The agent asked you to set up a provider on this environment.";
}
