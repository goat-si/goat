import * as Result from "effect/Result";
import { decodeMergeRequestDetailJson } from "./gitLabMergeRequestJson.ts";

export function gitLabActionSummary(stdout: string) {
  const decoded = decodeMergeRequestDetailJson(stdout.trim());
  if (Result.isFailure(decoded)) return;
  const {
    additions: _additions,
    deletions: _deletions,
    changedFiles: _changedFiles,
    ...summary
  } = decoded.success;
  return summary;
}
