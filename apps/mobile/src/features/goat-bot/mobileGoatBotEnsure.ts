import {
  settleGoatBotEnsure,
  type GoatBotEnsureMachine,
  type GoatBotEnsureResult,
} from "@t3tools/client-runtime/goatBot";
import type { EnvironmentId } from "@t3tools/contracts";

export interface MobileGoatBotEnsureDestination {
  readonly environmentId: EnvironmentId | null;
  readonly connectionKey: string | null;
}

/** Per-environment tokens cannot authorize an obsolete selected destination. */
export function settleMobileGoatBotEnsure(
  machine: GoatBotEnsureMachine,
  token: number,
  result: GoatBotEnsureResult,
  request: MobileGoatBotEnsureDestination,
  live: MobileGoatBotEnsureDestination | null,
): GoatBotEnsureMachine {
  if (
    request.environmentId === null ||
    request.connectionKey === null ||
    live?.environmentId !== request.environmentId ||
    live.connectionKey !== request.connectionKey ||
    machine.generation !== request.connectionKey ||
    (result.kind === "confirmed" && result.bot.environmentId !== request.environmentId)
  ) {
    return machine;
  }
  return settleGoatBotEnsure(machine, token, result);
}

/** One constructor for request generation and live settle validation. */
export function goatBotSessionKey(input: {
  readonly environmentId: EnvironmentId | null;
  readonly generation: number | null;
  readonly homeKey: string;
}): string | null {
  return input.environmentId === null || input.generation === null
    ? null
    : `${input.environmentId}:${input.generation}:channel:${input.homeKey}`;
}

export interface MobileGoatBotNotHome {
  readonly homeKey: string;
  readonly settingsSnapshot: object | null;
}

/** A retry click or reconnect is not evidence that a not_home refusal changed. */
export function mobileGoatBotWaitingForHome(
  refusal: MobileGoatBotNotHome | null,
  homeKey: string,
  settingsSnapshot: object | null,
): boolean {
  return (
    refusal !== null && refusal.homeKey === homeKey && refusal.settingsSnapshot === settingsSnapshot
  );
}
