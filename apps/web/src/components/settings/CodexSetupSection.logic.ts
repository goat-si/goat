import type { ChatGptHandoffState, ProviderAuthState, ProviderInstallState } from "@goat/contracts";

export function readCodexSetupMode(config: unknown): "managed" | "existing" {
  return config !== null &&
    typeof config === "object" &&
    "setupMode" in config &&
    config.setupMode === "managed"
    ? "managed"
    : "existing";
}

const RUNNING_INSTALL_PHASES = new Set(["downloading", "extracting", "verifying"]);

// A subscription may still carry the previous install when start returns.
export function settleProviderInstall(
  started: ProviderInstallState,
  current: ProviderInstallState | null,
): boolean | undefined {
  const state = RUNNING_INSTALL_PHASES.has(started.phase)
    ? current?.operationId === started.operationId
      ? current
      : null
    : started;
  if (state === null || RUNNING_INSTALL_PHASES.has(state.phase)) return undefined;
  return state.phase !== "failed" && state.phase !== "cancelled" && state.installedVersion !== null;
}

// Auth state is shared per instance, so only the initiating flow may open a page.
export function settleAuthorizationPage(
  state: ProviderAuthState | null,
  flowId: string | null,
): string | null | undefined {
  if (state === null || state.flowId === null) return undefined;
  if (flowId !== null && state.flowId !== flowId) return undefined;
  if (state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled")
    return null;
  if (state.phase !== "waiting") return undefined;
  const url =
    state.interaction?.type === "browser" ? state.interaction.url : state.authorizationUrl;
  return url ?? undefined;
}

export function settleHandoffAuthorizationPage(
  state: ChatGptHandoffState | null,
): string | null | undefined {
  if (state === null) return undefined;
  return state.phase === "finished" ? null : settleAuthorizationPage(state.state, null);
}
