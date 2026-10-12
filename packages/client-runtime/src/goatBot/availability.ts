import {
  compareGoatBotHomeClaims,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type ThreadId,
} from "@t3tools/contracts";
import { pickGoatBotHomeCandidate, resolveGoatBotHome, type GoatBotHomeTarget } from "./home.ts";

/** One machine as GOAT Bot sees it. */
export interface GoatBotEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly supportsChannelLedger: boolean;
  /** Answers `channel.getBotStatus`; older servers are paged with `listTasks`. */
  readonly supportsBotStatus?: boolean;
  readonly primary: boolean;
  readonly label?: string;
  readonly homeTarget?: GoatBotHomeTarget;
  readonly settingsSnapshot?: object | null;
}

export interface GoatBotRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Where asking the server for its bot stands on the current connection. */
export type GoatBotEnsureState =
  | { readonly state: "idle" }
  | { readonly state: "pending" }
  | { readonly state: "confirmed"; readonly bot: GoatBotRef }
  | { readonly state: "legacy_active" }
  | { readonly state: "failed"; readonly message: string };

export type GoatBotAvailability =
  | { readonly kind: "unsupported" }
  | { readonly kind: "offline"; readonly environmentId: EnvironmentId }
  | { readonly kind: "home_offline"; readonly environmentId: EnvironmentId; readonly label: string }
  | { readonly kind: "connecting"; readonly environmentId: EnvironmentId }
  | { readonly kind: "legacy_active"; readonly environmentId: EnvironmentId }
  | { readonly kind: "error"; readonly environmentId: EnvironmentId; readonly message: string }
  | { readonly kind: "ready"; readonly bot: GoatBotRef };

/** Resolve home before selecting an environment; absent capabilities preserve old-server behavior. */
export function resolveGoatBotHomeSelection(
  environments: ReadonlyArray<GoatBotEnvironmentInput>,
  botRef: GoatBotRef | null,
) {
  const targets = environments.flatMap((entry) => (entry.homeTarget ? [entry.homeTarget] : []));
  const resolution = resolveGoatBotHome({ targets });
  const primary = environments.find((entry) => entry.primary);
  const candidateId = pickGoatBotHomeCandidate({
    targets,
    knownBotEnvironmentId: botRef?.environmentId ?? null,
    primaryEnvironmentId: primary?.environmentId ?? null,
  });
  // A primary that runs the bot but predates home claims keeps it while nothing is claimed;
  // a newer remote must not take the bot over, nor leave it unavailable.
  const legacyPrimary =
    resolution.state !== "claimed" &&
    candidateId === null &&
    primary?.supportsChannelLedger === true &&
    primary.homeTarget?.supportsHome !== true;
  const supported = !legacyPrimary && targets.some((target) => target.supportsHome);
  return { targets, supported, resolution, candidateId };
}

/** A machine whose server config has not arrived yet may still turn out to support the bot. */
export function goatBotSupportUnknown(environment: GoatBotEnvironmentInput | null): boolean {
  return environment?.homeTarget !== undefined && !environment.homeTarget.settingsLoaded;
}

/**
 * Whether the home server itself holds the winning claim. Another server can publish the claim
 * first; until the home reads it back, an ensure there would pass its unset-home gate.
 */
export function goatBotHomeReadBack(
  selection: Pick<ReturnType<typeof resolveGoatBotHomeSelection>, "targets" | "resolution">,
): boolean {
  const { resolution } = selection;
  if (resolution.state !== "claimed") return false;
  const home = selection.targets.find(
    (target) => target.environmentId === resolution.claim.environmentId,
  )?.home;
  return (
    home != null &&
    home.environmentId === resolution.claim.environmentId &&
    compareGoatBotHomeClaims(home, resolution.claim) === 0
  );
}

/**
 * The machine GOAT Bot lives on: the one a known bot belongs to, else the
 * primary machine. Only a client with no primary takes the first machine that
 * supports the bot, so the bot never lands on a remote by itself.
 */
export function pickGoatBotEnvironment(
  environments: ReadonlyArray<GoatBotEnvironmentInput>,
  botRef: GoatBotRef | null,
): GoatBotEnvironmentInput | null {
  const { supported, resolution, candidateId } = resolveGoatBotHomeSelection(environments, botRef);
  if (supported) {
    const environmentId =
      resolution.state === "claimed" ? resolution.claim.environmentId : candidateId;
    return environments.find((entry) => entry.environmentId === environmentId) ?? null;
  }
  if (botRef !== null) {
    const known = environments.find((entry) => entry.environmentId === botRef.environmentId);
    if (known) return known;
  }
  return (
    environments.find((entry) => entry.primary) ??
    environments.find((entry) => entry.supportsChannelLedger) ??
    null
  );
}

