import { ModelSelection, type ProviderDriverKind, type ProviderInstanceId } from "@goat/contracts";
import { normalizeCustomModelSlug, normalizeModelSlug } from "@goat/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeSelection = Schema.decodeUnknownOption(ModelSelection);

export function readSelections(value: object): Partial<Record<ProviderInstanceId, ModelSelection>> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([instanceId, selection]) =>
      Option.match(decodeSelection(selection), {
        onNone: () => [],
        onSome: (decoded) => [[instanceId, decoded] as const],
      }),
    ),
  );
}

export function selectionSlug(raw: string, instanceId: unknown, driver: ProviderDriverKind) {
  return instanceId === undefined ? normalizeModelSlug(raw, driver) : normalizeCustomModelSlug(raw);
}
