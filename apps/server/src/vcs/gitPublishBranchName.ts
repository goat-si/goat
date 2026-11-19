import * as Effect from "effect/Effect";
import type { GitCommandError } from "@goat/contracts";
import { parseRemoteRefWithRemoteNames } from "./gitRemoteParsing.ts";

export function makeResolvePublishBranchName(
  listRemoteNames: (cwd: string) => Effect.Effect<ReadonlyArray<string>, GitCommandError>,
) {
  const resolvePublishBranchName = Effect.fn("resolvePublishBranchName")(function* (
    cwd: string,
    branchName: string,
  ) {
    const remoteNames = yield* listRemoteNames(cwd).pipe(Effect.orElseSucceed(() => []));
    const parsedRemoteRef = parseRemoteRefWithRemoteNames(branchName, remoteNames);
    return parsedRemoteRef?.branchName ?? branchName;
  });

  return resolvePublishBranchName;
}
