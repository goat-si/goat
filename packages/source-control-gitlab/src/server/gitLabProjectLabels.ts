import type { PullRequestLabel } from "@goat/contracts";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";

import {
  decodeLabelEntry,
  decodeUnknownList,
  trimmed,
  type DecodeFailure,
} from "./gitLabMergeRequestJson.ts";

export interface GitLabProjectLabel extends PullRequestLabel {
  readonly description: string | null;
  readonly archived: boolean;
}

export interface GitLabProjectLabels {
  readonly labels: ReadonlyArray<GitLabProjectLabel>;
  readonly rawCount: number;
}

export function decodeProjectLabelsJson(
  raw: string,
): Result.Result<GitLabProjectLabels, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const labels: GitLabProjectLabel[] = [];
  for (const entry of decoded.success) {
    const label = decodeLabelEntry(entry);
    if (Exit.isFailure(label)) continue;
    const name = trimmed(label.value.name);
    if (name !== null) {
      labels.push({
        name,
        color: trimmed(label.value.color),
        description: trimmed(label.value.description),
        archived: label.value.archived === true,
      });
    }
  }
  return Result.succeed({ labels, rawCount: decoded.success.length });
}
