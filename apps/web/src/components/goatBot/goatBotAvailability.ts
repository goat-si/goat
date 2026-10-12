import type { EnvironmentId, ExecutionEnvironmentCapabilities, ThreadId } from "@t3tools/contracts";

/** One machine as GOAT Bot sees it. */
export interface GoatBotEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly supportsChannelLedger: boolean;
  readonly primary: boolean;
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
  | { readonly kind: "connecting"; readonly environmentId: EnvironmentId }
  | { readonly kind: "legacy_active"; readonly environmentId: EnvironmentId }
  | { readonly kind: "error"; readonly environmentId: EnvironmentId; readonly message: string }
  | { readonly kind: "ready"; readonly bot: GoatBotRef };

/**
 * The machine GOAT Bot lives on: the one a known bot belongs to, else the
 * primary machine when it supports the bot, else the first one that does.
 */
export function pickGoatBotEnvironment(
  environments: ReadonlyArray<GoatBotEnvironmentInput>,
  botRef: GoatBotRef | null,
): GoatBotEnvironmentInput | null {
  if (botRef !== null) {
    const known = environments.find((entry) => entry.environmentId === botRef.environmentId);
    if (known) return known;
  }
  return (
    environments.find((entry) => entry.primary && entry.supportsChannelLedger) ??
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
  const environment = pickGoatBotEnvironment(input.environments, input.botRef);
  if (environment === null || !environment.supportsChannelLedger) return { kind: "unsupported" };
  const { environmentId } = environment;
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
