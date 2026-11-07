import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelBotNote,
  ChannelListBotNotesResult,
  type ChannelBotNote as ChannelBotNoteType,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { appendChannelBotNote, channelBotFilesFor } from "./channelBotNotes.ts";
import { channelBotWorkRpcHandlers } from "./channelBotWorkRpc.ts";
import { inputIdFor } from "./channelIds.ts";
import {
  defaultScript,
  goatInput,
  makeHarness,
  owner,
  ownerId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const remembering = () => {
  const harness = makeHarness();
  harness.script.current = (input) => {
    if (input.mode !== "input") return defaultScript(input);
    const text = input.inputText ?? "";
    const fix = text.startsWith("Actually");
    return Effect.succeed({
      replyText: "Got it.",
      action: { type: "report_only" },
      remember: fix ? "I deploy on Mondays." : "I deploy on Fridays.",
      rememberQuote: text,
      ...(fix ? { replacesNote: "I deploy on Fridays." } : {}),
    });
  };
  return harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
};

const say = (text: string, key: string) =>
  Effect.gen(function* () {
    yield* (yield* ChannelGateway.ChannelGateway).ingest(goatInput(text, key), rpcContext);
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
  });

const notesAs = (viewer: ChannelConnectionOwner) =>
  Effect.gen(function* () {
    const handlers = yield* channelBotWorkRpcHandlers(viewer);
    return (yield* handlers[CHANNEL_GATEWAY_WS_METHODS.listBotNotes]()).notes;
  });

const files = Effect.gen(function* () {
  const path = yield* Path.Path;
  return channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);
});

const byText = (notes: ReadonlyArray<ChannelBotNoteType>, text: string) =>
  notes.find((note) => note.text === text);

/** A row for the input id in the conversation the first message opened, as reception stores one. */
const inboxRow = (inputId: string, rowOwner: string, requesterJson: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [opened] = yield* sql<{ readonly conversation_id: string; readonly binding_id: string }>`
      SELECT conversation_id, binding_id FROM channel_inbox LIMIT 1`;
    if (opened === undefined) return yield* Effect.die("send a message first");
    yield* sql`INSERT INTO channel_inbox (input_id, owner_id, kind, connection_id, idempotency_key,
      content_hash, conversation_id, binding_id, message_json, requester_json, state, accepted_at)
      VALUES (${inputId}, ${rowOwner}, 'slack', 'slack-1', ${inputId}, 'h', ${opened.conversation_id},
        ${opened.binding_id}, '{}', ${requesterJson}, 'replied', '2026-11-07T07:00:00.000Z')`;
  });

const slackRequester = JSON.stringify({
  ownerId,
  principalId: "owner",
  displayName: "Owner",
  originKind: "slack",
  grantedScopes: [],
  runtimeModeCeiling: "approval-required",
});

