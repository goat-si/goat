// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "./DocumentText.ts";

const layer = Layer.merge(
  ServerConfig.layerTest(process.cwd(), { prefix: "goat-document-concurrency-" }),
  DocumentText.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

describe("document extraction concurrency", () => {
  it.effect.each(["interrupted", "failed"])(
    "extracts two documents at once and frees a slot when one is %s",
    (outcome) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const [first, second, third] = ["first", "second", "third"].map((name) =>
          NodePath.join(config.attachmentsDir, `${name}.rtf`),
        );
        NodeFS.writeFileSync(first!, String.raw`{\rtf1 First}`);
        NodeFS.writeFileSync(second!, "invalid document");
        NodeFS.writeFileSync(third!, String.raw`{\rtf1 Third}`);
        const started = yield* Queue.unbounded<string>();
        const releases = new Map<string, Deferred.Deferred<void>>();
        for (const path of [first!, second!, third!])
          releases.set(path, yield* Deferred.make<void>());
        yield* Effect.gen(function* () {
          const documents = yield* DocumentText.DocumentText;
          const leaving = yield* documents.ensure(first!).pipe(Effect.forkChild);
          const staying = yield* documents.ensure(first!).pipe(Effect.forkChild);
          const freed = yield* documents.ensure(second!).pipe(Effect.forkChild);
          expect(new Set([yield* Queue.take(started), yield* Queue.take(started)])).toEqual(
            new Set([first, second]),
          );
          const waiting = yield* documents.ensure(third!).pipe(Effect.forkChild);
          yield* Fiber.interrupt(leaving);
          if (outcome === "interrupted") yield* Fiber.interrupt(freed);
          else {
            yield* Deferred.succeed(releases.get(second!)!, undefined);
            expect(yield* Fiber.join(freed)).toBeUndefined();
          }
          expect(yield* Queue.take(started)).toBe(third);
          yield* Deferred.succeed(releases.get(first!)!, undefined);
          yield* Deferred.succeed(releases.get(third!)!, undefined);
          expect(yield* Fiber.join(staying)).toBe(first + ".txt");
          expect(yield* Fiber.join(waiting)).toBe(third + ".txt");
          expect(yield* Queue.size(started)).toBe(0);
          expect(NodeFS.existsSync(second + ".txt")).toBe(false);
          expect(
            NodeFS.readdirSync(config.attachmentsDir).filter((file) => file.endsWith(".part")),
          ).toEqual([]);
        }).pipe(
          Effect.provide(Layer.fresh(DocumentText.layer)),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (file) =>
              Effect.gen(function* () {
                yield* Queue.offer(started, file);
                yield* Deferred.await(releases.get(file)!);
                return yield* fs.stat(file);
              }),
          }),
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("retries a document while its cancelled extraction is still publishing", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = NodePath.join(config.attachmentsDir, "retried.rtf");
      NodeFS.writeFileSync(path, String.raw`{\rtf1 Retried}`);
      const writing = yield* Deferred.make<void>();
      const writeReleased = yield* Deferred.make<void>();
      const renaming = yield* Deferred.make<void>();
      const renameReleased = yield* Deferred.make<void>();
      let writes = 0;
      let renames = 0;
      yield* Effect.gen(function* () {
        const documents = yield* DocumentText.DocumentText;
        const cancelled = yield* documents.ensure(path).pipe(Effect.forkChild);
        yield* Deferred.await(writing);
        const interrupting = yield* Fiber.interrupt(cancelled).pipe(Effect.forkChild);
        const retry = yield* documents.ensure(path).pipe(Effect.forkChild);
        yield* Deferred.await(renaming);
        yield* Deferred.succeed(writeReleased, undefined);
        yield* Fiber.join(interrupting);
        yield* Deferred.succeed(renameReleased, undefined);
        expect(yield* Fiber.join(retry)).toBe(path + ".txt");
        expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe("Retried");
        expect(
          NodeFS.readdirSync(config.attachmentsDir).filter((file) => file.endsWith(".part")),
        ).toEqual([]);
      }).pipe(
        Effect.provide(Layer.fresh(DocumentText.layer)),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (file, data) =>
            Effect.gen(function* () {
              if (++writes === 1) {
                yield* Deferred.succeed(writing, undefined);
                yield* Deferred.await(writeReleased);
              }
              return yield* fs.writeFileString(file, data);
            }),
          rename: (from, to) =>
            Effect.gen(function* () {
              if (++renames === 1) {
                yield* Deferred.succeed(renaming, undefined);
                yield* Deferred.await(renameReleased);
              }
              return yield* fs.rename(from, to);
            }),
        }),
      );
    }).pipe(Effect.provide(layer)),
  );
});
