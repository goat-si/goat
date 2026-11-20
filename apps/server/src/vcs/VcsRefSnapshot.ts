import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const REF_SNAPSHOT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export class VcsRefSnapshot extends Context.Reference<
  (cwd: string) => Effect.Effect<string | null>
>("goat/vcs/VcsRefSnapshot", { defaultValue: () => () => Effect.succeed(null) }) {}

export const layer = Layer.effect(
  VcsRefSnapshot,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return Effect.fn("VcsRefSnapshot.read")(
      function* (cwd: string) {
        const read = (args: string[]) =>
          git.execute({
            operation: "VcsRefSnapshot.read",
            cwd,
            args,
            allowNonZeroExit: true,
            maxOutputBytes: REF_SNAPSHOT_MAX_OUTPUT_BYTES,
          });
        const refs = yield* read(["show-ref", "--head"]);
        if (refs.exitCode !== 0 || refs.stdoutTruncated) return null;
        const head = yield* read(["symbolic-ref", "--quiet", "HEAD"]);
        if ((head.exitCode !== 0 && head.exitCode !== 1) || head.stdoutTruncated) return null;
        const common = yield* read(["rev-parse", "--git-common-dir"]);
        if (common.exitCode !== 0 || common.stdoutTruncated || !common.stdout.trim()) return null;
        const shallowPath = path.resolve(cwd, common.stdout.trim(), "shallow");
        let shallow = "";
        if (yield* fs.exists(shallowPath)) {
          const hash = yield* read(["hash-object", "--no-filters", "--", shallowPath]);
          if (hash.exitCode !== 0 || hash.stdoutTruncated) return null;
          shallow = hash.stdout;
        }
        return `${refs.stdout}\0${head.stdout}\0${shallow}`;
      },
      Effect.orElseSucceed(() => null),
    );
  }),
);
