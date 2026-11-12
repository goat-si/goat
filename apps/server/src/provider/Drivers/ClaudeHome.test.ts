import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { syncHostEnvironmentFollowers } from "@goat/shared/hostEnvironmentFollowers";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  it.effect(
    "drops the launching Claude session and Electron's run-as-Node flag, and labels processes t3-code unless overridden",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-claude-home-" });
        const host = {
          CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "host-session",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/host-claude.sock",
          CLAUDE_EFFORT: "high",
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "1",
        };
        const instance = [
          { name: "CLAUDE_CODE_ENTRYPOINT", value: "instance", sensitive: false },
          { name: "CLAUDE_EFFORT", value: "low", sensitive: false },
        ];

        expect(yield* mergeClaudeProcessEnvironment({ homePath }, undefined, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "t3-code",
          KEEP: "1",
        });
        expect(yield* mergeClaudeProcessEnvironment({ homePath }, instance, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "instance",
          CLAUDE_EFFORT: "low",
          KEEP: "1",
        });

        yield* fileSystem.writeFileString(
          path.join(homePath, "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: "custom" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("custom");
      }),
  );

  it.effect(
    "the environment Claude is started with takes the host's new PATH and nothing else",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-claude-home-" });
        const host: NodeJS.ProcessEnv = {
          PATH: "/usr/bin",
          CLAUDECODE: "1",
          ELECTRON_RUN_AS_NODE: "1",
          OTHER: "old",
          GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
        };
        const merged = yield* mergeClaudeProcessEnvironment({ homePath }, undefined, host);
        const started = yield* makeClaudeEnvironment({ homePath }, merged);
        const before = {
          PATH: host.PATH,
          GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: host.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING,
        };
        host.PATH = "/home/ada/.local/bin:/usr/bin";
        host.OTHER = "new";
        delete host.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING;
        syncHostEnvironmentFollowers(before, host);

        // The launching session's variables stay deleted, and other host changes are not copied.
        const followed = {
          PATH: "/home/ada/.local/bin:/usr/bin",
          OTHER: "old",
          CLAUDE_CODE_ENTRYPOINT: "t3-code",
        };
        expect(merged).toEqual(followed);
        expect(started).toEqual({
          ...followed,
          CLAUDE_CONFIG_DIR: yield* resolveClaudeHomePath({ homePath }),
        });
        expect(Object.getPrototypeOf(started)).toBe(Object.prototype);
      }),
  );

  it.effect("the capabilities cache key changes when PATH does", () =>
    Effect.gen(function* () {
      const config = { binaryPath: "claude", homePath: "/claude-home" };
      const key = (PATH: string) => makeClaudeCapabilitiesCacheKey(config, "/repo", { PATH });
      expect(yield* key("/usr/bin")).toBe(yield* key("/usr/bin"));
      expect(yield* key("/usr/bin")).not.toBe(yield* key("/home/ada/.local/bin:/usr/bin"));
    }),
  );
});
