import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, WsNotesRpcGroup, WS_METHODS } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Auth from "../../../auth/RpcAuthorization.ts";
import * as Notes from "../../../notes/NotesService.ts";
import { notesLayer, testScope } from "../../../notes/NotesTestkit.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { NoteToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";

const readGroup = WsNotesRpcGroup.omit(
  WS_METHODS.notesList,
  WS_METHODS.notesRead,
  WS_METHODS.notesWrite,
  WS_METHODS.notesMove,
  WS_METHODS.notesDelete,
  WS_METHODS.notesStartWork,
  WS_METHODS.notesWorkTargets,
  WS_METHODS.notesWorkTargetProjects,
);

it.effect(
  "MCP checkbox writes immediately reach a notes.subscribe RPC stream and stale revisions fail",
  () =>
    Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const original = yield* notes.write(
        { path: "task.md", body: "- [ ] task\n", baseRevision: null },
        "user",
      );
      const client = yield* RpcTest.makeClient(readGroup).pipe(
        Effect.provide(
          Layer.merge(
            readGroup.toLayer({ [WS_METHODS.notesSubscribe]: () => notes.subscribe }),
            Auth.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      const ready = yield* Deferred.make<void>();
      const stream = yield* client[WS_METHODS.notesSubscribe]({}).pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Stream.filter((event) => event.type === "upserted"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      const toolkit = yield* NoteToolkit.pipe(
        Effect.provide(Access.HandlersLayer.layer(Handlers.layer)),
      );
      const written = yield* toolkit
        .handle("goat_note_write", {
          path: original.path,
          body: "- [x] task\n",
          baseRevision: original.revision,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      const document = written.at(-1)!.result;
      assert.isTrue("revision" in document);
      const received = yield* Fiber.join(stream);
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0]!.type, "upserted");
      if (received[0]!.type === "upserted" && "revision" in document) {
        assert.strictEqual(received[0]!.note.revision, document.revision);
        assert.strictEqual(received[0]!.note.updatedBy, "agent");
      }
      const stale = yield* notes
        .write({ path: original.path, body: "stale", baseRevision: original.revision }, "user")
        .pipe(Effect.flip);
      assert.strictEqual(stale._tag, "NoteConflictError");
      if (stale._tag === "NoteConflictError")
        assert.strictEqual(stale.current.body, "- [x] task\n");
      const refused = yield* toolkit
        .handle("goat_note_write", {
          path: original.path,
          body: "stale",
          baseRevision: original.revision,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      const failure = refused.at(-1)!.result;
      assert.isTrue("code" in failure);
      if ("code" in failure) {
        assert.strictEqual(failure.code, "invalid_request");
        assert.include(failure.message, "goat_note_read");
      }
      assert.strictEqual((yield* notes.read({ path: original.path })).body, "- [x] task\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          notesLayer(),
          liveThreadsLayer,
          Layer.succeed(Invocation.McpInvocationContext, testScope),
        ),
      ),
    ),
);

it.effect("read-only MCP callers can read notes and cannot write or move them", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const original = yield* notes.write(
      { path: "task.md", body: "task", baseRevision: null },
      "user",
    );
    const toolkit = yield* NoteToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer)),
    );
    const read = yield* toolkit
      .handle("goat_note_read", { path: original.path })
      .pipe(Stream.unwrap, Stream.runCollect);
    assert.isTrue("body" in read.at(-1)!.result);
    const write = yield* toolkit
      .handle("goat_note_write", {
        path: original.path,
        body: "changed",
        baseRevision: original.revision,
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    const move = yield* toolkit
      .handle("goat_note_move", {
        from: original.path,
        to: "other.md",
        baseRevision: original.revision,
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    for (const result of [write, move]) {
      const failure = result.at(-1)!.result;
      assert.isTrue("code" in failure);
      if ("code" in failure) assert.strictEqual(failure.code, "capability_denied");
    }
    assert.strictEqual((yield* notes.read({ path: original.path })).revision, original.revision);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        notesLayer(),
        liveThreadsLayer,
        Layer.succeed(Invocation.McpInvocationContext, {
          ...testScope,
          client: { ...testScope.client, access: "read-only" },
        }),
      ),
    ),
  ),
);
