/**
 * D-10: how shipped code may not refer to the GOAT source repository. Release verification
 * rejects it, and the user-guide bundling strips it, so both read this one pattern.
 */
export const SOURCE_REPOSITORY_REFERENCE = String.raw`(?:github\.com[/:]|repos\/)goat-si\/goat(?!(?:-releases|_))`;
