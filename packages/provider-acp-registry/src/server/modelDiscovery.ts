import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import {
  type AcpSessionModeState,
  findModelConfigOption,
} from "@goat/provider-acp/server/runtimeModel";
import { flattenSelectChoices } from "@goat/provider-acp/server/sessionConfig";

import type { AcpRegistryConfigurationProbeResult, AcpRegistryLiveConfiguration } from "./probe.ts";

const PROBE_SESSION_DELETE_TIMEOUT = "5 seconds";
const MODEL_DISCOVERY_BATCH_TIMEOUT = "30 seconds";
// Large catalogs list well over a hundred models; batches let the picker fill in as they finish.
const MODEL_DISCOVERY_BATCH_SIZE = 24;

/**
 * Agents report model-specific options only for the session's current model, so the
 * probe opens each requested model once in its session to read them.
 */
export interface AcpRegistryModelDiscovery {
  /**
   * Publishes the probe result with what discovery has learned so far and answers the models
   * still to open, in priority order; asked again after each batch until none are left.
   */
  readonly onProbed: (
    result: AcpRegistryConfigurationProbeResult,
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly onDiscovered: (configuration: AcpRegistryLiveConfiguration) => Effect.Effect<void>;
}

export const discoverAcpRegistryModelOptions = Effect.fn("AcpRegistryProbe.discoverModelOptions")(
  function* (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    originalModelId: string | null,
    result: AcpRegistryConfigurationProbeResult,
    discovery: AcpRegistryModelDiscovery,
    normalizeLiveConfiguration: (
      configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      modeState?: AcpSessionModeState | undefined,
    ) => AcpRegistryLiveConfiguration,
  ) {
    const modelOption = findModelConfigOption(yield* runtime.getConfigOptions);
    if (modelOption === undefined || originalModelId === null) return;
    const offered = new Set(flattenSelectChoices(modelOption.options).map(({ value }) => value));
    const attempted = new Set([originalModelId]);
    const discoverBatches = Effect.gen(function* () {
      // Each answer is a bounded batch; asking again after it publishes progress and
      // continues, and every model is tried at most once per probe.
      while (true) {
        const modelIds = (yield* discovery.onProbed(result))
          .filter((modelId) => !attempted.has(modelId) && offered.has(modelId))
          .slice(0, MODEL_DISCOVERY_BATCH_SIZE);
        if (modelIds.length === 0) return;
        for (const modelId of modelIds) attempted.add(modelId);
        const finished = yield* Effect.forEach(
          modelIds,
          (modelId) =>
            runtime.setConfigOption(modelOption.id, modelId).pipe(
              Effect.andThen(Effect.all([runtime.getConfigOptions, runtime.getModeState])),
              Effect.flatMap(([configOptions, modeState]) => {
                const configuration = normalizeLiveConfiguration(configOptions, modeState);
                return configuration.currentModelId === modelId
                  ? discovery.onDiscovered(configuration)
                  : Effect.void;
              }),
              // A model the agent refuses keeps no options; the rest still count.
              Effect.ignore,
            ),
          { discard: true },
        ).pipe(Effect.timeoutOption(MODEL_DISCOVERY_BATCH_TIMEOUT));
        // An agent too slow for one batch is left for a later probe.
        if (Option.isNone(finished)) return;
      }
    });
    yield* discoverBatches.pipe(
      // Some agents save the selected model as the user's default. A switch that timed out
      // may still have landed while the runtime reports the original, so always resend.
      Effect.ensuring(
        Effect.suspend(() =>
          attempted.size === 1
            ? Effect.void
            : runtime
                .setConfigOption(modelOption.id, originalModelId, { resendCurrentValue: true })
                .pipe(Effect.timeoutOption(PROBE_SESSION_DELETE_TIMEOUT), Effect.ignore),
        ),
      ),
    );
  },
);
