import { RepositoryReferenceRequest, RepositoryReferences } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeRead = Schema.decodeUnknownEffect(Schema.toCodecJson(RepositoryReferenceRequest), {
  onExcessProperty: "error",
});
const decodeReferences = Schema.decodeUnknownEffect(Schema.toCodecJson(RepositoryReferences), {
  onExcessProperty: "error",
});

/** Validate authority-bearing nested fields before the tool codec can discard unknown keys. */
export const validateRepositoryReferenceArguments = (name: string, payload: unknown) => {
  if (name === "goat_repository_snapshot") return decodeRead(payload).pipe(Effect.asVoid);
  if (
    (name === "goat_thread_launch" || name === "goat_ssh_thread_launch") &&
    typeof payload === "object" &&
    payload !== null &&
    "references" in payload &&
    payload.references != null
  ) {
    return decodeReferences(payload.references).pipe(Effect.asVoid);
  }
  return Effect.void;
};
