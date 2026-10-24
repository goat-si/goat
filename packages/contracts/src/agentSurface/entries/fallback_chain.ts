import { entry } from "../entry.ts";

export const fallbackChainEntries = {
  "fallback_chain.get": entry({
    resource: "fallback_chain",
    verb: "get",
    name: "goat_fallback_chain_get",
    toolkit: "fleetResources",
    summary: "Read the configured model fallback chains and the default chain for goals.",
    description:
      "Read the configured model fallback chains and the default chain goals use when they name none. Pass id to read one chain.",
    guide:
      "The result reads settings fleet.fallbackChains and fleet.defaultFallbackChain. A chain contains ordered {instanceId, model} steps and may set on, maxHops, cooldownMs and scope. Pass id for one chain; the returned defaultFallbackChain is null when that chain is not the default.",
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
      "Create, replace, or delete one model fallback chain in server settings. When a step fails on a trigger, work switches to the next model. Chains cover goals only unless scope is goals_and_threads. Unlisted models are saved with warnings. Provider sign-ins and Codex configuration stay unchanged.",
    guide:
      "When work fails with a chain trigger, fallback tries the next eligible step and posts a thread notice. The default trigger is usage_limit. It skips steps cooling down and known exhausted other provider instances. Usage windows do not rule out another model on the same instance because that instance may route several accounts. If no step remains after a usage limit, work waits for the reset; other failures retain their existing retry or failure behavior.\n\nScope 'goals' is the default and applies only to goals. Scope 'goals_and_threads' also applies to ordinary threads whose model is a chain step. Each instanceId must be configured here. An unlisted model is saved with a warning.\n\nUse a live full-access caller in the default interaction mode, or a full-access outside client. Access is checked again inside the settings write lock. Set chain to null to delete it; makeDefault selects or clears the default for this chain.",
    effect: "destructive",
    capability: "settings.write",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "FallbackChains.set replaces or removes the chain at the supplied id and sets or clears its default selection under the settings lock; repeating those assignments leaves the same configuration.",
    annotations: {
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
} as const;
