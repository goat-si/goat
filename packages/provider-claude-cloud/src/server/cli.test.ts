import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  defaultReply,
  makeCliHarness,
  LOGIN,
  RECEIPT,
  FOLDER_TRUST_PROMPT,
  SYNTHETIC_FOLDER_TRUST_REFUSALS,
  NATIVE_TRUST_DIALOG,
  NATIVE_TRUST_MOVED,
  DOWN,
  type FakePty,
} from "./testing.ts";

// Minimal option line from the plain native node-pty capture; no cwd/account data or trust input.
const NATIVE_FOLDER_TRUST_OPTION =
  "\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\r\n";

it.effect(
  "neutralizes GIT_PAGER for readiness, start and follow-up without mutating the sibling",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        const environment = { ...LOGIN.environment, GIT_PAGER: "less -FRX", PAGER: "less" };
        const login = { ...LOGIN, environment };
        const expectedEnvironment = { ...LOGIN.environment, GIT_PAGER: "", PAGER: "less" };
        expect(yield* h.service.readiness(login, "/fixture/repo")).toEqual({ version: "2.1.296" });
        expect(h.commands.map((command) => command.args)).toEqual([
          ["auth", "status"],
          ["--version"],
          ["--help"],
        ]);
        const fiber = yield* h.service.start(login, "/fixture/repo", "task").pipe(Effect.forkChild);
        yield* h.fake.ready;
        h.fake.emit(RECEIPT);
        const handle = yield* Fiber.join(fiber);
        h.fake.finish(0);
        yield* handle.exited;
        expect(
          yield* h.service.send(login, "/fixture/control", "session_ABC123", "follow-up"),
        ).toEqual({ taskId: "session_ABC123", url: "https://claude.ai/code/session_ABC123" });
        expect(h.commands).toHaveLength(4);
        for (const command of h.commands) {
          expect(command.command).toBe(LOGIN.binary);
          expect(command.options.env).toEqual(expectedEnvironment);
        }
        expect(h.starts).toHaveLength(1);
        expect(h.starts[0]?.env).toEqual(expectedEnvironment);
        expect(h.fake.writes).toEqual([]);
        expect(environment).toEqual({
          ...LOGIN.environment,
          GIT_PAGER: "less -FRX",
          PAGER: "less",
        });
      }),
    ),
);

it.effect(
  "readiness does not create work or open a PTY and reuses the sibling executable/environment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        expect(yield* h.service.readiness(LOGIN, "/fixture/repo")).toEqual({
          version: "2.1.296",
        });
        expect(h.starts).toEqual([]);
        expect(h.commands.map((command) => command.args)).toEqual([
          ["auth", "status"],
          ["--version"],
          ["--help"],
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
  { output: "Claude Code v2.1.296\n", version: "2.1.296" },
  { output: "Claude Code nightly\n", version: null },
] as const)(
  "normalizes readiness version %s without weakening cloud/auth checks",
  ({ output, version }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness((args) =>
          args[0] === "--version" ? { code: 0, stdout: output } : defaultReply(args),
        );
        expect(yield* h.service.readiness(LOGIN, "/fixture/repo")).toEqual({ version });
        expect(h.commands.map((command) => command.args)).toEqual([
          ["auth", "status"],
          ["--version"],
          ["--help"],
        ]);
        expect(h.starts).toEqual([]);
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
      expect(h.commands.map((command) => command.args)).toEqual([["auth", "status"]]);
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

it.effect.each([{ signal: null }, { signal: 0 }] as const)(
  "returns identity before a normal native exit, preserving argv and zero trust input (%s)",
  ({ signal }) =>
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
        h.fake.finish(0, signal);
        yield* handle.exited;
      }),
    ),
);

