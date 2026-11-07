import * as M from "@goat/contracts";
import { resolveMemoryModelSelection } from "@goat/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Hold from "./MemoryGenerationHold.ts";

const decodeSelection = Schema.decodeUnknownEffect(M.MemoryModelSelection);

/** Sync status fields only an opted-in request may carry: a strict legacy decoder rejects them. */
export const readSyncStatusOptIns = Effect.fn("MemorySyncService.readStatusOptIns")(function* <
  E,
>(input: {
  readonly request: M.MemorySyncStatusInput;
  readonly settings: M.ServerSettings;
  readonly hold: Hold.MemoryGenerationHold["Service"];
  readonly failures: Effect.Effect<M.MemorySyncStatus["generationFailure"], E>;
}) {
  const { settings, hold } = input;
  const request: { includeGenerationHold?: true; includeGenerationFailure?: true } = input.request;
  const selected = settings.memoryEnabled ? resolveMemoryModelSelection(settings, undefined) : null;
  const model =
    selected === null
      ? Option.none<M.MemoryModelSelection>()
      : yield* decodeSelection(selected).pipe(Effect.option);
  const generationHold =
    request.includeGenerationHold && Option.isSome(model)
      ? yield* hold.status(yield* hold.keyFor(model.value))
      : undefined;
  const failure = request.includeGenerationFailure ? yield* input.failures : undefined;
  return {
    ...(generationHold ? { generationHold } : {}),
    ...(failure ? { generationFailure: failure } : {}),
  };
});
