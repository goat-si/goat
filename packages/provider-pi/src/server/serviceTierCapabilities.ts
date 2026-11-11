import type { ModelCapabilities, ProviderOptionChoice } from "@goat/contracts";
import { createModelCapabilities } from "@goat/shared/model";
import * as Predicate from "effect/Predicate";
import { thinkingCapabilitiesForPiModel } from "./thinkingCapabilities.ts";

export const PI_STANDARD_SERVICE_TIER = "default";
const MAX_SERVICE_TIERS = 64;

export function piModelCapabilities(
  model: unknown,
  defaultThinkingLevel: unknown,
): ModelCapabilities {
  const thinking = thinkingCapabilitiesForPiModel(model, defaultThinkingLevel);
  const tiers = Predicate.isObject(model) ? model["serviceTiers"] : undefined;
  if (!Array.isArray(tiers)) return thinking;
  const seen = new Set<string>([PI_STANDARD_SERVICE_TIER]);
  const options: ProviderOptionChoice[] = [];
  for (const tier of tiers) {
    if (options.length >= MAX_SERVICE_TIERS) break;
    if (!Predicate.isObject(tier)) continue;
    const id = tier["id"];
    if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
    seen.add(id);
    const name = tier["name"];
    const description = tier["description"];
    options.push({
      id,
      label: typeof name === "string" && name.trim() ? name : id,
      ...(typeof description === "string" && description.trim() ? { description } : {}),
    });
  }
  if (options.length === 0) return thinking;
  return createModelCapabilities({
    optionDescriptors: [
      ...(thinking.optionDescriptors ?? []),
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [{ id: PI_STANDARD_SERVICE_TIER, label: "Standard", isDefault: true }, ...options],
        currentValue: PI_STANDARD_SERVICE_TIER,
      },
    ],
  });
}
