import * as Effect from "effect/Effect";
import { buildComputerUseHelper } from "../build-computer-use-helper.ts";

export const stageDesktopComputerUseHelper = Effect.fn("stageDesktopComputerUseHelper")(
  function* (input: {
    readonly repoRoot: string;
    readonly output: string;
    readonly channel: "latest" | "nightly";
    readonly signed: boolean;
  }) {
    if (!input.signed) return undefined;
    return (yield* buildComputerUseHelper({
      ...input,
      channel: input.channel === "nightly" ? "nightly" : "stable",
      adHoc: false,
      identity: process.env.CSC_NAME,
      notaryProfile: process.env.APPLE_KEYCHAIN_PROFILE,
    })).bundle;
  },
);
