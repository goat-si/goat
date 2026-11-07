import {
  BotId,
  ChannelGatewayError,
  ChannelKind,
  ChannelRequester,
  type ChannelBotNoteSource,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";

const QUERY_IDS = 200;
const ELSEWHERE: ChannelBotNoteSource = { kind: "elsewhere" };
const decodeRequester = Schema.decodeUnknownOption(Schema.fromJsonString(ChannelRequester));
const decodeKind = Schema.decodeUnknownOption(ChannelKind);

interface InboxRow {
  readonly input_id: string;
  readonly kind: string;
  readonly bot_id: string;
  readonly requester_json: string | null;
  readonly accepted_at: string;
}

/**
 * Where each note's input came from, as this caller may see it: details for the person who asked
 * or a caller who reads every bot thread (orchestration:read), "elsewhere" otherwise, and for an
 * input this owner does not have. No id is returned with "elsewhere".
 */
export const channelBotNoteSources = Effect.fn("ChannelBotNoteSources.lookup")(function* (
  viewer: ChannelConnectionOwner,
  inputIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const seesAll = viewer.grantedScopes.includes("orchestration:read");
  const sources = new Map<string, ChannelBotNoteSource>();
  const unique = [...new Set(inputIds)];
  for (let start = 0; start < unique.length; start += QUERY_IDS) {
    const rows = yield* sql<InboxRow>`SELECT input_id, kind, bot_id, requester_json, accepted_at
      FROM channel_inbox
      WHERE owner_id = ${viewer.ownerId} AND input_id IN ${sql.in(unique.slice(start, start + QUERY_IDS))}`.pipe(
      Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })),
    );
    for (const row of rows) {
      const requester = decodeRequester(row.requester_json);
      const channel = decodeKind(row.kind);
      if (Option.isNone(requester) || Option.isNone(channel)) continue;
      if (!seesAll && requester.value.principalId !== viewer.principalId) continue;
      sources.set(row.input_id, {
        kind: "shown",
        inputId: row.input_id,
        channel: channel.value,
        botId: BotId.make(row.bot_id),
        from: requester.value.displayName,
        at: row.accepted_at,
      });
    }
  }
  return (inputId: string) => sources.get(inputId) ?? ELSEWHERE;
});
