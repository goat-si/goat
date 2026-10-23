/** Support policy: Git 2.48–2.99 only, with --no-lazy-fetch on every repository call. Unknown versions refuse. */
export const isSupportedGitVersion = (version: string) =>
  /^git version 2\.(?:4[8-9]|[5-9][0-9])\.[0-9]+(?:\s|$)/.test(version);
