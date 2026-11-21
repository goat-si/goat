import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import * as HostProcess from "./HostProcess.ts";
import {
  mergePathEntries,
  mergePathValues,
  readPathFromLaunchctl,
  resolveCommandPath,
} from "./shell.ts";

it("keeps POSIX whitespace and literal quotes while merging PATH", () => {
  const preferred = ' /bin space :"/literal"';
  expect(mergePathEntries(preferred, "/other", "linux")).toBe(`${preferred}:/other`);
  expect(mergePathValues(preferred, "/other", "linux")).toBe(`${preferred}:/other`);
});

it("preserves the launchctl PATH apart from its output newline", () => {
  expect(readPathFromLaunchctl(() => ' /quoted path /:"/bin"\n')).toBe(' /quoted path /:"/bin"');
});

// Windows filenames cannot contain literal double quotes.
it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "resolves commands in a POSIX PATH directory containing literal quotes and whitespace",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-posix-path-" });
      const dir = path.join(root, ' "quoted" ');
      yield* fs.makeDirectory(dir);
      const executable = path.join(dir, "goat-path-fixture");
      yield* fs.writeFileString(executable, "fixture");
      yield* fs.chmod(executable, 0o755);
      const found = yield* resolveCommandPath("goat-path-fixture", { env: { PATH: dir } }).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(found).toBe(executable);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
