import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { requireReleaseCommand } from "./release-verify.ts";

export const stageDesktopComputerUseHelper = Effect.fn("stageDesktopComputerUseHelper")(
  function* (input: {
    readonly repoRoot: string;
    readonly output: string;
    readonly channel: "latest" | "nightly";
    readonly signed: boolean;
  }) {
    if (!input.signed) return undefined;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const args = [
      path.join(input.repoRoot, "scripts/build-computer-use-helper.ts"),
      "--channel",
      input.channel === "nightly" ? "nightly" : "stable",
      "--output",
      input.output,
    ];
    if (process.env.CSC_NAME) args.push("--identity", process.env.CSC_NAME);
    if (process.env.APPLE_KEYCHAIN_PROFILE)
      args.push("--notary-profile", process.env.APPLE_KEYCHAIN_PROFILE);
    const exit = yield* spawner.spawn(ChildProcess.make(process.execPath, args)).exitCode;
    if (exit !== 0)
      return yield* requireReleaseCommand(
        () => Effect.succeed({ exitCode: exit, stdout: "", stderr: "" }),
        "node",
        args,
      );
    return path.join(input.output, "GOAT Computer Use.app");
  },
);
