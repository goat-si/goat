import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { defaultReply, makeCliHarness, LOGIN, RECEIPT } from "./testing.ts";

it.effect(
  "readiness does not create work or open a PTY and reuses the sibling executable/environment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        expect(yield* h.service.readiness(LOGIN, "/fixture/repo")).toEqual({
          version: "2.1.296 (Claude Code)",
        });
        expect(h.starts).toEqual([]);
        expect(h.commands.map((command) => command.args)).toEqual([
          ["--version"],
          ["--help"],
          ["auth", "status"],
        ]);
        expect(
          h.commands.every(
            (command) =>
              command.command === LOGIN.binary && command.options.env === LOGIN.environment,
          ),
        ).toBe(true);
      }),
    ),
);

it.effect.each([
  '{"loggedIn":false,"authMethod":"none"}',
  '{"loggedIn":true,"authMethod":"api-key"}',
  '{"loggedIn":true,"authMethod":"bedrock"}',
  "not JSON",
])("rejects cloud readiness for %s", (auth) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness((args) =>
        args[0] === "auth" ? { code: 0, stdout: auth } : defaultReply(args),
      );
      const error = yield* h.service.readiness(LOGIN, "/fixture/repo").pipe(Effect.flip);
      expect(error.outcome).toBe("rejected");
      expect(h.starts).toEqual([]);
    }),
  ),
);
it.effect("requires --cloud support on the exact sibling executable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness((args) =>
        args[0] === "--help" ? { code: 0, stdout: "--print" } : defaultReply(args),
      );
      expect(
        (yield* h.service.readiness(LOGIN, "/fixture/repo").pipe(Effect.flip)).detail,
      ).toContain("does not advertise");
    }),
  ),
);

it.effect(
  "returns the accepted ID before exit, preserves prompt argv and never writes trust input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        const prompt = "Fix '$literal' and $(not-a-command)\nsecond line";
        const fiber = yield* h.service.start(LOGIN, "/fixture/repo", prompt).pipe(Effect.forkChild);
        yield* h.fake.ready;
        for (const character of RECEIPT) h.fake.emit(character);
        const handle = yield* Fiber.join(fiber);
        expect(handle.receipt.taskId).toBe("session_ABC123");
        expect(h.starts[0]).toEqual({
          shell: LOGIN.binary,
          args: [`--cloud=${prompt}`],
          cwd: "/fixture/repo",
          cols: 120,
          rows: 30,
          env: LOGIN.environment,
        });
        expect(h.fake.writes).toEqual([]);
        h.fake.finish();
        yield* handle.exited;
      }),
    ),
);

it.effect(
  "rejects trust without answering it and releases only its owned process/subscriptions",
  () =>
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* h.service
            .start(LOGIN, "/fixture/repo", "task")
            .pipe(Effect.forkChild);
          yield* h.fake.ready;
          h.fake.emit("Do you trust the files in this folder?\n");
          const error = yield* Fiber.join(fiber).pipe(Effect.flip);
          expect(error.detail).toContain("GOAT never accepts trust");
          expect(h.fake.writes).toEqual([]);
        }),
      );
      expect(h.fake.kills).toBe(1);
      expect(h.fake.listeners).toBe(0);
    }),
);

it.effect("exit zero without identity stays uncertain; no automatic second spawn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service.start(LOGIN, "/fixture/repo", "task").pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit("Setup finished\n");
      h.fake.finish();
      expect((yield* Fiber.join(fiber).pipe(Effect.flip)).outcome).toBe("uncertain");
      expect(h.starts).toHaveLength(1);
    }),
  ),
);

it.effect("sends to the exact persisted session and rejects JSON ok:false with exit zero", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness(() => ({
        code: 0,
        stdout: '{"ok":false,"error":"Session archived"}',
      }));
      const message = "follow-up $(literal)";
      const error = yield* h.service
        .send(LOGIN, "/fixture/repo", "session_ABC123", message)
        .pipe(Effect.flip);
      expect(error.detail).toContain("Session archived");
      expect(error.outcome).toBe("rejected");
      expect(h.commands[0]?.args).toEqual([
        "--print",
        "--cloud=session_ABC123",
        "--output-format",
        "json",
        "--",
        message,
      ]);
      expect(h.starts).toEqual([]);
    }),
  ),
);

