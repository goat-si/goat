import { ModelSelection, type ProviderInstanceId } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeSelection = Schema.decodeUnknownOption(ModelSelection);

export function normalizePersistedModelSelections(
  value: object,
): Partial<Record<ProviderInstanceId, ModelSelection>> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([instanceId, selection]) =>
      Option.match(decodeSelection(selection), {
        onNone: () => [],
        onSome: (decoded) => [[instanceId, decoded] as const],
      }),
    ),
  );
}
