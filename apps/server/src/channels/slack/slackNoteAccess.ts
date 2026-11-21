import type { ChannelReceptionInput, ChannelRequester } from "@goat/contracts";
import * as Effect from "effect/Effect";

export const canReadChannelBotNotes = (viewer: ChannelRequester) =>
  viewer.originKind !== "mcp" && viewer.grantedScopes.includes("memory:read");

export const recheckReceptionNotes = Effect.fn("channel.recheckReceptionNotes")(function* <E>(
  input: ChannelReceptionInput,
  liveScopes: Effect.Effect<ReadonlyArray<string>, E>,
) {
  if (
    input.requester.originKind !== "slack" ||
    !canReadChannelBotNotes(input.requester) ||
    (input.notes === undefined && input.readResults === undefined)
  )
    return input;
  if (
    yield* liveScopes.pipe(
      Effect.map((scopes) => scopes.includes("memory:read")),
      Effect.orElseSucceed(() => false),
    )
  )
    return input;
  const { notes: _notes, readResults: _results, ...withoutMemory } = input;
  return withoutMemory;
});
