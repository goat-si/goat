import { assert, it } from "@effect/vitest";
import { goatBotChangeNoteMessage, goatBotForgetNoteMessage } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  defaultScript,
  goatInput,
  makeHarness,
  onlyTask,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const note = 'Call the build "green" only when (all) checks pass.';

it.effect.each([
  ["forget", goatBotForgetNoteMessage(note)],
  ["change", goatBotChangeNoteMessage(note, "Call it green when CI passes.")],
] as const)(
  "the %s message a client prefills lets reception hand the quoted note to a worker",
  ([kind, message]) => {
    const harness = makeHarness();
    // The model quotes the note from the person's message, as the reception contract asks.
    harness.script.current = (input) =>
      input.mode === "input"
        ? Effect.succeed({
            replyText: "On it.",
            action: {
              type: "create_task",
              title: "Update a note",
              instruction: "Update the requested note.",
              notesChangeRequested: note,
            },
          })
        : defaultScript(input);
    return Effect.gen(function* () {
      yield* setupBot;
      yield* (yield* ChannelGateway.ChannelGateway).ingest(
        goatInput(message, "note-" + kind),
        rpcContext,
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      assert.strictEqual((yield* onlyTask).notesChangeRequested, note);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  },
);