it.effect(
  "definitive control spawn failure is rejected, while a spawned unreadable receipt is uncertain",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const absent = yield* makeCliHarness(defaultReply, true);
        const rejected = yield* absent.service
          .send(LOGIN, "/fixture/control", "session_ABC123", "message")
          .pipe(Effect.flip);
        expect(rejected.outcome).toBe("rejected");
        expect(absent.commands).toEqual([]); // No child handle/delivery was created.
        const spawned = yield* makeCliHarness(() => ({ code: 0, stdout: "incomplete receipt" }));
        const uncertain = yield* spawned.service
          .send(LOGIN, "/fixture/control", "session_ABC123", "message")
          .pipe(Effect.flip);
        expect(uncertain.outcome).toBe("uncertain");
        expect(spawned.commands).toHaveLength(1);
      }),
    ),
);

it.effect.each([
  "--dangerously-skip-permissions",
  "-p",
  "--model=other",
  "- leading task\n--cloud=session_OTHER",
])("binds create prompt %s as one optional flag value", (prompt) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/disposable", prompt)
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(RECEIPT);
      const handle = yield* Fiber.join(fiber);
      expect(h.starts[0]?.args).toEqual([`--cloud=${prompt}`]);
      expect(h.fake.writes).toEqual([]);
      h.fake.finish();
      yield* handle.exited;
    }),
  ),
);
it.effect.each(["--dangerously-skip-permissions", "-p", "--model=other", "--"])(
  "keeps print follow-up %s positional after the end-of-options marker",
  (message) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        yield* h.service.send(LOGIN, "/fixture/control", "session_ABC123", message);
        expect(h.commands[0]?.args).toEqual([
          "--print",
          "--cloud=session_ABC123",
          "--output-format",
          "json",
          "--",
          message,
        ]);
        expect(h.fake.writes).toEqual([]);
      }),
    ),
);
it.effect.each(["", "session_ABC123", "https://claude.ai/code/session_ABC123"])(
  "never interprets initial prompt %s as attach",
  (prompt) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        expect(
          (yield* h.service.start(LOGIN, "/fixture/repo", prompt).pipe(Effect.flip)).outcome,
        ).toBe("rejected");
        expect(h.starts).toEqual([]);
      }),
    ),
);
it.effect("accepts a receipt whose title mentions workspace trust", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service.start(LOGIN, "/fixture/repo", "task").pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(RECEIPT.replace("Test task", "Fix workspace trust"));
      const handle = yield* Fiber.join(fiber);
      expect(handle.receipt.title).toBe("Fix workspace trust");
      expect(handle.receipt.taskId).toBe("session_ABC123");
      h.fake.finish();
      yield* handle.exited;
      expect(h.fake.writes).toEqual([]);
    }),
  ),
);

it.effect("escalates an owned PTY that ignores graceful kill before releasing its source", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      h.fake.exitOnKill = false;
      h.fake.exitOnForceKill = true;
      const cleaned = yield* Deferred.make<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(cleaned, undefined));
          yield* h.service.start(LOGIN, "/fixture/disposable", "task");
        }),
      ).pipe(Effect.result, Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit("Do you trust the files in this folder?\n");
      yield* h.fake.killed;
      expect(h.fake.killSignals).toEqual([undefined]);
      expect(yield* Deferred.isDone(cleaned)).toBe(false);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Failure");
      expect(h.fake.killSignals).toEqual([undefined, "SIGKILL"]);
      expect(yield* Deferred.isDone(cleaned)).toBe(true);
      expect(h.fake.listeners).toBe(0);
      expect(h.fake.writes).toEqual([]);
    }),
  ),
);

