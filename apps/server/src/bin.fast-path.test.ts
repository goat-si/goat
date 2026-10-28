import { assert, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Exit from "effect/Exit";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import packageJson from "../package.json" with { type: "json" };

it.effect.each(["--version", "__ssh-helper"] as const)(
  "%s completes without importing the full CLI",
  (command) =>
    Effect.gen(function* () {
      vi.resetModules();
      let running: Effect.Effect<Exit.Exit<unknown, unknown>> | undefined;
      vi.doMock("./entrypoint.ts", () => ({ isEntrypoint: () => true }));
      vi.doMock("./binCli.ts", () => {
        throw new Error("full CLI imported");
      });
      vi.doMock("./cli/consoleStdin.ts", () => ({ attachConsoleStdin: () => {} }));
      vi.doMock("@effect/platform-node/NodeRuntime", () => ({
        runMain: <E>(effect: Effect.Effect<unknown, E>) => {
          running = Effect.exit(effect);
        },
      }));
      const argv = process.argv;
      const exitCode = process.exitCode;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      process.argv = [
        argv[0] ?? "node",
        "/fixture/bin.ts",
        command,
        ...(command === "__ssh-helper" ? ["protocol", "--shell"] : []),
      ];
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.argv = argv;
          process.exitCode = exitCode;
          vi.doUnmock("./entrypoint.ts");
          vi.doUnmock("./binCli.ts");
          vi.doUnmock("./cli/consoleStdin.ts");
          vi.doUnmock("@effect/platform-node/NodeRuntime");
          vi.resetModules();
          log.mockRestore();
          write.mockRestore();
        }),
      );
      yield* Effect.promise(() => import("./bin.ts"));
      assert.isDefined(running);
      const exit = yield* running.pipe(Effect.provideService(Console.Console, console));
      expect(Exit.isSuccess(exit)).toBe(true);
      if (command === "--version") {
        expect(log).toHaveBeenCalledWith(`goat v${packageJson.version}`);
      } else {
        const tokens = write.mock.calls
          .map(([value]) => String(value))
          .join("")
          .trim()
          .split(" ");
        expect(tokens).toHaveLength(5);
        expect(tokens[0]).toBe(packageJson.version);
        expect(tokens.slice(1, 3).every((value) => /^[1-9][0-9]*$/u.test(value))).toBe(true);
        expect(tokens.slice(3)).toEqual(["0", "0"]);
      }
    }),
);

it.effect.each([
  { label: "version", args: ["--version"] },
  { label: "probe", args: ["__ssh-helper", "protocol", "--shell"] },
  { label: "unknown flag", args: ["__ssh-helper", "protocol", "--invalid-helper-flag"] },
  { label: "missing flag value", args: ["__ssh-helper", "protocol", "--runtime-file"] },
  { label: "completions", args: ["__ssh-helper", "protocol", "--completions", "bash"] },
  { label: "help", args: ["__ssh-helper", "protocol", "--help"] },
])("matches the full CLI for helper arguments: $label", ({ args }) =>
  Effect.gen(function* () {
    vi.resetModules();
    let running: Effect.Effect<Exit.Exit<unknown, unknown>> | undefined;
    vi.doMock("./entrypoint.ts", () => ({ isEntrypoint: () => true }));
    vi.doMock("./cli/consoleStdin.ts", () => ({ attachConsoleStdin: () => {} }));
    vi.doMock("@effect/platform-node/NodeRuntime", () => ({
      runMain: <E>(effect: Effect.Effect<unknown, E>) => {
        running = Effect.exit(effect);
      },
    }));
    const argv = process.argv;
    const exitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = [argv[0] ?? "node", "/fixture/bin.ts", ...args];
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.argv = argv;
        process.exitCode = exitCode;
        vi.doUnmock("./entrypoint.ts");
        vi.doUnmock("./cli/consoleStdin.ts");
        vi.doUnmock("@effect/platform-node/NodeRuntime");
        vi.resetModules();
        log.mockRestore();
        error.mockRestore();
        write.mockRestore();
      }),
    );
    const { runCliWithArgs } = yield* Effect.promise(() => import("./binCli.ts"));
    const expected = yield* runCliWithArgs(args).pipe(
      Effect.scoped,
      Effect.provide([NodeServices.layer, NetService.layer]),
      Effect.provideService(Console.Console, console),
      Effect.exit,
    );
    const expectedLogs = [...log.mock.calls];
    const expectedErrors = [...error.mock.calls];
    const expectedWrites = [...write.mock.calls];
    expect(expectedLogs.length + expectedErrors.length + expectedWrites.length).toBeGreaterThan(0);
    log.mockClear();
    error.mockClear();
    write.mockClear();

    yield* Effect.promise(() => import("./bin.ts"));
    assert.isDefined(running);
    const actual = yield* running.pipe(Effect.provideService(Console.Console, console));
    expect(actual._tag).toBe(expected._tag);
    if (Exit.isFailure(expected) && Exit.isFailure(actual)) {
      expect(Cause.squash(actual.cause)).toEqual(Cause.squash(expected.cause));
    }
    expect(log.mock.calls).toEqual(expectedLogs);
    expect(error.mock.calls).toEqual(expectedErrors);
    expect(write.mock.calls).toEqual(expectedWrites);
  }),
);
