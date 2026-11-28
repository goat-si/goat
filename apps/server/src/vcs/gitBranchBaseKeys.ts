/** GOAT's record of the branch, named as on the host, that a branch was cut from. */
export const branchBaseConfigKey = (branch: string) => `branch.${branch}.t3-merge-base`;
/**
 * Where GOAT kept that record before it had a key of its own, for every host alike: the GitHub
 * CLI's key, which branches cut before then still carry instead.
 */
export const legacyBranchBaseConfigKey = (branch: string) => `branch.${branch}.gh-merge-base`;
