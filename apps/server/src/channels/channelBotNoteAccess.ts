import type { ChannelReceptionInput, ChannelRequester } from "@goat/contracts";
import * as Effect from "effect/Effect";

export const canReadChannelBotNotes = (viewer: ChannelRequester) =>
  viewer.originKind !== "mcp" && viewer.grantedScopes.includes("memory:read");

export const recheckReceptionNotes = Effect.fn("channel.recheckReceptionNotes")(function* <E>(
  input: ChannelReceptionInput,
  liveViewer: Effect.Effect<ChannelRequester, E>,
) {
  if (
    input.notes === undefined &&
    (input.readResults === undefined || !canReadChannelBotNotes(input.requester))
  )
    return input;
  if (
    yield* liveViewer.pipe(
      Effect.map(canReadChannelBotNotes),
      Effect.orElseSucceed(() => false),
    )
  )
    return input;
  const { notes: _notes, readResults: _results, ...withoutMemory } = input;
  return withoutMemory;
});
