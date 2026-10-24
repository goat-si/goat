import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { requireReleaseCommand, runReleaseCommand } from "./release-verify.ts";

/**
 * The helper channel a packaged app embeds. Never "dev": a dev helper skips its parent check
 * (GOATComputerUseAllowAnyParent), so it must not ship in a nightly or stable app.
 */
export const packagedHelperChannel = (updateChannel: "latest" | "nightly") =>
  updateChannel === "nightly" ? ("nightly" as const) : ("stable" as const);

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
      packagedHelperChannel(input.channel),
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
