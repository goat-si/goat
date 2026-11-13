import { forgetNewBotEnvironment } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";

let disposeSession: ((environmentId: EnvironmentId) => void) | undefined;

export function registerGoatBotEnvironmentDisposal(
  dispose: (environmentId: EnvironmentId) => void,
) {
  disposeSession = dispose;
}

export function disposeGoatBotEnvironment(environmentId: EnvironmentId) {
  // A New bot create, from the roster or the palette, ends with its environment.
  forgetNewBotEnvironment(environmentId);
  disposeSession?.(environmentId);
}