it.effect.each([
  { code: 1, signal: 0 },
  { code: 0, signal: 15 },
  { code: 0, signal: 9 },
] as const)(
  "keeps accepted identity but rejects a failed or signalled sender exit (%s)",
  ({ code, signal }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        const fiber = yield* h.service
          .start(LOGIN, "/fixture/project", "task")
          .pipe(Effect.forkChild);
        yield* h.fake.ready;
        h.fake.emit(RECEIPT);
        const handle = yield* Fiber.join(fiber);
        h.fake.finish(code, signal);
        const failure = yield* handle.exited.pipe(Effect.flip);
        expect(handle.receipt.taskId).toBe("session_ABC123");
        expect(failure.outcome).toBe("uncertain");
        expect(h.starts).toHaveLength(1);
        expect(h.fake.writes).toEqual([]);
      }),
    ),
);

it.effect("a normal zero-signal exit does not override an output failure after admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(RECEIPT);
      const handle = yield* Fiber.join(fiber);
      h.fake.emit("Error: fixture transport interrupted\n");
      h.fake.finish(0, 0);
      const failure = yield* handle.exited.pipe(Effect.flip);
      expect(failure.outcome).toBe("uncertain");
      expect(failure.detail).toBe("fixture transport interrupted");
      expect(handle.receipt.taskId).toBe("session_ABC123");
      expect(h.starts).toHaveLength(1);
      expect(h.fake.writes).toEqual([]);
    }),
  ),
);

// Refusal variants are representative synthetic fixtures; the folder prompt was observed natively.
it.effect.each([
  FOLDER_TRUST_PROMPT,
  NATIVE_FOLDER_TRUST_OPTION,
  ...SYNTHETIC_FOLDER_TRUST_REFUSALS,
])(
  "rejects split ANSI folder trust with the exact project cwd and one spawn/zero input (%#)",
  (output) =>
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const environmentBefore = { ...LOGIN.environment };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* h.service
            .start(LOGIN, "/fixture/project folder", "task")
            .pipe(Effect.forkChild);
          yield* h.fake.ready;
          for (const character of `\u001b[33m${output}\u001b[0m`) h.fake.emit(character);
          const error = yield* Fiber.join(fiber).pipe(Effect.flip);
          expect(error.outcome).toBe("rejected");
          expect(error.detail).toBe(
            "Claude Code hasn't trusted this folder yet. Open it once with `claude` in /fixture/project folder, accept the trust prompt, then try again.",
          );
          expect(h.starts).toEqual([
            {
              shell: LOGIN.binary,
              args: ["--cloud=task"],
              cwd: "/fixture/project folder",
              cols: 120,
              rows: 30,
              env: LOGIN.environment,
            },
          ]);
          expect(LOGIN.environment).toEqual(environmentBefore);
          expect(h.commands).toEqual([]);
          expect(h.fake.writes).toEqual([]);
        }),
      );
      expect(h.starts).toHaveLength(1);
      expect(h.fake.kills).toBe(1);
      expect(h.fake.listeners).toBe(0);
    }),
);

it.effect("recognizes an unterminated specific folder refusal when the PTY reports exit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      // Synthetic refusal; onExit terminates the final PTY line before inspection.
      h.fake.emit("Error: This folder is not trusted.");
      h.fake.finish(1);
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.outcome).toBe("rejected");
      expect(error.detail).toBe(
        "Claude Code hasn't trusted this folder yet. Open it once with `claude` in /fixture/project, accept the trust prompt, then try again.",
      );
      expect(h.starts).toHaveLength(1);
      expect(h.fake.writes).toEqual([]);
    }),
  ),
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
        .start(LOGIN, "/fixture/project", prompt)
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
it.effect.each([
  "Fix workspace trust",
  "Do you trust this algorithm?",
  FOLDER_TRUST_PROMPT.trim(),
  NATIVE_FOLDER_TRUST_OPTION.trimEnd(),
  ...SYNTHETIC_FOLDER_TRUST_REFUSALS.map((output) => output.trim()),
])("accepts a receipt whose title mentions trust (%#)", (title) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service.start(LOGIN, "/fixture/repo", "task").pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(RECEIPT.replace("Test task", title));
      const handle = yield* Fiber.join(fiber);
      expect(handle.receipt.title).toBe(
        title === NATIVE_FOLDER_TRUST_OPTION.trimEnd() ? "Yes,Itrustthisfolder" : title,
      );
      expect(handle.receipt.taskId).toBe("session_ABC123");
      h.fake.finish();
      yield* handle.exited;
      expect(h.fake.writes).toEqual([]);
    }),
  ),
);

