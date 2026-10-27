// @effect-diagnostics nodeBuiltinImport:off -- runs the written shim as a real process.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ensureUrlOpenerShim, instanceUrlOpener } from "./UrlOpenerShim.ts";

/** Writes the shim as a server started as `node <entry>` would, with the given environment. */
const writeShim = (environment: NodeJS.ProcessEnv, directoryName = "run") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-url-opener-" });
    const directory = path.join(root, directoryName);
    yield* fs.makeDirectory(directory);
    // Stands in for the server entry: reports the arguments the shim passed it.
    const entry = path.join(root, "entry.mjs");
    yield* fs.writeFileString(
      entry,
      "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE }))",
    );
    const shim = yield* ensureUrlOpenerShim(directory).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, environment),
      Effect.provideService(HostProcess.ExecutablePath, process.execPath),
      Effect.provideService(HostProcess.IsExecutable, false),
      Effect.provideService(HostProcess.Arguments, [process.execPath, entry]),
    );
    return shim;
  });

describe("GOAT's BROWSER shim", () => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "passes the URL to the server's opener command unchanged",
    () =>
      Effect.gen(function* () {
        const shim = yield* writeShim({});
        expect(shim).toBeDefined();
        const url = "https://example.com/a?b=1&c='$(touch x)'#`id`";
        const child = NodeChildProcess.spawnSync(shim!, [url], { encoding: "utf8" });

        expect(JSON.parse(child.stdout)).toEqual({ args: ["__open-url", url], electron: "1" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a BROWSER the user already set, and a path BROWSER readers would split", () =>
    Effect.gen(function* () {
      expect(yield* writeShim({ BROWSER: "firefox" })).toBeUndefined();
      expect(yield* writeShim({}, "with space")).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("is left out for a provider instance whose environment settings set BROWSER", () =>
    Effect.gen(function* () {
      const settings = Option.some({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex-firefox")]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "BROWSER", value: "firefox", sensitive: false }],
            },
          },
        }),
      });
      const config = {
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer fixture",
        browserToolsAvailable: true,
        urlOpener: "/tmp/goat-threads-fixture/goat-browser",
      };
      const chosen = yield* instanceUrlOpener(settings, ProviderInstanceId.make("codex-firefox"));
      const unchosen = yield* instanceUrlOpener(settings, ProviderInstanceId.make("codex"));

      expect(chosen(config).urlOpener).toBeUndefined();
      expect(unchosen(config).urlOpener).toBe(config.urlOpener);
    }),
  );
});
