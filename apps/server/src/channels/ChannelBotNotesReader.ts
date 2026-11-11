/**
 * Reads GOAT Bot's notes file for the Memory tab. The file is the one reception appends to and
 * workers edit by hand (channelBotNotes.ts); this module only reads it.
 *
 * @module ChannelBotNotesReader
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the revision matches channelNotesRevision's sha-256.
import * as NodeCrypto from "node:crypto";

import {
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelGatewayError,
  type ChannelBotNote,
  type ChannelListBotNotesResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import { parseChannelBotNoteLines, type ChannelBotNoteLine } from "./channelBotNoteLines.ts";
import { channelBotNoteSources } from "./channelBotNoteSources.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import { readChannelBotNotesTail, type NotesTailHooks } from "./channelBotNotesTail.ts";

const TAIL_BYTES = 64 * 1024;

/** Every line read, replaced ones included and marked, so a client can show or hide them. */
const toNotes = (
  lines: ReadonlyArray<ChannelBotNoteLine>,
  sourceOf: (inputId: string) => NonNullable<ChannelBotNote["source"]>,
): ReadonlyArray<ChannelBotNote> =>
  lines.map(({ index, id, date, text, replaces, replacedBy, sourceInputId }) => ({
    index,
    id,
    date,
    text,
    ...(replaces === undefined ? {} : { replaces }),
    ...(replacedBy === undefined ? {} : { replacedBy }),
    ...(sourceInputId === undefined ? {} : { source: sourceOf(sourceInputId) }),
  }));

export type ReaderOptions = NotesTailHooks;

export class ChannelBotNotesReader extends Context.Service<
  ChannelBotNotesReader,
  {
    readonly list: (
      viewer: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelListBotNotesResult, ChannelGatewayError>;
  }
>()("goat/channels/ChannelBotNotesReader") {}

export const make = Effect.fn("ChannelBotNotesReader.make")(function* (
  options: ReaderOptions = {},
) {
  const path = yield* Path.Path;
  const home = yield* ChannelBotHome.ChannelBotHome;
  const sql = yield* SqlClient.SqlClient;
  const files = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);

  const list = Effect.fn("ChannelBotNotesReader.list")(function* (viewer: ChannelConnectionOwner) {
    yield* home.requireHome;
    const read = yield* readChannelBotNotesTail(files.notes, TAIL_BYTES, options);
    if (read === null) return { revision: null, notes: [], truncated: false };
    const lines = parseChannelBotNoteLines(new TextDecoder().decode(read.bytes));
    const sourceOf = yield* channelBotNoteSources(
      viewer,
      lines.flatMap((line) => (line.sourceInputId === undefined ? [] : [line.sourceInputId])),
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const notes = toNotes(lines, sourceOf);
    return {
      revision: NodeCrypto.createHash("sha256").update(read.bytes).digest("hex"),
      notes: notes.toReversed(),
      truncated: read.truncated,
    };
  });

  return ChannelBotNotesReader.of({ list });
});

export const layer = Layer.effect(ChannelBotNotesReader, make());

export const rpcHandlers = (
  service: ChannelBotNotesReader["Service"],
  viewer: ChannelConnectionOwner,
) => ({
  [CHANNEL_GATEWAY_WS_METHODS.listBotNotes]: () => service.list(viewer),
});