it.effect.each([
  FOLDER_TRUST_PROMPT,
  NATIVE_FOLDER_TRUST_OPTION,
  ...SYNTHETIC_FOLDER_TRUST_REFUSALS,
])("returns identity before a later split ANSI folder refusal reports uncertainty (%#)", (output) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project folder", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(RECEIPT);
      const handle = yield* Fiber.join(fiber);
      expect(handle.receipt.taskId).toBe("session_ABC123");
      for (const character of `\u001b[33m${output}\u001b[0m`) h.fake.emit(character);
      const error = yield* handle.exited.pipe(Effect.flip);
      expect(error.outcome).toBe("uncertain");
      expect(error.detail).toBe(
        "Claude Code hasn't trusted this folder yet. Open it once with `claude` in /fixture/project folder, accept the trust prompt, then try again.",
      );
      expect(h.starts).toHaveLength(1);
      expect(h.fake.writes).toEqual([]);
      h.fake.finish(1);
    }),
  ),
);

it.effect.each([
  "Do you trust this algorithm?\n",
  "Task: This directory is not trusted.\n",
  "Discuss whether this folder is trusted.\n",
  NATIVE_FOLDER_TRUST_OPTION.replace("folder", "algorithm"),
  `Task: ${NATIVE_FOLDER_TRUST_OPTION}`,
])("generic trust task output does not block a later receipt (%#)", (output) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(output);
      h.fake.emit(RECEIPT);
      const handle = yield* Fiber.join(fiber);
      expect(handle.receipt.taskId).toBe("session_ABC123");
      h.fake.finish();
      yield* handle.exited;
      expect(h.starts).toHaveLength(1);
      expect(h.fake.writes).toEqual([]);
    }),
  ),
);

it.effect("escalates an owned PTY that ignores graceful kill before releasing its scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      h.fake.exitOnKill = false;
      h.fake.exitOnForceKill = true;
      const scopeReleased = yield* Deferred.make<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(scopeReleased, undefined));
          yield* h.service.start(LOGIN, "/fixture/project", "task");
        }),
      ).pipe(Effect.result, Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit("Do you trust the files in this folder?\n");
      yield* h.fake.killed;
      expect(h.fake.killSignals).toEqual([undefined]);
      expect(yield* Deferred.isDone(scopeReleased)).toBe(false);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Failure");
      expect(h.fake.killSignals).toEqual([undefined, "SIGKILL"]);
      expect(yield* Deferred.isDone(scopeReleased)).toBe(true);
      expect(h.fake.listeners).toBe(0);
      expect(h.fake.writes).toEqual([]);
    }),
  ),
);

