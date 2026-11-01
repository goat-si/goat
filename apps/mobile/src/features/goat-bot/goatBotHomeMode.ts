import type { GoatBotEnvironmentInput } from "@goat/client-runtime/goatBot";
import type { ChannelBotRef, GoatBotHomeClaim } from "@goat/contracts";

export type MobileHomeMode = "thread" | "bot";

export function mobileGoatBotKnown(
  environments: ReadonlyArray<Pick<GoatBotEnvironmentInput, "supportsChannelLedger">>,
  botRef: ChannelBotRef | null,
  homeClaim: GoatBotHomeClaim | null = null,
): boolean {
  return (
    homeClaim !== null ||
    botRef !== null ||
    environments.some((environment) => environment.supportsChannelLedger)
  );
}

export function effectiveHomeMode(
  preference: MobileHomeMode | undefined,
  botKnown: boolean,
): MobileHomeMode {
  return botKnown && preference === "bot" ? "bot" : "thread";
}

/** A saved legacy bot owns its environment even while that computer is unavailable. */
export function pickMobileGoatBotEnvironment(
  environments: ReadonlyArray<GoatBotEnvironmentInput>,
  botRef: ChannelBotRef | null,
): GoatBotEnvironmentInput | null {
  if (botRef !== null) {
    return (
      environments.find((environment) => environment.environmentId === botRef.environmentId) ?? null
    );
  }
  return (
    [...environments]
      .filter((environment) => environment.connected && environment.supportsChannelLedger)
      .sort(
        (left, right) =>
          (left.label ?? left.environmentId).localeCompare(right.label ?? right.environmentId) ||
          left.environmentId.localeCompare(right.environmentId),
      )[0] ?? null
  );
}

/** Child detail pages still belong to the workspace stack above Home. */
export function mobileGoatBotDetailOpen(state: {
  readonly index: number;
  readonly routes: ReadonlyArray<{ readonly name: string }>;
}): boolean {
  const homeIndex = state.routes.findIndex((route) => route.name === "Home");
  return homeIndex < 0 ? state.routes[state.index] !== undefined : state.index > homeIndex;
}

/** A sheet's card descendants share its presentation envelope. */
export function mobileGoatBotWorkspaceVisible(presentations: ReadonlyArray<string | undefined>) {
  return presentations.every(
    (presentation) =>
      presentation === "formSheet" ||
      presentation === "transparentModal" ||
      presentation === "containedTransparentModal",
  );
}
