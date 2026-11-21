import type { ChannelRequester } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { readChannelBotNotes, type ChannelBotFiles } from "../channelBotNotes.ts";

export const readNotesForRequester = (
  viewer: ChannelRequester,
  files: ChannelBotFiles,
  query: string,
) =>
  viewer.originKind !== "slack" || viewer.grantedScopes.includes("memory:read")
    ? readChannelBotNotes(files, query)
    : Effect.succeed("");
