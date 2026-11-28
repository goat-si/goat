import type { ModelSelection, ModelCapabilities } from "@goat2/contracts-rs";
import type { ModelRef } from "@opencode/client";
import { variantCapabilities } from "../opencode/variant.ts";

// Adapted from v2/modelRef.ts and variant.ts at 916b5ccc1b.
export type { ModelRef };
export const openCodeVariant = (selection: ModelSelection): string | undefined => {
  const value = selection.options?.find((option) => option.id === "variant")?.value;
  return typeof value === "string" && value !== "goat:default" ? value : undefined;
};

export function modelRef(selection: ModelSelection, listedVariants: ReadonlySet<string> | undefined): ModelRef | undefined {
  const slug = selection.model.trim();
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return undefined;
  const selected = openCodeVariant(selection);
  const variant = selected === undefined || listedVariants === undefined || listedVariants.has(selected) ? selected : undefined;
  return { providerID: slug.slice(0, separator), id: slug.slice(separator + 1), ...(variant === undefined ? {} : { variant }) };
}

export const malformedModel = (model: string) => `OpenCode model '${model}' must use provider/model format`;
export const sameModel = (left: ModelRef, right: ModelRef | undefined): boolean =>
  left.providerID === right?.providerID && left.id === right?.id && (left.variant ?? "default") === (right?.variant ?? "default");

// GOAT 2 already owns the same v1 catalog projection for OpenCode 1.x.
export const modelVariantCapabilities = (provider: string, variants: string[]): ModelCapabilities | null =>
  variantCapabilities(provider, variants);
