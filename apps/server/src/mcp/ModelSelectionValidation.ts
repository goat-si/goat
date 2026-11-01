import {
  OrchestratorMcpFailure,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";
import * as Effect from "effect/Effect";

import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";

/** Models without descriptors skip descriptor checks, but duplicate ids always fail. */
export function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

/** The destination catalog is authoritative; a model miss refreshes its instance once. */
export const checkModelSelection = Effect.fn("McpModelSelection.check")(function* (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  selection: ModelSelection,
  requested: boolean,
) {
  const providers = yield* registry.getProviders;
  let provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  if (provider === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `This GOAT has no provider instance ${selection.instanceId}; it has ${
        providers.map((entry) => entry.instanceId).join(", ") || "none"
      }. ${goatCallText("provider.list")} lists providers and models.`,
    });
  const misses = (candidate: typeof provider) =>
    requested &&
    candidate !== undefined &&
    candidate.models.length > 0 &&
    !candidate.models.some((model) => model.slug === selection.model);
  if (misses(provider)) {
    const refreshed = yield* registry.refreshInstance(provider.instanceId);
    provider = refreshed.find((entry) => entry.instanceId === selection.instanceId) ?? provider;
    if (misses(provider))
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Provider ${selection.instanceId} here does not offer model ${selection.model}, even after refreshing its model list. Pick one ${goatCallText("provider.list")} lists for it, or fix the provider's catalog and check it with ${goatCallText("provider.diagnose", `{instanceId:"${selection.instanceId}"}`)}.`,
      });
  }
  if (selection.options !== undefined) {
    const descriptors = provider.models.find((model) => model.slug === selection.model)
      ?.capabilities?.optionDescriptors;
    const invalid = invalidOptionSelections(selection.options, descriptors);
    if (invalid.length > 0)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Model ${selection.model} on provider ${selection.instanceId} rejected options: ${invalid.join(" ")}`,
      });
  }
});
