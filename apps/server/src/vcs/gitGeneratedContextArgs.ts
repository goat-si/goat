const repositoryWide = ["-c", "diff.relative=false"];
export const stagedSummaryArgs = [...repositoryWide, "diff", "--cached", "--name-status"];
export const stagedPatchArgs = [
  ...repositoryWide,
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--cached",
  "--patch",
  "--minimal",
];
export const rangeLogArgs = (range: string) => [
  "log",
  "--oneline",
  "--no-color",
  "--no-decorate",
  "--no-show-signature",
  "--end-of-options",
  range,
];
export const rangeStatArgs = (range: string) => [
  ...repositoryWide,
  "diff",
  "--stat",
  "--no-color",
  "--end-of-options",
  range,
];
export const rangePatchArgs = (range: string) => [
  ...repositoryWide,
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--patch",
  "--minimal",
  "--end-of-options",
  range,
];
