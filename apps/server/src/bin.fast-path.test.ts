import { expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import packageJson from "../package.json" with { type: "json" };

it.each(["--version", "__ssh-helper"] as const)(
  "%s completes without importing the full CLI",
  async (command) => {
    vi.resetModules();
    let running: Promise<unknown> | undefined;
    vi.doMock("./entrypoint.ts", () => ({ isEntrypoint: () => true }));
    vi.doMock("./binCli.ts", () => {
      throw new Error("full CLI imported");
    });
    vi.doMock("./cli/consoleStdin.ts", () => ({ attachConsoleStdin: () => {} }));
    vi.doMock("@effect/platform-node/NodeRuntime", () => ({
      runMain: (effect: Effect.Effect<unknown, unknown>) => {
        running = Effect.runPromise(effect);
      },
    }));
    const argv = process.argv;
    const exitCode = process.exitCode;
    using log = vi.spyOn(console, "log").mockImplementation(() => {});
    using write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = [
      argv[0] ?? "node",
      "/fixture/bin.ts",
      command,
      ...(command === "__ssh-helper" ? ["protocol", "--shell"] : []),
    ];
    try {
      await import("./bin.ts");
      expect(running).toBeDefined();
      await running;
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
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      vi.doUnmock("./entrypoint.ts");
      vi.doUnmock("./binCli.ts");
      vi.doUnmock("./cli/consoleStdin.ts");
      vi.doUnmock("@effect/platform-node/NodeRuntime");
      vi.resetModules();
    }
  },
);

it.each([
  { label: "unknown flag", args: ["__ssh-helper", "protocol", "--invalid-helper-flag"] },
  { label: "missing flag value", args: ["__ssh-helper", "protocol", "--runtime-file"] },
])("preserves full CLI errors for helper arguments: $label", async ({ args }) => {
  vi.resetModules();
  let running: Promise<Exit.Exit<unknown, unknown>> | undefined;
  vi.doMock("./entrypoint.ts", () => ({ isEntrypoint: () => true }));
  vi.doMock("./cli/consoleStdin.ts", () => ({ attachConsoleStdin: () => {} }));
  vi.doMock("@effect/platform-node/NodeRuntime", () => ({
    runMain: (effect: Effect.Effect<unknown, unknown>) => {
      running = Effect.runPromiseExit(effect);
    },
  }));
  const argv = process.argv;
  const exitCode = process.exitCode;
  using log = vi.spyOn(console, "log").mockImplementation(() => {});
  using error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [argv[0] ?? "node", "/fixture/bin.ts", ...args];
  try {
    const { runCliWithArgs } = await import("./binCli.ts");
    const expected = await Effect.runPromiseExit(
      runCliWithArgs(args).pipe(
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.provide(NetService.layer),
      ),
    );
    const expectedLogs = [...log.mock.calls];
    const expectedErrors = [...error.mock.calls];
    log.mockClear();
    error.mockClear();

    await import("./bin.ts");
    expect(running).toBeDefined();
    const actual = await running;
    expect(Exit.isFailure(expected)).toBe(true);
    expect(actual && Exit.isFailure(actual)).toBe(true);
    if (Exit.isFailure(expected) && actual && Exit.isFailure(actual)) {
      expect(Cause.squash(actual.cause)).toEqual(Cause.squash(expected.cause));
    }
    expect(log.mock.calls).toEqual(expectedLogs);
    expect(error.mock.calls).toEqual(expectedErrors);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    vi.doUnmock("./entrypoint.ts");
    vi.doUnmock("./cli/consoleStdin.ts");
    vi.doUnmock("@effect/platform-node/NodeRuntime");
    vi.resetModules();
  }
});
