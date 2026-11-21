import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId } from "@goat/contracts";
import {
  PULL_REQUEST_SAVED_VIEWS_MAX_COUNT,
  PULL_REQUEST_VIEW_FIELD_MAX_LENGTH,
  PullRequestSavedViewIdentity,
} from "@goat/client-runtime/pull-request-saved-views";

import {
  pullRequestListPreferences,
  PullRequestListPreferencesSchema,
  type PullRequestListPreferencePatch,
  type PullRequestListPreferences,
} from "./pullRequestListPreferences";

export const PULL_REQUEST_SAVED_VIEWS_KEY = "goat.pullRequests.savedViews";

export const PullRequestSavedViewSchema = Schema.Struct({
  ...PullRequestSavedViewIdentity.fields,
  preferences: Schema.Struct({
    ...PullRequestListPreferencesSchema.fields,
    environmentId: Schema.optional(
      EnvironmentId.check(Schema.isMaxLength(PULL_REQUEST_VIEW_FIELD_MAX_LENGTH)),
    ),
    projectId: Schema.optional(
      ProjectId.check(Schema.isMaxLength(PULL_REQUEST_VIEW_FIELD_MAX_LENGTH)),
    ),
  }),
});
export const PullRequestSavedViews = Schema.Array(Schema.Unknown);
export type PullRequestSavedView = typeof PullRequestSavedViewSchema.Type;
export const EMPTY_PULL_REQUEST_SAVED_VIEWS: ReadonlyArray<unknown> = [];
export const isSavedView = Schema.is(PullRequestSavedViewSchema);
export function decodeSavedViews(
  values: ReadonlyArray<unknown>,
): ReadonlyArray<PullRequestSavedView> {
  return values.slice(0, PULL_REQUEST_SAVED_VIEWS_MAX_COUNT).flatMap((value) => {
    if (isSavedView(value)) return [value];
    console.debug("Discarding malformed saved pull request view");
    return [];
  });
}

export function pullRequestViewMatches(
  view: PullRequestSavedView,
  preferences: PullRequestListPreferences,
): boolean {
  const key = (value: PullRequestListPreferences) => {
    const normalized = pullRequestListPreferences(value);
    return JSON.stringify({
      ...normalized,
      labels: normalized.labels?.toSorted(),
    });
  };
  return key(pullRequestListPreferences(view.preferences)) === key(preferences);
}

/** Explicit clears replace the old list scope without touching the independently selected PR. */
export function pullRequestSavedViewPatch(
  preferences: PullRequestListPreferences,
): PullRequestListPreferencePatch & Pick<PullRequestListPreferences, "involvement" | "state"> {
  return {
    involvement: preferences.involvement,
    state: preferences.state,
    environmentId: preferences.environmentId,
    projectId: preferences.projectId,
    host: preferences.host,
    q: preferences.q,
    draft: preferences.draft,
    review: preferences.review,
    checks: preferences.checks,
    author: preferences.author,
    labels: preferences.labels,
    sort: preferences.sort,
    upstream: preferences.upstream,
  };
}
