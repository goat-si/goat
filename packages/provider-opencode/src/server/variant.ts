import type { ModelSelection, ProviderOptionDescriptor } from "@goat/contracts";
import { DEFAULT_VARIANT_CHOICE_ID, getModelSelectionStringOptionValue } from "@goat/shared/model";

export function openCodeVariant(selection: ModelSelection): string | undefined {
  const value = getModelSelectionStringOptionValue(selection, "variant");
  return value === DEFAULT_VARIANT_CHOICE_ID ? undefined : value;
}

export function openCodeVariantDescriptors(
  provider: string,
  variants: ReadonlyArray<string>,
): ProviderOptionDescriptor[] {
  if (variants.length === 0) return [];
  const inferred =
    variants.length === 1
      ? variants[0]
      : provider === "anthropic" || provider.startsWith("google")
        ? variants.includes("high")
          ? "high"
          : undefined
        : ["openai", "opencode", "opencode-go"].includes(provider)
          ? variants.includes("medium")
            ? "medium"
            : variants.includes("high")
              ? "high"
              : undefined
          : undefined;
  const options = variants.map((id) => ({
    id,
    label:
      id === "xhigh"
        ? "Extra High"
        : id
            .split(/[-_/]+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" "),
    ...(id === inferred ? { isDefault: true } : {}),
  }));
  return [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options:
        inferred === undefined
          ? [{ id: DEFAULT_VARIANT_CHOICE_ID, label: "Default" }, ...options]
          : options,
      currentValue: inferred ?? DEFAULT_VARIANT_CHOICE_ID,
    },
  ];
}
