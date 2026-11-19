import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { SourceControlHost } from "./SourceControlHost.ts";

const GIT_CONFIG_MAX_OUTPUT_BYTES = 1_000_000;

export const readFirstFetchUrl = Effect.fn("SourceControlHost.readFirstFetchUrl")(function* (
  git: Pick<SourceControlHost["Service"]["git"], "execute">,
  cwd: string,
  remoteName: string,
) {
  const result = yield* git.execute({
    operation: "SourceControlHost.readFirstFetchUrl",
    cwd,
    args: ["config", "--get-all", `remote.${remoteName}.url`],
    allowNonZeroExit: true,
    maxOutputBytes: GIT_CONFIG_MAX_OUTPUT_BYTES,
  });
  if (result.stdoutTruncated)
    return yield* new GitCommandError({
      operation: "SourceControlHost.readFirstFetchUrl",
      command: "git config",
      cwd,
      detail: "The remote configuration output was truncated.",
    });
  return result.stdout.split("\n", 1)[0]?.trim() || null;
});
