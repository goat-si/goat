import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { kimiRecordedEnvironment, makeKimiPromptOutcomeWatch } from "./kimiAcp.ts";

const SESSION_ID = "session_06abd65a-ab8c-4f7a-a504-9b105fc7cd0d";
const endTurn = { stopReason: "end_turn" } as const;
// Records trimmed from Kimi Code 2.5.3's wire.jsonl after the follow-up model request failed.
const failedTurn = (turnId: number) =>
  JSON.stringify({
    type: "turn.ended",
    agentId: "main",
    turnId,
    reason: "failed",
    error: {
      code: "provider.overloaded",
      message: "upstream overloaded",
      name: "APIProviderOverloadedError",
      details: { statusCode: 500 },
      retryable: true,
    },
    durationMs: 138873,
    time: 1794813146537,
  }) + "\n";
const promptTurn = (turnId: number) =>
  JSON.stringify({ type: "turn.prompt", agentId: "main", turnId, input: "fixture" }) + "\n";
const completedTurn = (turnId: number) =>
  JSON.stringify({ type: "turn.ended", agentId: "main", turnId, reason: "completed" }) + "\n";

it("uses only a matching recorded and process session environment", () => {
  const launch = { spawn: { env: { HOME: "/base", KIMI_CODE_HOME: "/base-kimi" } } };
  assert.deepStrictEqual(
    kimiRecordedEnvironment({ KIMI_CODE_HOME: "/session" }, { KIMI_CODE_HOME: "/session" }, launch),
    { HOME: "/base", KIMI_CODE_HOME: "/session" },
  );
  assert.isUndefined(kimiRecordedEnvironment(undefined, { HOME: "/one" }, launch));
  assert.isUndefined(kimiRecordedEnvironment({ HOME: "/one" }, { HOME: "/other" }, launch));
  assert.isUndefined(kimiRecordedEnvironment({ HOME: "/one" }, { HOME: "/one" }, undefined));
});

