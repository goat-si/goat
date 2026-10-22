import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, type ThreadResult } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Config from "../config.ts";
import * as Notes from "./NotesService.ts";
import { notesLayer } from "./NotesTestkit.ts";

const link = { threadId: ThreadId.make("worker"), host: null, lastResult: null };
const running: ThreadResult = {
  runId: RunId.make("run"),
  runStatus: "running",
  outcome: null,
  reportedAt: null,
  pullRequests: [],
  commits: [],
  branch: null,
};
const succeeded: ThreadResult = { ...running, runStatus: "completed", outcome: "succeeded" };
const linkedFile = "---\nstatus: doing\nthreads: [worker]\n---\nwork";

it.effect.each(["delete", "remove link"] as const)(
  "reclaims a result after the last note reference disappears via %s",
  (operation) =>
    Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      for (const path of ["one.md", "two.md"]) {
        yield* notes.write({ path, body: "work", baseRevision: null }, "user");
        yield* notes.link(path, link);
      }
      const one = (yield* notes.cached("one.md"))!;
      yield* notes.delete({ path: one.path, baseRevision: one.revision });
      yield* notes.refresh;
      assert.deepStrictEqual((yield* notes.cached("two.md"))?.threads[0]?.lastResult, running);
      const two = (yield* notes.cached("two.md"))!;
      if (operation === "delete") {
        yield* notes.delete({ path: two.path, baseRevision: two.revision });
      } else {
        yield* fs.writeFileString(`${notesDir}/two.md`, "no linked worker");
        yield* notes.refresh;
      }
      yield* fs.writeFileString(`${notesDir}/replacement.md`, linkedFile);
      yield* notes.refresh;
      assert.isNull((yield* notes.cached("replacement.md"))?.threads[0]?.lastResult);
      yield* notes.refreshResults(link.threadId, null);
      assert.deepStrictEqual(
        (yield* notes.cached("replacement.md"))?.threads[0]?.lastResult,
        running,
      );
    }).pipe(Effect.provide(notesLayer(() => Effect.succeed(running)))),
);

it.effect.each(["finish", "interrupt"] as const)(
  "retains results for an in-flight lookup and reclaims them when it ends via %s",
  (operation) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let hold = false;
      yield* Effect.gen(function* () {
        const notes = yield* Notes.NotesService;
        const fs = yield* FileSystem.FileSystem;
        const { notesDir } = yield* Config.ServerConfig;
        yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
        const initial = yield* notes.link("task.md", link);
        hold = true;
        const lookup = yield* notes.read({ path: "task.md" }).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* notes.delete({ path: initial.path, baseRevision: initial.revision });
        yield* fs.writeFileString(`${notesDir}/replacement.md`, linkedFile);
        yield* notes.refresh;
        const replacement = (yield* notes.cached("replacement.md"))!;
        assert.deepStrictEqual(replacement.threads[0]?.lastResult, running);
        yield* notes.delete({ path: replacement.path, baseRevision: replacement.revision });
        if (operation === "finish") {
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(lookup);
        } else {
          yield* Fiber.interrupt(lookup);
        }
        yield* fs.writeFileString(`${notesDir}/again.md`, linkedFile);
        yield* notes.refresh;
        assert.isNull((yield* notes.cached("again.md"))?.threads[0]?.lastResult);
        yield* notes.refreshResults(link.threadId, null);
        assert.deepStrictEqual((yield* notes.cached("again.md"))?.threads[0]?.lastResult, running);
      }).pipe(
        Effect.provide(
          notesLayer(() =>
            Effect.gen(function* () {
              if (hold) {
                hold = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return succeeded;
              }
              return running;
            }),
          ),
        ),
      );
    }),
);

it.effect("an evicted completion token cannot match a reintroduced thread generation", () =>
  Effect.gen(function* () {
    const lookupEntered = yield* Deferred.make<void>();
    const lookupRelease = yield* Deferred.make<void>();
    const lookupReturned = yield* Deferred.make<void>();
    const linkEntered = yield* Deferred.make<void>();
    const linkRelease = yield* Deferred.make<void>();
    let holdLookup = true;
    let holdLink = false;
    yield* Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      yield* fs.writeFileString(`${notesDir}/task.md`, linkedFile);
      yield* notes.refresh;
      const initial = (yield* notes.cached("task.md"))!;
      const old = yield* notes.complete("task.md", link).pipe(Effect.forkScoped);
      yield* Deferred.await(lookupEntered);
      yield* notes.delete({ path: initial.path, baseRevision: initial.revision });
      yield* notes.write({ path: "task.md", body: "replacement", baseRevision: null }, "user");
      holdLink = true;
      const replacement = yield* notes.link("task.md", link).pipe(Effect.forkScoped);
      yield* Deferred.await(linkEntered);
      yield* Deferred.succeed(lookupRelease, undefined);
      yield* Deferred.await(lookupReturned);
      yield* Deferred.succeed(linkRelease, undefined);
      yield* Fiber.join(replacement);
      assert.isFalse(yield* Fiber.join(old));
      assert.strictEqual((yield* notes.cached("task.md"))?.status, "doing");
      assert.isTrue(yield* notes.complete("task.md", link, succeeded));
    }).pipe(
      Effect.provide(
        notesLayer(
          () =>
            Effect.gen(function* () {
              if (holdLookup) {
                holdLookup = false;
                yield* Deferred.succeed(lookupEntered, undefined);
                yield* Deferred.await(lookupRelease);
                yield* Deferred.succeed(lookupReturned, undefined);
              }
              return succeeded;
            }),
          undefined,
          (fs) => ({
            ...fs,
            makeTempDirectoryScoped: (options) =>
              Effect.gen(function* () {
                if (holdLink && options?.prefix === ".note-") {
                  holdLink = false;
                  yield* Deferred.succeed(linkEntered, undefined);
                  yield* Deferred.await(linkRelease);
                }
                return yield* fs.makeTempDirectoryScoped(options);
              }),
          }),
        ),
      ),
    );
  }),
);
