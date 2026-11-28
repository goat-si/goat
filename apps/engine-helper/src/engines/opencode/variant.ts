import type { ModelCapabilities } from "@goat2/contracts-rs";
// Adapted from variant.ts:8-49 at 916b5ccc1b2.
export function variantCapabilities(provider: string, variants: string[]): ModelCapabilities | null {
  if (variants.length === 0) return null;
  const inferred = variants.length === 1 ? variants[0]
    : provider === "anthropic" || provider.startsWith("google") ? (variants.includes("high") ? "high" : undefined)
    : ["openai", "opencode", "opencode-go"].includes(provider) ? (variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined) : undefined;
  const options = variants.map((id) => ({ id, label: id === "xhigh" ? "Extra High" : id.split(/[-_/]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "), ...(id === inferred ? { isDefault: true } : {}) }));
  return { optionDescriptors: [{ id: "variant", label: "Reasoning", type: "select", options: inferred ? options : [{ id: "goat:default", label: "Default" }, ...options], currentValue: inferred ?? "goat:default" }] };
}
