import type { ChannelRequester } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { readChannelBotNotes, type ChannelBotFiles } from "../channelBotNotes.ts";

export const canReadChannelBotNotes = (viewer: ChannelRequester) =>
  viewer.originKind !== "slack" || viewer.grantedScopes.includes("memory:read");

export const readNotesForRequester = (
  viewer: ChannelRequester,
  files: ChannelBotFiles,
  query: string,
) => (canReadChannelBotNotes(viewer) ? readChannelBotNotes(files, query) : Effect.succeed(""));
