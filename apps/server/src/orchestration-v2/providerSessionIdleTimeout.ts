import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
// Without native resume, a released session comes back as a summary of the thread, so it stays longer.
const NO_NATIVE_RESUME_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** How long an idle session stays open; a configured timeout applies to every provider. */
export const makeIdleTimeout =
  (configuredMs: number | undefined) =>
  (runtime: Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "providerSession">) =>
    Math.max(
      1,
      configuredMs ??
        // A runtime that omits providerSession must reach the typed turn-start failure, not throw here.
        (runtime.providerSession?.capabilities.turns.supportsNativeResume === true
          ? DEFAULT_IDLE_TIMEOUT_MS
          : NO_NATIVE_RESUME_IDLE_TIMEOUT_MS),
    );
