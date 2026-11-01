import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const makeSetupHookFixture = Effect.fn("test.makeSetupHookFixture")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hooksDirectory = path.join(cwd, ".git", "counting-hooks");
  const startsPath = path.join(cwd, ".git", "setup-starts");
  const hookPath = path.join(hooksDirectory, "post-checkout");
  yield* fs.makeDirectory(hooksDirectory, { recursive: true });
  yield* fs.writeFileString(startsPath, "");
  yield* fs.writeFileString(
    hookPath,
    `#!/bin/sh
[ "\${GOAT_WORKTREE_SETUP:-}" != 0 ] || exit 0
printf 'hook\\n' >> "$(git rev-parse --git-common-dir)/setup-starts"
`,
  );
  yield* fs.chmod(hookPath, 0o755);
  const recordServerSetup = fs
    .writeFileString(startsPath, "server\n", { flag: "a" })
    .pipe(Effect.orDie);
  const starts = fs
    .readFileString(startsPath)
    .pipe(Effect.map((contents) => contents.trim().split("\n")));
  return { hooksDirectory, recordServerSetup, starts };
});
