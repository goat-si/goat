import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { requireReleaseCommand, runReleaseCommand } from "./release-verify.ts";

export const stageDesktopComputerUseHelper = Effect.fn("stageDesktopComputerUseHelper")(
  function* (input: {
    readonly repoRoot: string;
    readonly output: string;
    readonly channel: "latest" | "nightly";
    readonly signed: boolean;
  }) {
    if (!input.signed) return undefined;
    const path = yield* Path.Path;
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
    yield* requireReleaseCommand(runReleaseCommand, process.execPath, args);
    return path.join(input.output, "GOAT Computer Use.app");
  },
);