it.layer(NodeServices.layer)("makeKimiPromptOutcomeWatch", (it) => {
  it.effect("fails only the turn this prompt ended, once Kimi writes its outcome", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const agentDirectory = path.join(home, "sessions", "wd_proj_1", SESSION_ID, "agents", "main");
      yield* fileSystem.makeDirectory(agentDirectory, { recursive: true });
      const wire = path.join(agentDirectory, "wire.jsonl");
      // An earlier turn's failure is history, not this prompt's outcome.
      yield* fileSystem.writeFileString(wire, failedTurn(0));
      const append = (text: string) => fileSystem.writeFileString(wire, text, { flag: "a" });
      // Signals once a poll has closed the log, so the check is already waiting for its next poll.
      const polls = yield* Queue.unbounded<void>();
      const watch = yield* makeKimiPromptOutcomeWatch().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          open: (path, options) =>
            Effect.addFinalizer(() => Queue.offer(polls, undefined)).pipe(
              Effect.andThen(fileSystem.open(path, options)),
            ),
        }),
      );

      const completed = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
      yield* Queue.take(polls);
      yield* append(promptTurn(1) + completedTurn(1));
      assert.isUndefined(yield* completed(endTurn));
      yield* Queue.take(polls);

      // Kimi answers the prompt before `turn.ended` reaches disk.
      const failed = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
      yield* Queue.take(polls);
      yield* append(promptTurn(2) + failedTurn(2).slice(0, 40));
      const pending = yield* failed(endTurn).pipe(Effect.forkChild);
      yield* Queue.take(polls);
      yield* append(failedTurn(2).slice(40));
      yield* TestClock.adjust("50 millis");
      assert.deepStrictEqual(yield* Fiber.join(pending), {
        class: "provider_error",
        message: "upstream overloaded",
        code: "provider.overloaded",
        retryable: true,
      });
    }),
  );
  it.effect("skips missing session environments and unsafe native IDs without probing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const watch = yield* makeKimiPromptOutcomeWatch().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readDirectory: () => Effect.die("unexpected filesystem probe"),
        }),
      );
      assert.isUndefined(yield* (yield* watch(SESSION_ID, undefined))(endTurn));
      assert.isUndefined(yield* (yield* watch("../escape", { HOME: "/fixture" }))(endTurn));
    }),
  );

  it.effect("reads a new sessions directory created by the first prompt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const watch = yield* makeKimiPromptOutcomeWatch();
      const current = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
      const directory = path.join(home, "sessions", "workspace", SESSION_ID, "agents", "main");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "wire.jsonl"), promptTurn(1) + failedTurn(1));
      assert.equal((yield* current(endTurn))?.message, "upstream overloaded");
    }),
  );

  it.effect("reads a new session log created by its first prompt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(home, "sessions", "workspace", SESSION_ID, "agents", "main");
      yield* fs.makeDirectory(directory, { recursive: true });
      const watch = yield* makeKimiPromptOutcomeWatch();
      const current = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
      yield* fs.writeFileString(path.join(directory, "wire.jsonl"), promptTurn(1) + failedTurn(1));
      assert.equal((yield* current(endTurn))?.message, "upstream overloaded");
    }),
  );

  it.effect("isolates identical native session IDs between recorded homes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeA = yield* fs.makeTempDirectoryScoped();
      const homeB = yield* fs.makeTempDirectoryScoped();
      const directory = (home: string) =>
        path.join(home, "sessions", "workspace", SESSION_ID, "agents", "main");
      yield* fs.makeDirectory(directory(homeA), { recursive: true });
      yield* fs.makeDirectory(directory(homeB), { recursive: true });
      const wireA = path.join(directory(homeA), "wire.jsonl");
      const wireB = path.join(directory(homeB), "wire.jsonl");
      yield* fs.writeFileString(wireA, "");
      yield* fs.writeFileString(wireB, "");
      const watch = yield* makeKimiPromptOutcomeWatch();
      const a = yield* watch(SESSION_ID, { KIMI_CODE_HOME: homeA });
      const b = yield* watch(SESSION_ID, { KIMI_CODE_HOME: homeB });
      yield* fs.writeFileString(wireA, promptTurn(1) + failedTurn(1), { flag: "a" });
      yield* fs.writeFileString(wireB, promptTurn(1) + completedTurn(1), { flag: "a" });
      assert.equal((yield* a(endTurn))?.message, "upstream overloaded");
      assert.isUndefined(yield* b(endTurn));
    }),
  );

  it.effect.each(["truncate", "replace"] as const)(
    "does not replay an old outcome after log %s",
    (change) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const directory = path.join(home, "sessions", "workspace", SESSION_ID, "agents", "main");
        yield* fs.makeDirectory(directory, { recursive: true });
        const wire = path.join(directory, "wire.jsonl");
        yield* fs.writeFileString(wire, failedTurn(0) + failedTurn(1));
        const watch = yield* makeKimiPromptOutcomeWatch();
        const current = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
        if (change === "replace") {
          yield* fs.remove(wire);
          yield* fs.writeFileString(wire, failedTurn(2));
        } else {
          yield* fs.writeFileString(wire, failedTurn(2));
        }
        assert.isUndefined(yield* current(endTurn));
      }),
  );

  it.effect("does not attribute an old record after same-file truncation and regrowth", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(home, "sessions", "workspace", SESSION_ID, "agents", "main");
      yield* fs.makeDirectory(directory, { recursive: true });
      const wire = path.join(directory, "wire.jsonl");
      yield* fs.writeFileString(wire, "a".repeat(64) + "\n");
      const watch = yield* makeKimiPromptOutcomeWatch();
      const current = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
      yield* fs.writeFileString(wire, "b".repeat(65) + failedTurn(2));
      assert.isUndefined(yield* current(endTurn));
    }),
  );

  it.effect("ignores the tail of a record already open before the prompt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(home, "sessions", "workspace", SESSION_ID, "agents", "main");
      yield* fs.makeDirectory(directory, { recursive: true });
      const wire = path.join(directory, "wire.jsonl");
      yield* fs.writeFileString(wire, "unfinished-prefix");
      const polls = yield* Queue.unbounded<void>();
      const watch = yield* makeKimiPromptOutcomeWatch().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (filePath, options) =>
            Effect.addFinalizer(() => Queue.offer(polls, undefined)).pipe(
              Effect.andThen(fs.open(filePath, options)),
            ),
        }),
      );
      const current = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
      yield* Queue.take(polls);
      yield* fs.writeFileString(wire, failedTurn(0), { flag: "a" });
      const pending = yield* current(endTurn).pipe(Effect.forkChild);
      yield* Queue.take(polls);
      yield* fs.writeFileString(wire, promptTurn(1) + completedTurn(1), { flag: "a" });
      yield* TestClock.adjust("50 millis");
      assert.isUndefined(yield* Fiber.join(pending));
    }),
  );

  it.effect("does not attribute a delayed previous outcome to the next prompt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(home, "sessions", "workspace", SESSION_ID, "agents", "main");
      yield* fs.makeDirectory(directory, { recursive: true });
      const wire = path.join(directory, "wire.jsonl");
      yield* fs.writeFileString(wire, "");
      const polls = yield* Queue.unbounded<void>();
      const watch = yield* makeKimiPromptOutcomeWatch().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (filePath, options) =>
            Effect.addFinalizer(() => Queue.offer(polls, undefined)).pipe(
              Effect.andThen(fs.open(filePath, options)),
            ),
        }),
      );
      const current = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
      yield* fs.writeFileString(wire, failedTurn(1), { flag: "a" });
      const pending = yield* current(endTurn).pipe(Effect.forkChild);
      yield* Queue.take(polls);
      yield* fs.writeFileString(wire, promptTurn(2) + completedTurn(2), { flag: "a" });
      yield* TestClock.adjust("50 millis");
      assert.isUndefined(yield* Fiber.join(pending));
    }),
  );

  it.effect("does not read a session log resolved outside its recorded home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(home, "sessions", "workspace", SESSION_ID, "agents", "main");
      yield* fs.makeDirectory(directory, { recursive: true });
      const wire = path.join(directory, "wire.jsonl");
      yield* fs.writeFileString(wire, "");
      const watch = yield* makeKimiPromptOutcomeWatch().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          realPath: (filePath) =>
            filePath.endsWith(path.join(SESSION_ID, "agents", "main", "wire.jsonl"))
              ? Effect.succeed(path.join(home, "..", "outside", "wire.jsonl"))
              : fs.realPath(filePath),
        }),
      );
      const current = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
      yield* fs.writeFileString(wire, promptTurn(1) + failedTurn(1), { flag: "a" });
      assert.isUndefined(yield* current(endTurn));
    }),
  );

  it.effect(
    "ignores a replayed seen turn after an identical prefix rewrite and accepts the next turn",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const directory = path.join(home, "sessions", "workspace", SESSION_ID, "agents", "main");
        yield* fs.makeDirectory(directory, { recursive: true });
        const wire = path.join(directory, "wire.jsonl");
        yield* fs.writeFileString(wire, "");
        const polls = yield* Queue.unbounded<void>();
        const watch = yield* makeKimiPromptOutcomeWatch().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: (filePath, options) =>
              Effect.addFinalizer(() => Queue.offer(polls, undefined)).pipe(
                Effect.andThen(fs.open(filePath, options)),
              ),
          }),
        );
        const first = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
        const prefix = promptTurn(1) + completedTurn(1);
        yield* fs.writeFileString(wire, prefix, { flag: "a" });
        assert.isUndefined(yield* first(endTurn));
        yield* Queue.take(polls);
        const second = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
        yield* Queue.take(polls);
        yield* fs.writeFileString(wire, prefix + promptTurn(1) + failedTurn(1));
        const pending = yield* second(endTurn).pipe(Effect.forkChild);
        yield* Queue.take(polls);
        yield* fs.writeFileString(
          wire,
          promptTurn(2) + failedTurn(2).replace("upstream overloaded", "new failure"),
          { flag: "a" },
        );
        yield* TestClock.adjust("50 millis");
        assert.equal((yield* Fiber.join(pending))?.message, "new failure");
      }),
  );

  it.effect("bounds the bytes examined for one prompt outcome", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(home, "sessions", "workspace", SESSION_ID, "agents", "main");
      yield* fs.makeDirectory(directory, { recursive: true });
      const wire = path.join(directory, "wire.jsonl");
      yield* fs.writeFileString(wire, "");
      const sizes: number[] = [];
      const watch = yield* makeKimiPromptOutcomeWatch().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (filePath, options) =>
            fs.open(filePath, options).pipe(
              Effect.map(
                (file) =>
                  new Proxy(file, {
                    get(target, key) {
                      if (key === "readAlloc")
                        return (...args: Parameters<typeof file.readAlloc>) => {
                          sizes.push(args[0]);
                          return file.readAlloc(...args);
                        };
                      return Reflect.get(target, key, target);
                    },
                  }),
              ),
            ),
        }),
      );
      const current = yield* watch(SESSION_ID, { KIMI_CODE_HOME: home });
      yield* fs.writeFileString(wire, "x".repeat(8 * 1024 * 1024 + 1), { flag: "a" });
      assert.equal(
        (yield* current(endTurn))?.message,
        "Kimi's turn outcome log exceeded the scan limit.",
      );
      assert.isTrue(sizes.length > 0);
      assert.isTrue(sizes.every((size) => size <= 65_536));
      assert.isAtMost(
        sizes.reduce((sum, size) => sum + size, 0),
        8 * 1024 * 1024,
      );
    }),
  );
});
