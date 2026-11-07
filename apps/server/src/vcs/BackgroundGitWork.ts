import * as Context from "effect/Context";

export const BackgroundGitWork = Context.Reference<boolean>("goat/vcs/BackgroundGitWork", {
  defaultValue: () => false,
});
