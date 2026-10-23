import { entry } from "../entry.ts";

export const fallbackChainEntries = {
  "fallback_chain.get": entry({
    resource: "fallback_chain",
    verb: "get",
    name: "goat_fallback_chain_get",
    toolkit: "fleetResources",
    summary: "Read the configured model fallback chains and the default chain for goals.",
    description:
      "Read the model fallback chains in settings fleet.fallbackChains (ordered {instanceId, model} steps, on, maxHops, cooldownMs, scope) and fleet.defaultFallbackChain, the chain goals use when they name none. Pass id for one chain.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
  "fallback_chain.set": entry({
    resource: "fallback_chain",
    verb: "set",
    name: "goat_fallback_chain_set",
    toolkit: "fleetResources",
    summary: "Create, replace, or delete one model fallback chain.",
    description:
      "Create, replace, or delete one model fallback chain. When work fails with one of the chain's triggers (default usage_limit), it moves to the next step that is not cooling down or out of quota, with a notice on the thread, instead of waiting for the reset; with no step left it waits as before. scope 'goals' (default) applies the chain to goals only; 'goals_and_threads' also moves ordinary threads whose model is a step. Each instanceId must be configured here; a model the instance does not list is saved with a warning. Chains only choose a model selection and never change provider sign-ins or Codex configuration. Needs a full-access caller.",
    effect: "destructive",
    capability: "settings.write",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
} as const;
