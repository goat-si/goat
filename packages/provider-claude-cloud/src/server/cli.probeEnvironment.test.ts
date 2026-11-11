import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeCliHarness, LOGIN, RECEIPT } from "./testing.ts";

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
        for (const [index, command] of h.commands.entries()) {
          expect(command.command).toBe(LOGIN.binary);
          expect(command.options.env).toEqual(
            index < 3
              ? {
                  ...expectedEnvironment,
                  MISE_OFFLINE: "1",
                  npm_config_offline: "true",
                  NPM_CONFIG_OFFLINE: "true",
                  UV_OFFLINE: "1",
                  COREPACK_ENABLE_NETWORK: "0",
                }
              : expectedEnvironment,
          );
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
        expect(h.commands.map((command) => command.command)).toEqual([
          LOGIN.binary,
          LOGIN.binary,
          LOGIN.binary,
        ]);
        expect(h.commands.map((command) => command.options.env)).toEqual(
          Array.from({ length: 3 }, () => ({
            ...LOGIN.environment,
            MISE_OFFLINE: "1",
            npm_config_offline: "true",
            NPM_CONFIG_OFFLINE: "true",
            UV_OFFLINE: "1",
            COREPACK_ENABLE_NETWORK: "0",
          })),
        );
      }),
    ),
);
