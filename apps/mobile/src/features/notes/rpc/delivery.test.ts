import { expect, it } from "@effect/vitest";
import { NoteConflictError, NoteError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { document, edit } from "../test-fixtures";
import { deliverNoteWrite } from "./delivery";

it.effect("returns the typed conflict document without overwriting or rereading it", () =>
  Effect.gen(function* () {
    const current = document();
    const result = yield* Effect.promise(() =>
      deliverNoteWrite(
        edit,
        async () => {
          throw new NoteConflictError({ path: edit.path, current, message: "changed" });
        },
        async () => {
          throw new Error("must not read");
        },
      ),
    );
    expect(result).toEqual({ type: "conflict", current });
  }),
);
it.effect("compares an offline create that collided with an existing hub note", () =>
  Effect.gen(function* () {
    let writes = 0;
    const current = document();
    const result = yield* Effect.promise(() =>
      deliverNoteWrite(
        { ...edit, baseRevision: null },
        async () => {
          writes++;
          throw new NoteError({ reason: "exists", message: "exists" });
        },
        async (path) => {
          expect(path).toBe(edit.path);
          return current;
        },
      ),
    );
    expect(writes).toBe(1);
    expect(result).toEqual({ type: "conflict", current });
  }),
);
it.effect("retains the draft on a transport failure or when the collision cannot be read", () =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() =>
      deliverNoteWrite(
        edit,
        async () => {
          throw new NoteError({ reason: "exists", message: "exists" });
        },
        async () => {
          throw new Error("offline");
        },
      ),
    );
    expect(result).toEqual({ type: "retry", message: "offline" });
    const disconnected = yield* Effect.promise(() =>
      deliverNoteWrite(
        edit,
        async () => {
          throw new Error("connection lost");
        },
        async () => document(),
      ),
    );
    expect(disconnected).toEqual({ type: "retry", message: "connection lost" });
  }),
);