it.effect("keeps the owned PTY exit listener and scope alive while kill is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      h.fake.exitOnKill = false;
      const scopeReleased = yield* Deferred.make<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(scopeReleased, undefined));
          yield* h.service.start(LOGIN, "/fixture/project", "task");
        }),
      ).pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit("Do you trust the files in this folder?\n");
      yield* h.fake.killed;
      expect(yield* Deferred.isDone(scopeReleased)).toBe(false);
      expect(h.fake.listeners).toBeGreaterThan(0);
      expect(h.fake.writes).toEqual([]);
      h.fake.finish(130);
      expect((yield* Fiber.join(fiber).pipe(Effect.flip)).outcome).toBe("rejected");
      expect(yield* Deferred.isDone(scopeReleased)).toBe(true);
      expect(h.fake.listeners).toBe(0);
    }),
  ),
);
it.effect(
  "retains the owned PTY listeners after SIGKILL until actual onExit releases the scope",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        h.fake.exitOnKill = false;
        const scopeReleased = yield* Deferred.make<void>();
        const fiber = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(scopeReleased, undefined));
            yield* h.service.start(LOGIN, "/fixture/project", "task");
          }),
        ).pipe(Effect.forkChild);
        yield* h.fake.ready;
        h.fake.emit(FOLDER_TRUST_PROMPT);
        yield* h.fake.killed;
        yield* TestClock.adjust("2 seconds");
        yield* h.fake.forceKilled;
        expect(h.fake.killSignals).toEqual([undefined, "SIGKILL"]);
        expect(yield* Deferred.isDone(scopeReleased)).toBe(false);
        expect(h.fake.listeners).toBeGreaterThan(0);
        h.fake.finish(130, 9);
        expect((yield* Fiber.join(fiber).pipe(Effect.flip)).outcome).toBe("rejected");
        expect(yield* Deferred.isDone(scopeReleased)).toBe(true);
        expect(h.fake.listeners).toBe(0);
        expect(h.starts).toHaveLength(1);
        expect(h.fake.writes).toEqual([]);
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
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_INDEX_FILE",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_UNKNOWN_OVERRIDE",
])("rejects %s before invoking any sibling command", (key) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const login = {
        ...LOGIN,
        environment: { ...LOGIN.environment, GIT_PAGER: "less", [key]: "fixture-routing" },
      };
      expect(
        (yield* h.service.readiness(login, "/fixture/control").pipe(Effect.flip)).outcome,
      ).toBe("rejected");
      expect(
        (yield* h.service
          .send(login, "/fixture/control", "session_ABC123", "task")
          .pipe(Effect.flip)).outcome,
      ).toBe("rejected");
      expect(h.commands).toEqual([]);
      expect(
        (yield* h.service.start(login, "/fixture/repo", "task").pipe(Effect.flip)).outcome,
      ).toBe("rejected");
      expect(h.starts).toEqual([]);
    }),
  ),
);

it.effect.each([
  RECEIPT + "x".repeat(65537),
  RECEIPT + "Error: fixture network interrupted\n",
  RECEIPT + "Do you trust the files in this folder?\n",
  RECEIPT + NATIVE_FOLDER_TRUST_OPTION,
  ...SYNTHETIC_FOLDER_TRUST_REFUSALS.map((output) => RECEIPT + output),
  RECEIPT + "View: https://claude.ai/code/session_OTHER\n",
])("returns the first accepted identity before same-chunk failure (%#)", (output) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
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
it.effect("keeps an earlier diagnostic ahead of a later native cursor-spaced trust option", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project folder", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit("Error: fixture transport interrupted\n");
      h.fake.emit(NATIVE_FOLDER_TRUST_OPTION);
      h.fake.finish(0, 0);
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.outcome).toBe("uncertain");
      expect(error.detail).toBe("fixture transport interrupted");
      expect(h.starts).toHaveLength(1);
      expect(h.fake.writes).toEqual([]);
    }),
  ),
);
it.effect.each([
  "Error: request interrupted\n",
  "Error: trust validation failed\n",
  "Error: Workspace trust check failed\n",
  "Error: This folder is not trusted by the fixture's test users.\n",
])("a generic after-spawn diagnostic without a receipt is uncertain (%#)", (output) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      for (const character of output) h.fake.emit(character);
      expect((yield* Fiber.join(fiber).pipe(Effect.flip)).outcome).toBe("uncertain");
      expect(h.starts).toHaveLength(1);
      expect(h.fake.writes).toEqual([]);
      h.fake.finish(1);
    }),
  ),
);

