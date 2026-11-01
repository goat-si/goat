import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";

import { cli } from "../binCli.ts";

/**
 * `goat opencodex install` as a person runs it, in a temporary home. The filesystem answers
 * `exists` only inside that home, so this machine's own OpenCodex is never selected.
 */
const run = Effect.fn("OpenCodexCliTest.run")(function* (desktopVersion: string) {
  const real = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* real.makeTempDirectoryScoped({ prefix: "goat-ocx-cli-" });
  const desktop = path.join(home, ".opencodex-desktop", "bin", "ocx");
  yield* real.makeDirectory(path.dirname(desktop), { recursive: true });
  yield* real.writeFileString(
    desktop,
    `#!/bin/sh\n[ "$1" = --version ] && echo 'opencodex ${desktopVersion}'\n`,
    { mode: 0o755 },
  );
  const sandboxed: FileSystem.FileSystem = {
    ...real,
    exists: (file) => (file.startsWith(home) ? real.exists(file) : Effect.succeed(false)),
  };
  const printedBefore = (yield* TestConsole.logLines).length;
  const exit = yield* Command.runWith(cli, { version: "0.0.0" })([
    "opencodex",
    "install",
    "--print-path",
  ]).pipe(
    Effect.provideService(FileSystem.FileSystem, sandboxed),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.WorkingDirectory, home),
    Effect.provideService(HostProcess.Environment, { HOME: home, PATH: "/usr/bin:/bin" }),
    Effect.exit,
  );
  const lines = (yield* TestConsole.logLines).slice(printedBefore);
  return { exit, home, desktop, lines, real };
});

it.live(
  "prints only the selected path for print-path and propagates install errors without starting GOAT",
  () =>
    Effect.gen(function* () {
      const kept = yield* run("2.70.0");
      expect(kept.exit._tag).toBe("Success");
      expect(kept.lines).toEqual([kept.desktop]);
      // No server state was created: the command never hydrates settings or a database.
      expect(yield* kept.real.readDirectory(kept.home)).toEqual([".opencodex-desktop"]);

      const refused = yield* run("2.65.0");
      expect(refused.exit._tag).toBe("Failure");
      expect(String(refused.exit)).toContain(
        "Another ocx is selected before the GOAT-managed install",
      );
      expect(refused.lines).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
    ),
);
