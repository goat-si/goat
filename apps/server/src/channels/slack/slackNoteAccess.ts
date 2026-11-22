import type { ChannelReceptionInput, ChannelRequester } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { readChannelBotNotes, type ChannelBotFiles } from "../channelBotNotes.ts";

export const canReadChannelBotNotes = (viewer: ChannelRequester) =>
  viewer.originKind !== "slack" || viewer.grantedScopes.includes("memory:read");

export const readNotesForRequester = (
  viewer: ChannelRequester,
  files: ChannelBotFiles,
  query: string,
) => (canReadChannelBotNotes(viewer) ? readChannelBotNotes(files, query) : Effect.succeed(""));

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
