/**
 * `author:me` names whoever is signed in to the host being read, GitHub's `@me` spelled either
 * way. A host's own search would answer it, but the page and the server both re-check an author
 * against the row's login, so the name is resolved before either comparison rather than being
 * matched as the literal login "me".
 */
export function resolvePullRequestAuthorFilter(
  author: string,
  viewer: string | null | undefined,
): string {
  const trimmed = author.trim();
  if (!/^@?me$/i.test(trimmed)) return trimmed;
  return viewer === null || viewer === undefined || viewer.trim().length === 0 ? trimmed : viewer;
}
