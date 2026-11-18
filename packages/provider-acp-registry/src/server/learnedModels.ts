import type { ServerProvider, ServerProviderModel } from "@goat/contracts";
import { createModelCapabilities } from "@goat/shared/model";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { AcpRegistryLiveConfiguration } from "./probe.ts";

interface Learned {
  readonly environmentKey: string;
  /** Raised whenever the entry starts over, for another environment or after a clear. */
  readonly generation: number;
  /** A check, or an update with its own model list, has run under this environment. */
  readonly verified: boolean;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly configuration: AcpRegistryLiveConfiguration | undefined;
}

const nothingLearned: Learned = {
  environmentKey: "",
  generation: 0,
  verified: false,
  models: [],
  configuration: undefined,
};

const NO_OPTIONS = createModelCapabilities({ optionDescriptors: [] });
/** The snapshot without any options, for an environment that has nothing verified yet. */
const forget = (provider: ServerProvider): ServerProvider => ({
  ...provider,
  models: provider.models.map((model) => ({ ...model, capabilities: NO_OPTIONS })),
});

/** A check in flight: the generation it saw before it read its environment. */
export interface LearnedModelsCheck {
  readonly generation: number;
}

/**
 * Refreshes rebuild the snapshot from the probe, so what sessions taught is kept here for one
 * environment: the models a check or session last produced under it and the configuration a
 * session last reported under it. Nothing from another environment is built on or shown.
 */
export const makeAcpRegistryLearnedModels = Effect.fn("makeAcpRegistryLearnedModels")(function* (
  merge: (
    provider: ServerProvider,
    configuration: AcpRegistryLiveConfiguration,
    previousModels: ReadonlyArray<ServerProviderModel>,
  ) => ServerProvider,
) {
  const learnedRef = yield* Ref.make(nothingLearned);
  return {
    /** Taken by a check before it reads its environment. */
    generation: Ref.get(learnedRef).pipe(Effect.map((learned) => learned.generation)),
    /**
     * With `check`, `provider` was just built by that check under `environmentKey`; otherwise it
     * is the published snapshot, which may still come from an earlier environment.
     */
    apply: (
      provider: ServerProvider,
      reported: AcpRegistryLiveConfiguration | undefined,
      environmentKey: string,
      check: LearnedModelsCheck | undefined,
    ) =>
      Ref.modify(learnedRef, (learned): [ServerProvider, Learned] => {
        const known = learned.environmentKey === environmentKey;
        // The entry moved to another environment after this check began, so the check's own
        // environment is no longer current: it leaves the entry alone and shows nothing learned.
        if (check !== undefined && !known && check.generation < learned.generation) {
          return [provider, learned];
        }
        const current: Learned = known
          ? learned
          : { ...nothingLearned, environmentKey, generation: learned.generation + 1 };
        // The coordinator keeps one configuration per instance, so it can hold a late one from a
        // session under another environment; this environment's last one still applies.
        const configuration =
          reported !== undefined &&
          (reported.environmentKey === undefined || reported.environmentKey === environmentKey)
            ? reported
            : current.configuration;
        if (check === undefined && !current.verified) {
          // Until this environment is checked, the published models may be another's: an update
          // that lists its own models stands alone, and any other clears them and waits.
          if (configuration === undefined || configuration.models.length === 0) {
            return [forget(provider), { ...current, configuration }];
          }
          const next = merge(provider, configuration, []);
          return [next, { ...current, verified: true, models: next.models, configuration }];
        }
        const base =
          check !== undefined && !(current.verified && current.configuration !== undefined)
            ? provider.models
            : current.models;
        if (configuration === undefined) {
          return [provider, { ...current, verified: true, models: base }];
        }
        const next = merge(provider, configuration, base);
        return [
          next,
          {
            ...current,
            verified: true,
            models: next.models === provider.models ? base : next.models,
            configuration,
          },
        ];
      }),
    clear: Ref.update(learnedRef, (learned) => ({
      ...nothingLearned,
      generation: learned.generation + 1,
    })),
  };
});
