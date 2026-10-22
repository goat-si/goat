import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { conflictNote, markNoteInFlight, type NoteOutboxRow } from "@goat/client-runtime/notes";
import {
  createNotesOutboxController,
  type NoteDelivery,
  type NotesOutboxStorage,
} from "./outbox-controller";
import { document, edit, row } from "./test-fixtures";

function memoryStorage(initial: ReadonlyArray<NoteOutboxRow> = []) {
  let disk = initial;
  let fail = false;
  const storage: NotesOutboxStorage = {
    load: async () => disk.map((row) => ({ ...row, inFlight: null })),
    save: async (row) => {
      if (fail) throw new Error("disk full");
      disk = [
        ...disk.filter(
          (entry) => entry.environmentId !== row.environmentId || entry.path !== row.path,
        ),
        row,
      ];
    },
    remove: async (row) => {
      if (fail) throw new Error("disk full");
      disk = disk.filter(
        (entry) => entry.environmentId !== row.environmentId || entry.path !== row.path,
      );
    },
  };
  return {
    storage,
    disk: () => disk,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}

describe("durable notes delivery", () => {
  it.effect(
    "persists before send and preserves an edit made while its predecessor is in flight",
    () =>
      Effect.gen(function* () {
        const memory = memoryStorage();
        const controller = createNotesOutboxController(memory.storage);
        yield* Effect.promise(() => controller.enqueue(edit));
        const started = Promise.withResolvers<void>();
        const ack = Promise.withResolvers<NoteDelivery>();
        const calls: string[] = [];
        const flush = controller.flush(
          "hub",
          async (input) => {
            calls.push(input.body);
            expect(memory.disk()[0]!.inFlight?.body).toBe(input.body);
            expect(memory.disk()[0]!.body).toBe(input.body);
            if (calls.length === 1) {
              started.resolve();
              return ack.promise;
            }
            expect(input.baseRevision).toBe(document().revision);
            return { type: "saved", note: document(input.body, "c".repeat(64)) };
          },
          () => true,
        );
        yield* Effect.promise(() => started.promise);
        yield* Effect.promise(() => controller.enqueue({ ...edit, body: "newer" }));
        expect(memory.disk()[0]!.body).toBe("newer");
        ack.resolve({ type: "saved", note: document() });
        yield* Effect.promise(() => flush);
        expect(calls).toEqual(["mine", "newer"]);
        expect(memory.disk()).toEqual([]);
        expect(controller.getSnapshot()).toEqual([]);
      }),
  );
  it.effect("does not send or publish an edit whose durable write failed", () =>
    Effect.gen(function* () {
      const memory = memoryStorage();
      memory.fail(true);
      const controller = createNotesOutboxController(memory.storage);
      const result = yield* Effect.result(Effect.tryPromise(() => controller.enqueue(edit)));
      expect(result._tag).toBe("Failure");
      let sent = false;
      yield* Effect.promise(() =>
        controller.flush(
          "hub",
          async () => {
            sent = true;
            return { type: "saved", note: document() };
          },
          () => true,
        ),
      );
      expect(sent).toBe(false);
      expect(controller.getSnapshot()).toEqual([]);
    }),
  );
  it.effect("pauses only the conflicted row and restores it across restart", () =>
    Effect.gen(function* () {
      const memory = memoryStorage();
      const controller = createNotesOutboxController(memory.storage);
      yield* Effect.promise(() => controller.enqueue(edit));
      yield* Effect.promise(() => controller.enqueue({ ...edit, path: "other.md" }));
      const sent: string[] = [];
      yield* Effect.promise(() =>
        controller.flush(
          "hub",
          async (input) => {
            sent.push(input.path);
            return input.path === "note.md"
              ? { type: "conflict", current: document() }
              : { type: "saved", note: document() };
          },
          () => true,
        ),
      );
      expect(sent).toEqual(["note.md", "other.md"]);
      const restarted = createNotesOutboxController(memory.storage);
      yield* Effect.promise(restarted.restore);
      expect(restarted.getSnapshot()).toMatchObject([{ state: "conflict", current: document() }]);
      yield* Effect.promise(() => restarted.resolve("hub", "note.md", "mine"));
      yield* Effect.promise(() =>
        restarted.flush(
          "hub",
          async (input) => {
            expect(input.baseRevision).toBe(document().revision);
            return { type: "saved", note: document(input.body) };
          },
          () => true,
        ),
      );
      expect(memory.disk()).toEqual([]);
    }),
  );
  it.effect("Use theirs durably drops the draft and does not send a write", () =>
    Effect.gen(function* () {
      const memory = memoryStorage([conflictNote(row(), document())]);
      const controller = createNotesOutboxController(memory.storage);
      yield* Effect.promise(() => controller.resolve("hub", "note.md", "theirs"));
      expect(memory.disk()).toEqual([]);
      yield* Effect.promise(() =>
        controller.flush(
          "hub",
          async () => {
            throw new Error("must not send");
          },
          () => true,
        ),
      );
    }),
  );
  it.effect(
    "keeps edits after a transport error and retries on the next flush without a busy loop",
    () =>
      Effect.gen(function* () {
        const memory = memoryStorage([row()]);
        const controller = createNotesOutboxController(memory.storage);
        let calls = 0;
        yield* Effect.promise(() =>
          controller.flush(
            "hub",
            async () => {
              calls++;
              throw new Error("offline");
            },
            () => true,
          ),
        );
        expect(calls).toBe(1);
        expect(memory.disk()[0]).toMatchObject({ body: "mine", inFlight: null });
        expect(controller.error("hub")).toBe("offline");
        yield* Effect.promise(() =>
          controller.flush(
            "hub",
            async () => ({ type: "saved", note: document() }),
            () => true,
          ),
        );
        expect(memory.disk()).toEqual([]);
      }),
  );
  it.effect("does not send when disconnected or permission was revoked", () =>
    Effect.gen(function* () {
      const memory = memoryStorage([row()]);
      const controller = createNotesOutboxController(memory.storage);
      let calls = 0;
      yield* Effect.promise(() =>
        controller.flush(
          "hub",
          async () => {
            calls++;
            return { type: "saved", note: document() };
          },
          () => false,
        ),
      );
      expect(calls).toBe(0);
      expect(memory.disk()).toHaveLength(1);
    }),
  );
  it.effect("deduplicates simultaneous flush triggers", () =>
    Effect.gen(function* () {
      const memory = memoryStorage([row()]);
      const controller = createNotesOutboxController(memory.storage);
      const done = Promise.withResolvers<NoteDelivery>();
      const send = () => done.promise;
      const first = controller.flush("hub", send, () => true);
      const second = controller.flush("hub", send, () => true);
      expect(first).toBe(second);
      done.resolve({ type: "saved", note: document() });
      yield* Effect.promise(() => first);
      expect(memory.disk()).toEqual([]);
    }),
  );
  it.effect("recovers a pending send after an acknowledgement could not persist", () =>
    Effect.gen(function* () {
      const memory = memoryStorage([markNoteInFlight(row())]);
      const controller = createNotesOutboxController(memory.storage);
      let first = true;
      const result = yield* Effect.result(
        Effect.tryPromise(() =>
          controller.flush(
            "hub",
            async () => {
              if (first) {
                memory.fail(true);
                first = false;
              }
              return { type: "saved", note: document() };
            },
            () => true,
          ),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(memory.disk()).toHaveLength(1);
      memory.fail(false);
      yield* Effect.promise(() =>
        controller.flush(
          "hub",
          async () => ({ type: "conflict", current: document() }),
          () => true,
        ),
      );
      expect(memory.disk()[0]!.state).toBe("conflict");
    }),
  );
});

it.effect("discards only the confirmed draft version and leaves a newer draft intact", () =>
  Effect.gen(function* () {
    const memory = memoryStorage([row()]);
    const controller = createNotesOutboxController(memory.storage);
    yield* Effect.promise(() => controller.enqueue({ ...edit, body: "newer" }));
    expect(yield* Effect.promise(() => controller.discard("hub", "note.md", 1))).toBe(false);
    expect(memory.disk()[0]!.body).toBe("newer");
    expect(yield* Effect.promise(() => controller.discard("hub", "note.md", 2))).toBe(true);
    expect(memory.disk()).toEqual([]);
  }),
);

it.effect("retries a conflict resolution made while another note is being sent", () =>
  Effect.gen(function* () {
    const memory = memoryStorage([row(), { ...row(), path: "other.md" }]);
    const controller = createNotesOutboxController(memory.storage);
    const otherStarted = Promise.withResolvers<void>();
    const otherAck = Promise.withResolvers<NoteDelivery>();
    const sent: string[] = [];
    const flush = controller.flush(
      "hub",
      async (input) => {
        sent.push(input.path);
        if (sent.length === 1) return { type: "conflict", current: document() };
        if (input.path === "other.md") {
          otherStarted.resolve();
          return otherAck.promise;
        }
        expect(input.baseRevision).toBe(document().revision);
        return { type: "saved", note: document(input.body) };
      },
      () => true,
    );
    yield* Effect.promise(() => otherStarted.promise);
    yield* Effect.promise(() => controller.resolve("hub", "note.md", "mine"));
    otherAck.resolve({ type: "saved", note: document() });
    yield* Effect.promise(() => flush);
    expect(sent).toEqual(["note.md", "other.md", "note.md"]);
    expect(memory.disk()).toEqual([]);
  }),
);

it.effect("replays a reconnect flush after an older in-flight send fails", () =>
  Effect.gen(function* () {
    const memory = memoryStorage([row()]);
    const controller = createNotesOutboxController(memory.storage);
    const started = Promise.withResolvers<void>();
    const oldSend = Promise.withResolvers<NoteDelivery>();
    let connected = true;
    let calls = 0;
    const send = async (): Promise<NoteDelivery> => {
      calls++;
      if (calls === 1) {
        started.resolve();
        return oldSend.promise;
      }
      return { type: "saved", note: document() };
    };
    const first = controller.flush("hub", send, () => connected);
    yield* Effect.promise(() => started.promise);
    connected = false;
    connected = true;
    const reconnect = controller.flush("hub", send, () => connected);
    oldSend.resolve({ type: "retry", message: "old connection lost" });
    yield* Effect.promise(() => Promise.all([first, reconnect]));
    expect(calls).toBe(2);
    expect(memory.disk()).toEqual([]);
  }),
);

it.effect("coalesces active foreground and manual flush requests into one bounded retry pass", () =>
  Effect.gen(function* () {
    const memory = memoryStorage([row()]);
    const controller = createNotesOutboxController(memory.storage);
    let calls = 0;
    const send = async (): Promise<NoteDelivery> => {
      calls++;
      void controller.flush("hub", send, () => true, 7);
      void controller.flush("hub", send, () => true, 7);
      return { type: "retry", message: "still unavailable" };
    };
    yield* Effect.promise(() => controller.flush("hub", send, () => true, 7));
    expect(calls).toBe(2);
    expect(memory.disk()).toHaveLength(1);
    expect(memory.disk()[0]!.inFlight).toBeNull();
  }),
);

it.effect("does not replay a queued flush after connectivity or permission is lost", () =>
  Effect.gen(function* () {
    const memory = memoryStorage([row()]);
    const controller = createNotesOutboxController(memory.storage);
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<NoteDelivery>();
    let allowed = true;
    let calls = 0;
    const send = async () => {
      calls++;
      started.resolve();
      return response.promise;
    };
    const first = controller.flush("hub", send, () => allowed);
    yield* Effect.promise(() => started.promise);
    const foreground = controller.flush("hub", send, () => allowed);
    allowed = false;
    response.resolve({ type: "retry", message: "disconnected" });
    yield* Effect.promise(() => Promise.all([first, foreground]));
    expect(calls).toBe(1);
    expect(memory.disk()).toHaveLength(1);
    allowed = true;
    yield* Effect.promise(() =>
      controller.flush(
        "hub",
        async () => ({ type: "saved", note: document() }),
        () => allowed,
      ),
    );
    expect(memory.disk()).toEqual([]);
  }),
);

it.effect("preserves a second reconnect requested during replay and coalesces its generation", () =>
  Effect.gen(function* () {
    const memory = memoryStorage([row()]);
    const controller = createNotesOutboxController(memory.storage);
    const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const responses = [
      Promise.withResolvers<NoteDelivery>(),
      Promise.withResolvers<NoteDelivery>(),
    ];
    let connected = true;
    let generation = 1;
    let calls = 0;
    const canSend = () => connected;
    const send = async (): Promise<NoteDelivery> => {
      const index = calls++;
      if (index < 2) {
        started[index]!.resolve();
        return responses[index]!.promise;
      }
      return { type: "saved", note: document() };
    };
    const first = controller.flush("hub", send, canSend, generation);
    for (let index = 0; index < 2; index++) {
      yield* Effect.promise(() => started[index]!.promise);
      connected = false;
      connected = true;
      generation++;
      expect(controller.flush("hub", send, canSend, generation)).toBe(first);
      expect(controller.flush("hub", send, canSend, generation)).toBe(first);
      responses[index]!.resolve({ type: "retry", message: "old connection lost" });
    }
    yield* Effect.promise(() => first);
    expect(calls).toBe(3);
    expect(connected).toBe(true);
    expect(memory.disk()).toEqual([]);
    expect(controller.getSnapshot()).toEqual([]);
  }),
);
