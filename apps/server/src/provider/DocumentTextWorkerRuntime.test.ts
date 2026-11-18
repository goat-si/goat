// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "./DocumentText.ts";

vi.mock("node:child_process", { spy: true });

const layer = Layer.merge(
  ServerConfig.layerTest(process.cwd(), { prefix: "goat-answer-paths-" }),
  DocumentText.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
describe("document extraction worker", () => {
  it.effect.each([false, true])(
    "keeps unrelated files available during extraction (failure: %s)",
    (failure) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = NodePath.join(config.attachmentsDir, "blocked.rtf");
        const cached = NodePath.join(config.attachmentsDir, "cached.rtf");
        NodeFS.writeFileSync(path, failure ? "invalid document" : String.raw`{\rtf1 Available}`);
        NodeFS.writeFileSync(cached + ".txt", "Cached text");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let reads = 0;
        yield* Effect.gen(function* () {
          const documents = yield* DocumentText.DocumentText;
          const extraction = yield* documents.ensure(path).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const duplicate = yield* documents.ensure(path).pipe(Effect.forkChild);
          expect(yield* documents.ensure(path + ".png")).toBeUndefined();
          expect(yield* documents.ensure(path + ".pdf")).toBeUndefined();
          expect(yield* documents.ensure(cached)).toBe(cached + ".txt");
          expect(NodeFS.readFileSync(cached + ".txt", "utf8")).toBe("Cached text");
          yield* Deferred.succeed(release, undefined);
          const expected = failure ? undefined : path + ".txt";
          expect(yield* Fiber.join(extraction)).toBe(expected);
          expect(yield* Fiber.join(duplicate)).toBe(expected);
          expect(yield* documents.ensure(path)).toBe(expected);
          expect(reads).toBe(1);
          if (failure) {
            NodeFS.writeFileSync(path + ".txt", "Recovered text");
            expect(yield* documents.ensure(path)).toBe(path + ".txt");
            expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe("Recovered text");
          } else expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe("Available");
        }).pipe(
          Effect.provide(Layer.fresh(DocumentText.layer)),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (file) =>
              file === path
                ? Effect.gen(function* () {
                    reads++;
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                    return yield* fs.stat(file);
                  })
                : fs.stat(file),
          }),
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["spawn", "read"])("retries after a transient %s failure expires", (failure) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const { execFile } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
        const worker = vi.spyOn(NodeChildProcess, "execFile");
        worker.mockImplementationOnce(((
          file: string,
          args: readonly string[],
          options: NodeChildProcess.ExecFileOptionsWithStringEncoding,
          callback: (
            error: NodeChildProcess.ExecFileException | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) => {
          if (failure === "spawn") {
            throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
          }
          const preload = `import fs from 'node:fs/promises';
            import { syncBuiltinESMExports } from 'node:module';
            fs.readFile = async () => { throw Object.assign(new Error('read EAGAIN'), { code: 'EAGAIN' }); };
            syncBuiltinESMExports();`;
          return execFile(
            file,
            ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, ...args],
            options,
            callback,
          );
        }) as typeof NodeChildProcess.execFile);
        return worker;
      }),
      (worker) =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const path = NodePath.join(config.attachmentsDir, "retry.rtf");
          NodeFS.writeFileSync(path, String.raw`{\rtf1 Available}`);
          const documents = yield* DocumentText.DocumentText;
          expect(yield* documents.ensure(path)).toBeUndefined();
          expect(yield* documents.ensure(path)).toBeUndefined();
          expect(worker).toHaveBeenCalledTimes(1);
          expect(NodeFS.existsSync(path + ".txt")).toBe(false);
          yield* TestClock.adjust("1 second");
          expect(yield* documents.ensure(path)).toBe(path + ".txt");
          expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe("Available");
          expect(worker).toHaveBeenCalledTimes(2);
          expect(yield* documents.ensure(path)).toBe(path + ".txt");
          expect(worker).toHaveBeenCalledTimes(2);
        }).pipe(Effect.provide(layer)),
      (worker) => Effect.sync(() => worker.mockRestore()),
    ),
  );

  it.effect.each([
    ["ipynb", "{"],
    ["rtf", "invalid document"],
    ["rtf", String.raw`{\rtf1}`],
    ["rtf", String.raw`{\rtf1\ansi\ansicpg99999 Unsupported}`],
  ] as const)("caches unchanged document rejections: %s %s", ([extension, source]) =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(NodeChildProcess, "execFile")),
      (worker) =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const path = NodePath.join(config.attachmentsDir, `invalid.${extension}`);
          NodeFS.writeFileSync(path, source);
          const documents = yield* DocumentText.DocumentText;
          for (const seconds of [0, 1, 60]) {
            yield* TestClock.adjust(`${seconds} seconds`);
            expect(yield* documents.ensure(path)).toBeUndefined();
            expect(worker).toHaveBeenCalledTimes(1);
            expect(NodeFS.existsSync(path + ".txt")).toBe(false);
          }
        }).pipe(Effect.provide(layer)),
      (worker) => Effect.sync(() => worker.mockRestore()),
    ),
  );

  it.effect.each([false, true])("limits the child heap for standalone=%s", (standalone) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const { execFile } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
        const probe = vi.spyOn(NodeChildProcess, "execFile");
        probe.mockImplementation(((
          file: string,
          _args: readonly string[],
          options: NodeChildProcess.ExecFileOptionsWithStringEncoding,
          callback: (
            error: NodeChildProcess.ExecFileException | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) =>
          execFile(
            file,
            [
              "-e",
              'process.stdout.write(String(require("node:v8").getHeapStatistics().heap_size_limit))',
            ],
            options,
            callback,
          )) as typeof NodeChildProcess.execFile);
        return probe;
      }),
      () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const path = NodePath.join(config.attachmentsDir, "heap.rtf");
          NodeFS.writeFileSync(path, String.raw`{\rtf1 hello}`);
          const extracted = yield* Effect.gen(function* () {
            return yield* (yield* DocumentText.DocumentText).ensure(path);
          }).pipe(
            Effect.provide(Layer.fresh(DocumentText.layer)),
            Effect.provideService(HostProcess.IsExecutable, standalone),
            Effect.provideService(HostProcess.Environment, {
              ...process.env,
              NODE_OPTIONS: "--max-old-space-size=1024",
            }),
          );
          expect(extracted).toBe(path + ".txt");
          const heapLimit = Number(NodeFS.readFileSync(path + ".txt", "utf8"));
          expect(heapLimit).toBeGreaterThan(192 * 1024 * 1024);
          // Newer V8 versions reserve up to 192 MiB for the young generation as well.
          expect(heapLimit).toBeLessThanOrEqual(384 * 1024 * 1024);
        }).pipe(Effect.provide(layer)),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
  );
});
