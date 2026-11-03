import type { EnvironmentId } from "@goat/contracts";

let disposeSession: ((environmentId: EnvironmentId) => void) | undefined;

export function registerGoatBotEnvironmentDisposal(
  dispose: (environmentId: EnvironmentId) => void,
) {
  disposeSession = dispose;
}

export function disposeGoatBotEnvironment(environmentId: EnvironmentId) {
  disposeSession?.(environmentId);
}
