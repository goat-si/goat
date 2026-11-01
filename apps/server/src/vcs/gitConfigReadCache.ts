import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { detachStackFrame } from "../git/detachStackFrame.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { makeGitMetadataFingerprint } from "./gitMetadataFingerprint.ts";

class GitConfigReadKey extends Data.Class<{
  cwd: string;
  key: string;
  fingerprint: string;
}> {}

export const makeCachedGitConfigReader = Effect.fn("GitConfigReadCache.make")(function* (
  read: GitVcsDriver.GitVcsDriver["Service"]["readConfigValue"],
) {
  const fingerprint = yield* makeGitMetadataFingerprint();
  const reads = yield* Cache.makeWith((input: GitConfigReadKey) => read(input.cwd, input.key), {
    capacity: 2048,
    // Includes and global config can change without touching repository config.
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(1) : Duration.zero),
  });
  return Effect.fn("GitConfigReadCache.read")(function* (cwd: string, key: string) {
    const metadata = yield* fingerprint(cwd);
    return yield* metadata === null
      ? read(cwd, key)
      : detachStackFrame(
          Cache.get(
            reads,
            new GitConfigReadKey({
              cwd: metadata.root,
              key,
              fingerprint: metadata.repository,
            }),
          ),
        );
  });
});
