import type { PullRequestActor } from "@goat/contracts";
import * as Schema from "effect/Schema";

export const forkFields = Schema.Struct({
  source_project_id: Schema.optional(Schema.NullOr(Schema.Int)),
  target_project_id: Schema.optional(Schema.NullOr(Schema.Int)),
  allow_collaboration: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export function forkMaintainerEdits(raw: typeof forkFields.Type) {
  return raw.source_project_id != null &&
    raw.target_project_id != null &&
    raw.source_project_id !== raw.target_project_id
    ? { maintainerCanModify: raw.allow_collaboration === true }
    : {};
}

export interface GitLabMaintainerEdits {
  readonly maintainerCanModify?: boolean;
  readonly viewerCanEditMaintainerEdits?: boolean;
}

export function toChangedFiles(value: string | null | undefined): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export interface GitLabReviewerDetails {
  readonly reviewerUsers: ReadonlyArray<PullRequestActor & { readonly id: number }>;
  readonly reviewerIds: ReadonlyArray<number>;
}
export function reviewerInfo<A extends { readonly id?: number | undefined }>(
  reviewers: ReadonlyArray<A>,
  actorOf: (reviewer: A) => PullRequestActor | null,
) {
  return {
    reviewerIds: reviewers.flatMap((reviewer) => (reviewer.id === undefined ? [] : [reviewer.id])),
    reviewerUsers: reviewers.flatMap((reviewer) => {
      const actor = actorOf(reviewer);
      return actor === null || reviewer.id === undefined ? [] : [{ ...actor, id: reviewer.id }];
    }),
  };
}
