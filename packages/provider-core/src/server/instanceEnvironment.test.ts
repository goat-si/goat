// @effect-diagnostics nodeBuiltinImport:off -- util.inspect shows whether the copy is a plain object.
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@goat/shared/HostProcess";
import { syncHostEnvironmentFollowers } from "@goat/shared/hostEnvironmentFollowers";

import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
          ],
          { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        PATH: "/bin",
      });
    }),
  );

  it.effect("an instance copy takes the host's new PATH on a sync, and stays a plain copy", () =>
    Effect.gen(function* () {
      const host: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        OTHER: "old",
        GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [{ name: "CUSTOM_VALUE", value: "own", sensitive: false }],
        host,
      );
      const ownPath = yield* mergeProviderInstanceEnvironment(
        [{ name: "PATH", value: "/instance/bin", sensitive: false }],
        host,
      );
      const before = {
        PATH: host.PATH,
        GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: host.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING,
      };
      host.PATH = "/home/ada/.local/bin:/usr/bin";
      host.OTHER = "new";
      delete host.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING;
      syncHostEnvironmentFollowers(before, host);

      expect(environment).toEqual({
        PATH: "/home/ada/.local/bin:/usr/bin",
        OTHER: "old",
        CUSTOM_VALUE: "own",
      });
      expect(ownPath).toEqual({ PATH: "/instance/bin", OTHER: "old" });
      expect(Object.getPrototypeOf(environment)).toBe(Object.prototype);
      expect(NodeUtil.inspect(environment)).toContain("CUSTOM_VALUE: 'own'");
      expect(structuredClone(environment)).toEqual(environment);
    }),
  );
});