// Folder trust with a trust policy: GOAT answers Claude's own dialog in its PTY.
// An older layout highlights "Yes" first, so Enter alone accepts.
const PRESELECTED_DIALOG = `${FOLDER_TRUST_PROMPT}${NATIVE_FOLDER_TRUST_OPTION}  2. No, exit\r\n`;
const trustPolicy = () => {
  const accepted: number[] = [];
  return { accepted, trust: { onAccepted: () => accepted.push(accepted.length + 1) } };
};
type Fake = FakePty;
/** Claude 2.1.306: move from "No, exit" to "Yes", wait for the redraw, then confirm. */
const answerNative = (fake: Fake) =>
  Effect.gen(function* () {
    const before = fake.writes.length;
    fake.emit(NATIVE_TRUST_DIALOG);
    // Claude drops keys until its screen settles: nothing is sent while output still arrives.
    expect(fake.writes.slice(before)).toEqual([]);
    yield* TestClock.adjust("500 millis");
    expect(fake.writes.slice(before)).toEqual([DOWN]);
    // Enter waits for the redraw of the moved marker and for the screen to settle again.
    yield* TestClock.adjust("500 millis");
    expect(fake.writes.slice(before)).toEqual([DOWN]);
    fake.emit(NATIVE_TRUST_MOVED);
    yield* TestClock.adjust("500 millis");
    expect(fake.writes.slice(before)).toEqual([DOWN, "\r"]);
  });

it.effect.each([
  { name: "at start", before: "", dialogs: 1 },
  { name: "mid-stream", before: "Preparing cloud session…\r\n", dialogs: 1 },
  { name: "twice", before: "", dialogs: 2 },
])("moves to Yes on Claude's trust dialog $name and keeps the receipt", ({ before, dialogs }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const policy = trustPolicy();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task", policy.trust)
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(before);
      for (let dialog = 0; dialog < dialogs; dialog++) yield* answerNative(h.fake);
      h.fake.emit(RECEIPT);
      const handle = yield* Fiber.join(fiber);
      expect(handle.receipt.taskId).toBe("session_ABC123");
      expect(policy.accepted).toHaveLength(dialogs);
      expect(h.starts).toHaveLength(1);
      h.fake.finish(0);
      yield* handle.exited;
    }),
  ),
);

it.effect("confirms at once when the dialog already highlights Yes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const policy = trustPolicy();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task", policy.trust)
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      // The question renders before its options; only a rendered option is answered.
      h.fake.emit(FOLDER_TRUST_PROMPT);
      expect(h.fake.writes).toEqual([]);
      for (const character of NATIVE_FOLDER_TRUST_OPTION) h.fake.emit(character);
      yield* TestClock.adjust("500 millis");
      expect(h.fake.writes).toEqual(["\r"]);
      h.fake.emit(RECEIPT);
      expect((yield* Fiber.join(fiber)).receipt.taskId).toBe("session_ABC123");
      expect(policy.accepted).toHaveLength(1);
    }),
  ),
);

it.effect("stops answering after three trust prompts and sends nothing more", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task", trustPolicy().trust)
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      for (let dialog = 0; dialog < 3; dialog++) yield* answerNative(h.fake);
      h.fake.emit(NATIVE_TRUST_DIALOG);
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.outcome).toBe("rejected");
      expect(error.detail).toBe(
        "Claude Code kept asking to trust /fixture/project after GOAT accepted it 3 times. No prompt was sent.",
      );
      expect(h.fake.writes).toHaveLength(6);
    }),
  ),
);

it.effect("a trust prompt after the receipt stays uncertain and is never answered", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const policy = trustPolicy();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task", policy.trust)
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(RECEIPT + NATIVE_TRUST_DIALOG);
      const handle = yield* Fiber.join(fiber);
      const failure = yield* handle.exited.pipe(Effect.flip);
      expect(failure.outcome).toBe("uncertain");
      expect(h.fake.writes).toEqual([]);
      expect(policy.accepted).toEqual([]);
    }),
  ),
);

it.effect("a trust dialog that never renders its options rejects after the start window", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task", trustPolicy().trust)
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(FOLDER_TRUST_PROMPT);
      yield* TestClock.adjust("60 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.outcome).toBe("rejected");
      expect(h.fake.writes).toEqual([]);
    }),
  ),
);

/** Interactive Claude shows the dialog, GOAT moves to Yes and confirms, Claude stays open. */
const trustInteractively = (fake: Fake) =>
  Effect.gen(function* () {
    yield* fake.ready;
    yield* answerNative(fake);
    fake.emit("Welcome to Claude Code\r\n");
    yield* TestClock.adjust("3 seconds");
  });

