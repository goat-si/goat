import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import { createManager, historyLogPath, openInput } from "./Manager.testkit.ts";
import { TERMINAL_HISTORY_COMPACTION_NOTICE } from "./terminalHistoryFile.ts";

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
  { excludeTestServices: true },
)("TerminalManager history file", (it) => {
  it.effect("restores a log tail that starts inside a control sequence without its remainder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const [persisted, restored] of [
        ["\u001b]0;x\u0007ABCD", "ABCD"],
        ["名\u001b]0;名\u0007ABCD", "ABCD"],
        ["\u001b]0;x\u0007\u001b[31mABCD", "ABCD"],
      ] as const) {
        const { manager, logsDir } = yield* createManager(5, { historyByteLimit: 8 });
        const path = yield* historyLogPath(logsDir);
        yield* fs.makeDirectory(logsDir, { recursive: true });
        yield* fs.writeFileString(path, persisted);
        expect((yield* manager.open(openInput())).history).toBe(restored);
        expect(yield* fs.readFileString(path)).toBe(restored);
      }
    }),
  );

  it.effect("reads a log an older server left within the limit without rewriting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const writes: string[] = [];
      const { manager, logsDir } = yield* createManager(5, { historyByteLimit: 64 }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (path, data, options) => {
            writes.push(path);
            return fs.writeFileString(path, data, options);
          },
          rename: (from, to) => {
            writes.push(to);
            return fs.rename(from, to);
          },
        }),
      );
      const path = yield* historyLogPath(logsDir);
      const older = "$ ls\r\nfile\r\n";
      yield* fs.makeDirectory(logsDir, { recursive: true });
      yield* fs.writeFileString(path, older);
      expect((yield* manager.open(openInput())).history).toBe(older);
      expect(writes).toEqual([]);
      expect(yield* fs.readFileString(path)).toBe(older);
    }),
  );

  it.effect(
    "keeps a truncated log that starts inside a control sequence when compaction fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { manager, logsDir } = yield* createManager(5, { historyByteLimit: 8 }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: () =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "rename",
                  cause: { code: "ENOSPC" },
                }),
              ),
          }),
        );
        const path = yield* historyLogPath(logsDir);
        const persisted = "名\u001b]0;名\u0007ABCD";
        yield* fs.makeDirectory(logsDir, { recursive: true });
        yield* fs.writeFileString(path, persisted);
        const { history } = yield* manager.open(openInput());
        // An 8-byte cap keeps only the end of the notice line.
        expect(TERMINAL_HISTORY_COMPACTION_NOTICE.endsWith(history)).toBe(true);
        expect(yield* fs.readFileString(path)).toBe(persisted);
        expect(yield* fs.readDirectory(logsDir)).toHaveLength(1);
      }),
  );

  it.effect("leaves an unreadable log in place and fails the open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { manager, logsDir } = yield* createManager(5, { historyByteLimit: 8 }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (path, options) =>
            options?.flag === "r"
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "open",
                    pathOrDescriptor: path,
                  }),
                )
              : fs.open(path, options),
        }),
      );
      const path = yield* historyLogPath(logsDir);
      const persisted = "\u001b]0;x\u0007ABCDEFGHIJ";
      yield* fs.makeDirectory(logsDir, { recursive: true });
      yield* fs.writeFileString(path, persisted);
      expect(Exit.isFailure(yield* Effect.exit(manager.open(openInput())))).toBe(true);
      expect(yield* fs.readFileString(path)).toBe(persisted);
      expect(yield* fs.readDirectory(logsDir)).toHaveLength(1);
    }),
  );

  it.effect("persists small terminal updates without rewriting the retained history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const writes = yield* Queue.unbounded<number>();
      const maxBytes = 64 * 1024;
      const { manager, ptyAdapter, logsDir } = yield* createManager(5_000, {
        historyByteLimit: maxBytes,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (path, data, options) =>
            fs
              .writeFileString(path, data, options)
              .pipe(
                Effect.tap(() =>
                  data.length > 0 ? Queue.offer(writes, Buffer.byteLength(data)) : Effect.void,
                ),
              ),
        }),
      );
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      process.emitData("a".repeat(maxBytes));
      let written = yield* Queue.take(writes);
      for (let index = 0; index < 16; index += 1) {
        process.emitData("b".repeat(1024));
        written += yield* Queue.take(writes);
      }
      expect(written).toBeLessThan(maxBytes * 2);
      const expected = "a".repeat(maxBytes - 16 * 1024) + "b".repeat(16 * 1024);
      const persisted = yield* fs.readFileString(yield* historyLogPath(logsDir));
      expect(Buffer.byteLength(persisted)).toBe(maxBytes + 16 * 1024);
      for (const failure of [undefined, "write", "rename"] as const) {
        let failed = false;
        const fail = () => {
          failed = true;
          return Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: failure === "write" ? "writeFileString" : "rename",
              cause: { code: "ENOSPC" },
            }),
          );
        };
        const recovered = yield* createManager(5_000, { historyByteLimit: maxBytes }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (file, data, options) =>
              failure === "write" && !failed && data === expected
                ? fs.writeFileString(file, "partial", options).pipe(Effect.andThen(fail))
                : fs.writeFileString(file, data, options),
            rename: (from, to) => (failure === "rename" && !failed ? fail() : fs.rename(from, to)),
          }),
        );
        const recoveredPath = yield* historyLogPath(recovered.logsDir);
        yield* fs.makeDirectory(recovered.logsDir, { recursive: true });
        yield* fs.writeFileString(recoveredPath, persisted);
        const snapshot = yield* recovered.manager.open(openInput());
        expect(snapshot.status).toBe("running");
        // A failed compaction says so in the terminal itself, inside the same byte cap.
        expect(snapshot.history).toBe(
          failure === undefined
            ? expected
            : (expected + TERMINAL_HISTORY_COMPACTION_NOTICE).slice(
                TERMINAL_HISTORY_COMPACTION_NOTICE.length,
              ),
        );
        expect(failed).toBe(failure !== undefined);
        expect(yield* fs.readFileString(recoveredPath)).toBe(
          failure === undefined ? expected : persisted,
        );
        expect(yield* fs.readDirectory(recovered.logsDir)).toHaveLength(1);
      }
      yield* manager.close({ threadId: "thread-1" });
      expect((yield* manager.open(openInput())).history).toBe(expected);
      expect(yield* fs.readFileString(yield* historyLogPath(logsDir))).toBe(expected);
    }),
  );

  it.effect("rewrites history after an append fails partway through", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const writes = yield* Queue.unbounded<void>();
      let failAppend = false;
      const { manager, ptyAdapter, logsDir } = yield* createManager().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (path, data, options) => {
            if (options?.flag === "a" && failAppend) {
              failAppend = false;
              return fs.writeFileString(path, data.slice(0, 1), options).pipe(
                // The file cannot also be a parent directory: fail after the partial append.
                Effect.andThen(fs.writeFileString(`${path}/missing`, data)),
                Effect.ensuring(Queue.offer(writes, undefined)),
              );
            }
            return fs
              .writeFileString(path, data, options)
              .pipe(
                Effect.tap(() => (data.length > 0 ? Queue.offer(writes, undefined) : Effect.void)),
              );
          },
        }),
      );
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      process.emitData("start:");
      yield* Queue.take(writes);
      failAppend = true;
      process.emitData("middle");
      yield* Queue.take(writes);
      expect(failAppend).toBe(false);
      process.emitData(":end");
      yield* Queue.take(writes);
      expect(yield* fs.readFileString(yield* historyLogPath(logsDir))).toBe("start:middle:end");
      yield* manager.close({ threadId: "thread-1" });
    }),
  );
});
