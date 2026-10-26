import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ReleaseVerificationError, runReleaseCommand } from "./release-verify.ts";

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
    if (process.env.GOAT_CLI_MAC_SIGN_IDENTITY)
      args.push("--identity", process.env.GOAT_CLI_MAC_SIGN_IDENTITY);
    if (process.env.APPLE_KEYCHAIN_PROFILE)
      args.push("--notary-profile", process.env.APPLE_KEYCHAIN_PROFILE);
    const result = yield* runReleaseCommand(process.execPath, args);
    if (result.exitCode !== 0)
      return yield* new ReleaseVerificationError({
        problems: [
          `GOAT Computer Use build failed (${result.exitCode}). stdout: ${result.stdout.trim()} stderr: ${result.stderr.trim()}`,
        ],
      });
    return path.join(input.output, "GOAT Computer Use.app");
  },
);
