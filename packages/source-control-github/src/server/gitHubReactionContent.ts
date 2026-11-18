import type { PullRequestReactionContent } from "@goat/contracts";
import type * as GitHubSchema from "../../schema/github.graphql.ts";

export const REACTION_CONTENT_BY_GITHUB: Readonly<Record<string, PullRequestReactionContent>> = {
  THUMBS_UP: "thumbs-up",
  THUMBS_DOWN: "thumbs-down",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

const GITHUB_REACTION_BY_CONTENT: Readonly<
  Record<PullRequestReactionContent, GitHubSchema.ReactionContent>
> = {
  "thumbs-up": "THUMBS_UP",
  "thumbs-down": "THUMBS_DOWN",
  laugh: "LAUGH",
  hooray: "HOORAY",
  confused: "CONFUSED",
  heart: "HEART",
  rocket: "ROCKET",
  eyes: "EYES",
};

export function gitHubReactionContent(
  content: PullRequestReactionContent,
): GitHubSchema.ReactionContent {
  return GITHUB_REACTION_BY_CONTENT[content];
}
