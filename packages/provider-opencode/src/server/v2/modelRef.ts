import { Model, Provider } from "@opencode/client/effect";
import { getModelSelectionStringOptionValue } from "@goat/shared/model";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
export type ModelRef = ReturnType<typeof Model.Ref.make>;

export const modelRef = (
  selection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"],
  listedVariants: ReadonlySet<string> | undefined,
) => {
  const parsed = OpenCodeRuntime.parseOpenCodeModelSlug(selection.model);
  if (parsed === null) return undefined;
  const selected = getModelSelectionStringOptionValue(selection, "variant");
  const variant =
    selected === undefined || listedVariants === undefined || listedVariants.has(selected)
      ? selected
      : undefined;
  return Model.Ref.make({
    providerID: Provider.ID.make(parsed.providerID),
    id: Model.ID.make(parsed.modelID),
    ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
  });
};
export const malformedModel = (model: string) =>
  `OpenCode model '${model}' must use provider/model format`;
export const sameModel = (left: ModelRef, right: ModelRef | undefined) =>
  left.providerID === right?.providerID &&
  left.id === right?.id &&
  (left.variant ?? "default") === (right?.variant ?? "default");
