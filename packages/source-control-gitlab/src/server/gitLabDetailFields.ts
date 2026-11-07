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