/**
 * Whether GOAT Bot can take messages right now. A remembered bot is not
 * enough: the server must support channels and have confirmed the bot on
 * this connection. Running work never makes the bot unavailable.
 */
export function resolveGoatBotAvailability(input: {
  readonly environments: ReadonlyArray<GoatBotEnvironmentInput>;
  readonly botRef: GoatBotRef | null;
  readonly ensure: GoatBotEnsureState;
}): GoatBotAvailability {
  const { supported, resolution, candidateId } = resolveGoatBotHomeSelection(
    input.environments,
    input.botRef,
  );
  if (supported) {
    if (resolution.state === "claimed" && !resolution.homeConnected) {
      const environmentId = resolution.claim.environmentId;
      return {
        kind: "home_offline",
        environmentId,
        label:
          input.environments.find((entry) => entry.environmentId === environmentId)?.label ??
          environmentId,
      };
    }
    if (resolution.state !== "claimed") {
      const primary = input.environments.find((entry) => entry.primary);
      // A loaded primary that cannot be home leaves nothing to claim; Settings can pick a remote.
      if (candidateId === null && primary?.connected && primary.homeTarget?.settingsLoaded)
        return { kind: "unsupported" };
      const environmentId =
        candidateId ??
        primary?.environmentId ??
        input.environments.find((entry) => entry.homeTarget?.supportsHome)?.environmentId;
      if (environmentId === undefined) return { kind: "unsupported" };
      const waitingOn = input.environments.find((entry) => entry.environmentId === environmentId);
      return waitingOn?.connected === false
        ? { kind: "offline", environmentId }
        : { kind: "connecting", environmentId };
    }
  }
  const environment = pickGoatBotEnvironment(input.environments, input.botRef);
  if (environment === null) return { kind: "unsupported" };
  const { environmentId } = environment;
  if (!environment.supportsChannelLedger) {
    if (!goatBotSupportUnknown(environment)) return { kind: "unsupported" };
    return environment.connected
      ? { kind: "connecting", environmentId }
      : { kind: "offline", environmentId };
  }
  if (!environment.connected) return { kind: "offline", environmentId };
  switch (input.ensure.state) {
    case "legacy_active":
      return { kind: "legacy_active", environmentId };
    case "failed":
      return { kind: "error", environmentId, message: input.ensure.message };
    case "confirmed":
      return input.ensure.bot.environmentId === environmentId
        ? { kind: "ready", bot: input.ensure.bot }
        : { kind: "connecting", environmentId };
    default:
      return { kind: "connecting", environmentId };
  }
}

export function canSendToGoatBot(availability: GoatBotAvailability, canOperate: boolean): boolean {
  return availability.kind === "ready" && canOperate;
}

/** Servers from before GOAT Bot do not advertise channel support. */
export function environmentSupportsChannelLedger(
  capabilities: ExecutionEnvironmentCapabilities | undefined,
): boolean {
  return capabilities?.channelLedger === true;
}

/** How the bot thread on screen was taken away, if it was. */
/** "unchecked" means the archived-thread check failed, so the chat may or may not still be the bot. */
export type GoatBotRemoval = "archived" | "deleted" | "unchecked" | null;

/**
 * An archived bot is still the bot and comes back by unarchiving it. A deleted one is replaced by
 * the server on the next ensure. Active shells disappear for both removals, so wait for the
 * archived snapshot before distinguishing them. An unseen shell may still be on its way.
 */
export function resolveGoatBotRemoval(input: {
  readonly shell: object | null;
  readonly shellSeen: boolean;
  /** null until the archived snapshot has loaded successfully. */
  readonly archived: boolean | null;
  readonly bootstrapped: boolean;
  readonly confirmedHere: boolean;
}): GoatBotRemoval {
  if (
    input.shell !== null ||
    !input.bootstrapped ||
    !input.confirmedHere ||
    input.archived === null
  )
    return null;
  if (input.archived) return "archived";
  return input.shellSeen ? "deleted" : null;
}
