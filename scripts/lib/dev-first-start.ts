import { describePrivateDevDirectoryChange, ensurePrivateDevDirectory } from "@goat/shared/devHome";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";

// A pruned migrate-dev-db copy is tens of MB; some worktrees hold a full copy
// of the live database instead.
const LARGE_DEV_DATABASE_BYTES = 500 * 1024 * 1024;

/** Best effort: a failed first-start step warns, and dev still starts. */
const runRepoScript = Effect.fn("dev-runner.runRepoScript")(function* (
  repoRoot: string,
  script: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const exitCode = yield* ChildProcess.make(
    yield* HostProcess.ExecutablePath,
    [path.join(repoRoot, script), ...args],
    { cwd: repoRoot, stdin: "ignore", stdout: "inherit", stderr: "inherit", env, extendEnv: false },
  ).pipe(
    Effect.flatMap((child) => child.exitCode),
    Effect.scoped,
    Effect.orElseSucceed(() => -1),
  );
  if (exitCode !== 0) {
    yield* Effect.logWarning(`[dev-runner] ${script} failed; starting anyway.`);
  }
});

/**
 * Before each start, a worktree's own home is made private, which is not best
 * effort: the server would keep a writable home and refuse memory import. The
 * first start also seeds its empty database from the live install and warms
 * the web dependency cache. Each of those checks for its own output, so later
 * starts skip it.
 */
export const prepareFirstStart = Effect.fn("dev-runner.prepareFirstStart")(function* (input: {
  readonly repoRoot: string;
  readonly mode: string;
  readonly seed: boolean;
  readonly worktreeHome: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  if (input.worktreeHome !== undefined && input.mode !== "dev:web") {
    const stateDir = path.join(input.worktreeHome, "userdata");
    for (const directory of [input.worktreeHome, stateDir]) {
      const change = yield* ensurePrivateDevDirectory(directory);
      if (change !== undefined) {
        yield* Effect.logInfo(
          `[dev-runner] ${describePrivateDevDirectoryChange(directory, change)}`,
        );
      }
    }
    for (const name of ["statev2.sqlite", "state.sqlite"]) {
      const file = path.join(stateDir, name);
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isSome(info) && Number(info.value.size) > LARGE_DEV_DATABASE_BYTES) {
        yield* Effect.logWarning(
          `[dev-runner] ${file} is ${Math.round(Number(info.value.size) / 1024 / 1024)} MB. With the dev server stopped, \`vp run migrate-dev-db\` rebuilds statev2.sqlite as a small copy of recent data.`,
        );
      }
    }
    // GOAT's live data, or the legacy ~/.t3 home when GOAT has none, as migrate-dev-db picks it.
    const homeDirectory = yield* HostProcess.HomeDirectory;
    let source: string | undefined;
    for (const home of [".goat", ".t3"]) {
      const candidate = path.join(homeDirectory, home, "userdata", "statev2.sqlite");
      if (yield* exists(candidate)) {
        source = candidate;
        break;
      }
    }
    // A V1 state.sqlite counts as data too: the server imports it only while
    // statev2.sqlite is missing, so seeding would hide it.
    if (
      input.seed &&
      !(yield* exists(path.join(stateDir, "statev2.sqlite"))) &&
      !(yield* exists(path.join(stateDir, "state.sqlite"))) &&
      source !== undefined
    ) {
      yield* Effect.logInfo(
        `[dev-runner] seeding ${input.worktreeHome} from ${source} (read-only). --no-seed or GOAT_DEV_SEED=0 skips this.`,
      );
      yield* runRepoScript(
        input.repoRoot,
        "apps/server/scripts/migrate-dev-db.ts",
        ["--base-dir", input.worktreeHome, "--source", source],
        input.env,
      );
    }
  }

  if (
    input.mode !== "dev:server" &&
    !(yield* exists(path.join(input.repoRoot, "apps/web/node_modules/.vite/deps/_metadata.json")))
  ) {
    yield* runRepoScript(input.repoRoot, "apps/web/scripts/warm-dep-cache.ts", [], input.env);
  }
});
