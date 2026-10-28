import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { quoteGoatExecutable } from "./childPrepare.ts";

const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.live("keeps apostrophes and command substitution in a GOAT executable path inert", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-quote-executable-" });
    const executable = path.join(
      dir,
      "runtime with ' quote $(touch pwned) `touch pwned-too` $HOME;id",
      "goat",
    );
    // The shell reads the quoted value back as exactly the same bytes and runs nothing in it.
    const output = yield* (yield* ProcessRunner.ProcessRunner).run({
      command: "/bin/sh",
      args: ["-c", `printf '%s' ${quoteGoatExecutable(executable)}`],
      cwd: dir,
      env: { HOME: dir, PATH: "/usr/bin:/bin" },
    });
    expect(output.stdout).toBe(executable);
    expect(yield* fs.exists(path.join(dir, "pwned"))).toBe(false);
    expect(yield* fs.exists(path.join(dir, "pwned-too"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.each([
  ["a relative path", "relative/goat"],
  ["a newline", "/opt/goat\nid"],
  ["a carriage return", "/opt/goat\rid"],
  ["a NUL byte", "/opt/goat\0id"],
])("refuses a GOAT executable path with %s", (_name, unsafe) => {
  expect(() => quoteGoatExecutable(unsafe)).toThrow(TypeError);
});