it.effect("keeps the owned PTY exit listener and source alive while kill is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      h.fake.exitOnKill = false;
      const cleaned = yield* Deferred.make<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(cleaned, undefined));
          yield* h.service.start(LOGIN, "/fixture/disposable", "task");
        }),
      ).pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit("Do you trust the files in this folder?\n");
      yield* h.fake.killed;
      expect(yield* Deferred.isDone(cleaned)).toBe(false);
      expect(h.fake.listeners).toBeGreaterThan(0);
      expect(h.fake.writes).toEqual([]);
      h.fake.finish(130);
      expect((yield* Fiber.join(fiber).pipe(Effect.flip)).outcome).toBe("rejected");
      expect(yield* Deferred.isDone(cleaned)).toBe(true);
      expect(h.fake.listeners).toBe(0);
    }),
  ),
);
it.effect("PTY receipt timeout is uncertain and releases only one owned process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* Effect.scoped(h.service.start(LOGIN, "/fixture/repo", "task")).pipe(
        Effect.forkChild,
      );
      yield* h.fake.ready;
      yield* TestClock.adjust("60 seconds");
      expect((yield* Fiber.join(fiber).pipe(Effect.flip)).outcome).toBe("uncertain");
      expect(h.starts).toHaveLength(1);
      expect(h.fake.kills).toBe(1);
      expect(h.fake.listeners).toBe(0);
    }),
  ),
);
it.effect.each([
  { output: "x".repeat(65537), code: 0, signal: null },
  { output: "unreadable \uFFFD", code: 0, signal: null },
  { output: "", code: 1, signal: null },
  { output: "", code: 0, signal: 15 },
])("retains an early accepted identity when later PTY outcome is uncertain (%j)", (entry) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service.start(LOGIN, "/fixture/repo", "task").pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(RECEIPT);
      const handle = yield* Fiber.join(fiber);
      expect(handle.receipt.taskId).toBe("session_ABC123");
      if (entry.output) h.fake.emit(entry.output);
      h.fake.finish(entry.code, entry.signal);
      expect((yield* handle.exited.pipe(Effect.flip)).outcome).toBe("uncertain");
      expect(h.starts).toHaveLength(1);
    }),
  ),
);
it.effect("failed PTY spawn is definite rejection with underlying cause", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness(defaultReply, false, { rejectPtySpawn: true });
      const error = yield* h.service.start(LOGIN, "/fixture/repo", "task").pipe(Effect.flip);
      expect(error.outcome).toBe("rejected");
      expect(error.cause).toBeDefined();
      expect(h.starts).toEqual([]);
    }),
  ),
);
it.effect.each([
  {
    code: 1,
    stdout:
      '{"ok":true,"session_id":"session_ABC123","url":"https://claude.ai/code/session_ABC123"}',
  },
  {
    code: 0,
    stdout: '{"ok":true,"session_id":"session_OTHER","url":"https://claude.ai/code/session_OTHER"}',
  },
  { code: 0, stdout: "x".repeat(65537) },
  { code: 0, stdout: "", bytes: new Uint8Array([0xc3, 0x28]) },
])("does not classify an inconsistent spawned follow-up as admission (%j)", (reply) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness(() => reply);
      expect(
        (yield* h.service
          .send(LOGIN, "/fixture/control", "session_ABC123", "task")
          .pipe(Effect.flip)).outcome,
      ).toBe("uncertain");
      expect(h.commands).toHaveLength(1);
    }),
  ),
);
it.effect("a spawned print timeout is uncertain and never retried", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness(defaultReply, false, { exitCode: Effect.never });
      const fiber = yield* h.service
        .send(LOGIN, "/fixture/control", "session_ABC123", "task")
        .pipe(Effect.forkChild);
      yield* Deferred.await(h.commandSpawned);
      yield* TestClock.adjust("30 seconds");
      expect((yield* Fiber.join(fiber).pipe(Effect.flip)).outcome).toBe("uncertain");
      expect(h.commands).toHaveLength(1);
    }),
  ),
);
it.effect.each([
  "CCR_FORCE_BUNDLE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "GIT_DIR",
])("rejects %s before invoking any sibling command", (key) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const login = { ...LOGIN, environment: { ...LOGIN.environment, [key]: "fixture-routing" } };
      expect(
        (yield* h.service.readiness(login, "/fixture/control").pipe(Effect.flip)).outcome,
      ).toBe("rejected");
      expect(
        (yield* h.service
          .send(login, "/fixture/control", "session_ABC123", "task")
          .pipe(Effect.flip)).outcome,
      ).toBe("rejected");
      expect(h.commands).toEqual([]);
      expect(h.starts).toEqual([]);
    }),
  ),
);

it.effect.each([
  RECEIPT + "x".repeat(65537),
  RECEIPT + "Error: fixture network interrupted\n",
  RECEIPT + "Do you trust the files in this folder?\n",
  RECEIPT + "View: https://claude.ai/code/session_OTHER\n",
])("returns the first accepted identity before same-chunk failure (%#)", (output) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/disposable", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(output);
      const handle = yield* Fiber.join(fiber);
      expect(handle.receipt.taskId).toBe("session_ABC123");
      expect(handle.receipt.url).toBe("https://claude.ai/code/session_ABC123");
      expect((yield* handle.exited.pipe(Effect.flip)).outcome).toBe("uncertain");
      expect(h.fake.writes).toEqual([]);
      h.fake.finish(1);
    }),
  ),
);
it.effect("a generic after-spawn diagnostic without a receipt is uncertain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/disposable", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit("Error: request interrupted\n");
      expect((yield* Fiber.join(fiber).pipe(Effect.flip)).outcome).toBe("uncertain");
      h.fake.finish(1);
    }),
  ),
);
