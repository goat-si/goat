import * as Effect from "effect/Effect";
import { parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";

export const resolvePublishBranchName = (_cwd: string, branchName: string, remoteName: string) =>
  Effect.succeed(parseRemoteRefWithRemoteNames(branchName, [remoteName])?.branchName ?? branchName);