it.effect.each(SYNTHETIC_FOLDER_TRUST_REFUSALS)(
  "after a refusal, trusts the folder in interactive Claude and starts once more (%#)",
  (refusal) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        const policy = trustPolicy();
        const fiber = yield* h.service
          .start(LOGIN, "/fixture/project", "task", policy.trust)
          .pipe(Effect.forkChild);
        yield* h.fake.ready;
        h.fake.emit(refusal);
        h.fake.finish(1);
        const interactive = h.fakes[1]!;
        yield* trustInteractively(interactive);
        const retried = h.fakes[2]!;
        yield* retried.ready;
        retried.emit(RECEIPT);
        const handle = yield* Fiber.join(fiber);
        expect(handle.receipt.taskId).toBe("session_ABC123");
        expect(h.starts.map((start) => [start.args, start.cwd])).toEqual([
          [["--cloud=task"], "/fixture/project"],
          [[], "/fixture/project"],
          [["--cloud=task"], "/fixture/project"],
        ]);
        expect([h.fake.writes, interactive.writes, retried.writes]).toEqual([[], [DOWN, "\r"], []]);
        expect(interactive.kills).toBe(1);
        expect(policy.accepted).toHaveLength(1);
        retried.finish(0);
        yield* handle.exited;
      }),
    ),
);

it.effect("a second refusal after accepting trust is reported and not retried again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task", trustPolicy().trust)
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(SYNTHETIC_FOLDER_TRUST_REFUSALS[0]);
      h.fake.finish(1);
      yield* trustInteractively(h.fakes[1]!);
      yield* h.fakes[2]!.ready;
      h.fakes[2]!.emit(SYNTHETIC_FOLDER_TRUST_REFUSALS[0]);
      h.fakes[2]!.finish(1);
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error).toMatchObject({
        outcome: "rejected",
        detail:
          "Claude Code still refuses /fixture/project after GOAT accepted its trust prompt. No prompt was sent.",
      });
      expect(h.starts).toHaveLength(3);
    }),
  ),
);

it.effect("accepting trust alone moves to Yes, confirms, and closes interactive Claude", () =>
  Effect.gen(function* () {
    const h = yield* makeCliHarness();
    const fiber = yield* h.service.acceptTrust(LOGIN, "/fixture/project").pipe(Effect.forkChild);
    yield* trustInteractively(h.fake);
    yield* Fiber.join(fiber);
    expect(h.fake.writes).toEqual([DOWN, "\r"]);
    expect(h.starts[0]).toMatchObject({ shell: LOGIN.binary, args: [], cwd: "/fixture/project" });
    expect(h.fake.kills).toBe(1);
    expect(h.fake.listeners).toBe(0);
  }),
);

it.effect("accepting trust fails when Claude closes, which is what declining does", () =>
  Effect.gen(function* () {
    const h = yield* makeCliHarness();
    const fiber = yield* h.service.acceptTrust(LOGIN, "/fixture/project").pipe(Effect.forkChild);
    yield* h.fake.ready;
    yield* answerNative(h.fake);
    h.fake.finish(0);
    const error = yield* Fiber.join(fiber).pipe(Effect.flip);
    expect(error).toMatchObject({ outcome: "rejected", reason: "folder_untrusted" });
    expect(error.detail).toContain("closed instead of trusting");
  }),
);

it.effect("accepting trust fails plainly when Claude never shows the prompt", () =>
  Effect.gen(function* () {
    const h = yield* makeCliHarness();
    const fiber = yield* h.service.acceptTrust(LOGIN, "/fixture/project").pipe(Effect.forkChild);
    yield* h.fake.ready;
    h.fake.emit("Choose a theme\r\n");
    yield* TestClock.adjust("30 seconds");
    const error = yield* Fiber.join(fiber).pipe(Effect.flip);
    expect(error).toMatchObject({ outcome: "rejected", reason: "folder_untrusted" });
    expect(h.fake.writes).toEqual([]);
  }),
);