describe("GOAT Bot note sources in listBotNotes", () => {
  it.effect("shows where each note came from to its asker and to a reader of all threads", () =>
    Effect.gen(function* () {
      yield* setupBot;
      yield* say("Remember I deploy on Fridays", "first");
      yield* say("Actually I deploy on Mondays", "second");
      const asker = { ...owner, grantedScopes: ["memory:read" as const] };
      const reader = { ...owner, principalId: "someone-else" };
      for (const viewer of [asker, reader]) {
        const notes = yield* notesAs(viewer);
        const mondays = byText(notes, "I deploy on Mondays.");
        const fridays = byText(notes, "I deploy on Fridays.");
        assert.deepStrictEqual(mondays?.source, {
          kind: "shown",
          inputId: inputIdFor({ ...goatInput("", "second"), ownerId }),
          channel: "goat",
          botId: BotId.make("main"),
          from: rpcContext.displayName,
          at: mondays?.source?.kind === "shown" ? mondays.source.at : "",
        });
        assert.strictEqual(fridays?.replacedBy, mondays?.index);
        assert.strictEqual(
          fridays?.source?.kind === "shown" && fridays.source.inputId,
          inputIdFor({ ...goatInput("", "first"), ownerId }),
        );
      }
    }).pipe(Effect.provide(remembering())),
  );

  it.effect("says elsewhere, without the id, to another person who may not read all threads", () =>
    Effect.gen(function* () {
      yield* setupBot;
      yield* say("Remember I deploy on Fridays", "first");
      const stranger = {
        ...owner,
        principalId: "someone-else",
        grantedScopes: ["memory:read" as const],
      };
      const [note] = yield* notesAs(stranger);
      assert.deepStrictEqual(note?.source, { kind: "elsewhere" });
    }).pipe(Effect.provide(remembering())),
  );

  it.effect(
    "says elsewhere for another owner's input, an unreadable requester and a missing row",
    () =>
      Effect.gen(function* () {
        yield* setupBot;
        yield* say("Hello", "opener");
        const fs = yield* FileSystem.FileSystem;
        const notesFile = yield* files;
        yield* inboxRow("in-other-owner", "environment:other", slackRequester);
        yield* inboxRow("in-null", ownerId, null);
        yield* inboxRow("in-bad", ownerId, "{not json");
        for (const id of ["in-other-owner", "in-null", "in-bad", "in-missing"]) {
          yield* appendChannelBotNote(
            fs,
            notesFile,
            "Note " + id + ".",
            "2026-11-07T07:00:00Z",
            id,
          );
        }
        yield* fs.writeFileString(notesFile.notes, "Written by hand\n", { flag: "a" });
        const notes = yield* notesAs(owner);
        for (const id of ["in-other-owner", "in-null", "in-bad", "in-missing"]) {
          assert.deepStrictEqual(byText(notes, "Note " + id + ".")?.source, { kind: "elsewhere" });
        }
        assert.notProperty(byText(notes, "Written by hand"), "source");
      }).pipe(Effect.provide(remembering())),
  );

  it.effect("finds the source of every note when there are more than one query's worth", () =>
    Effect.gen(function* () {
      yield* setupBot;
      yield* say("Hello", "opener");
      const fs = yield* FileSystem.FileSystem;
      const notesFile = yield* files;
      for (let index = 0; index < 201; index++) {
        yield* inboxRow("in-" + index, ownerId, slackRequester);
        yield* appendChannelBotNote(
          fs,
          notesFile,
          "Note " + index + ".",
          "2026-11-07T07:00:00Z",
          "in-" + index,
        );
      }
      const notes = yield* notesAs(owner);
      // The opener saved one more note through reception.
      assert.lengthOf(notes, 202);
      assert.isTrue(notes.every((note) => note.source?.kind === "shown"));
    }).pipe(Effect.provide(remembering())),
  );

  it.effect("fails instead of listing notes without sources when the lookup fails", () =>
    Effect.gen(function* () {
      yield* setupBot;
      yield* say("Remember I deploy on Fridays", "first");
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`ALTER TABLE channel_inbox RENAME TO channel_inbox_gone`,
      );
      const error = yield* Effect.flip(notesAs(owner));
      assert.strictEqual(error.reason, "persistence_failed");
    }).pipe(Effect.provide(remembering())),
  );
});

// The notes result as a client built before sources decodes it.
const decodeOldResult = Schema.decodeUnknownSync(
  Schema.Struct({
    ...ChannelListBotNotesResult.fields,
    notes: Schema.Array(
      Schema.Struct({
        index: ChannelBotNote.fields.index,
        date: ChannelBotNote.fields.date,
        text: ChannelBotNote.fields.text,
      }),
    ),
  }),
);

describe("GOAT Bot note sources on the wire", () => {
  it("a client built before sources reads a result that has them", () => {
    const decoded = decodeOldResult({
      revision: null,
      truncated: false,
      notes: [{ index: 0, date: null, text: "x", source: { kind: "elsewhere" } }],
    });
    assert.deepStrictEqual(decoded.notes, [{ index: 0, date: null, text: "x" }]);
  });
});
