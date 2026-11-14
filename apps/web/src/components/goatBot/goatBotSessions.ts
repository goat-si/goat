import {
  goatBotHomeReadBack,
  goatBotSupportUnknown,
  pickGoatBotEnvironment,
  resolveGoatBotAvailability,
  resolveGoatBotAvailabilityBeforeEnsure,
  resolveGoatBotHomeSelection,
  type GoatBotAvailability,
  type GoatBotEnsureState,
  type GoatBotEnsureMachine,
  type GoatBotEnvironmentInput,
  type GoatBotRef,
  type GoatBotSendQueue,
} from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { create } from "zustand";

import type { GoatBotDraftAttachment } from "./goatBotAttachments";
import type { GoatBotChannelPort } from "./goatBotChannelPort";

export interface GoatBotSession {
  readonly homeKey: string;
  readonly notHome: { readonly homeKey: string; readonly settingsSnapshot: object | null } | null;
  readonly connected: boolean;
  readonly capability: boolean;
  readonly generation: number;
  readonly machine: GoatBotEnsureMachine;
  readonly port: GoatBotChannelPort | null;
  readonly canOperate: boolean;
  readonly legacyAutoRetried: boolean;
  readonly queue: GoatBotSendQueue<GoatBotDraftAttachment>;
  /** Conversation threads of member bots a chat here confirmed active; their messages may send. */
  readonly members: ReadonlySet<string>;
}

/** One ensure and send queue per environment, outliving every view that reads it. */
export const useGoatBotSessions = create<{
  sessions: ReadonlyMap<EnvironmentId, GoatBotSession>;
  revision: number;
}>(() => ({ sessions: new Map(), revision: 0 }));

export function updateGoatBotSession(environmentId: EnvironmentId, session: GoatBotSession) {
  useGoatBotSessions.setState((state) => ({
    sessions: new Map(state.sessions).set(environmentId, session),
  }));
}

export function goatBotHomeKey(home: ReturnType<typeof resolveGoatBotHomeSelection>): string {
  return !home.supported
    ? "legacy"
    : home.resolution.state === "claimed"
      ? `${home.resolution.claim.environmentId}:${home.resolution.claim.claimedAt}:${home.resolution.claim.claimId}`
      : home.resolution.state;
}

/** An ensure may start only once the home server holds the winning claim. */
export function goatBotHomeReady(home: ReturnType<typeof resolveGoatBotHomeSelection>): boolean {
  return !home.supported || goatBotHomeReadBack(home);
}

/** A not_home refusal holds the ensure until the claim or the server's settings change. */
export function goatBotNotHomeHolds(
  session: GoatBotSession | undefined,
  homeKey: string,
  settingsSnapshot: object | null,
): boolean {
  return (
    session?.notHome != null &&
    session.notHome.homeKey === homeKey &&
    session.notHome.settingsSnapshot === settingsSnapshot
  );
}

export function goatBotEnabled(
  port: GoatBotChannelPort | null,
  environment: GoatBotEnvironmentInput | null,
): boolean {
  return (
    port !== null &&
    (environment?.supportsChannelLedger === true || goatBotSupportUnknown(environment))
  );
}

/** Whether this client offers GOAT Bot at all, given the machines it sees. */
export function goatBotEnabledFor(
  port: GoatBotChannelPort | null,
  environments: ReadonlyArray<GoatBotEnvironmentInput>,
  home: ReturnType<typeof resolveGoatBotHomeSelection>,
  environment: GoatBotEnvironmentInput | null,
): boolean {
  return home.supported
    ? port !== null &&
        (home.resolution.state === "claimed" ||
          environments.some((entry) => entry.supportsChannelLedger))
    : goatBotEnabled(port, environment);
}

type MainAvailabilityInput = {
  readonly port: GoatBotChannelPort | null;
  readonly environments: ReadonlyArray<GoatBotEnvironmentInput>;
  readonly botRef: GoatBotRef | null;
  readonly session: GoatBotSession | undefined;
};

/** The ensure recorded for the current connection; idle when there is none. */
function recordedEnsure(
  { port, session }: MainAvailabilityInput,
  homeKey: string,
  environment: GoatBotEnvironmentInput | null,
): GoatBotEnsureState {
  return session?.connected === environment?.connected &&
    session?.capability === environment?.supportsChannelLedger &&
    session?.port === port &&
    session.homeKey === homeKey
    ? session.machine.ensure
    : { state: "idle" };
}

/** The main bot's availability: what enables its chat, its Home button and its Home panel. */
export function goatBotMainAvailability(input: MainAvailabilityInput): GoatBotAvailability {
  const { port, environments, botRef } = input;
  const home = resolveGoatBotHomeSelection(environments, botRef);
  const environment = pickGoatBotEnvironment(environments, botRef);
  if (!goatBotEnabledFor(port, environments, home, environment)) return { kind: "unsupported" };
  return resolveGoatBotAvailability({
    environments,
    botRef,
    ensure: recordedEnsure(input, goatBotHomeKey(home), environment),
  });
}

/**
 * The computer whose bot Home governs Threads: its Home is openable, or will be once its chat
 * confirms the bot. Everything before the ensure is checked in every state, including the Home
 * read-back and a held not_home refusal; only then does an ensure not started, in flight or
 * confirmed pass. Failed and legacy_active do not.
 */
export function goatBotGoverningEnvironmentId(input: MainAvailabilityInput): EnvironmentId | null {
  const { port, environments, botRef, session } = input;
  const home = resolveGoatBotHomeSelection(environments, botRef);
  const environment = pickGoatBotEnvironment(environments, botRef);
  if (!goatBotEnabledFor(port, environments, home, environment)) return null;
  const before = resolveGoatBotAvailabilityBeforeEnsure({ environments, botRef });
  if (before.kind !== "ensure") return null;
  const homeKey = goatBotHomeKey(home);
  if (
    !goatBotHomeReady(home) ||
    goatBotNotHomeHolds(session, homeKey, environment?.settingsSnapshot ?? null)
  )
    return null;
  const ensure = recordedEnsure(input, homeKey, environment);
  if (ensure.state === "idle" || ensure.state === "pending") return before.environmentId;
  return resolveGoatBotAvailability({ environments, botRef, ensure }).kind === "ready"
    ? before.environmentId
    : null;
}
