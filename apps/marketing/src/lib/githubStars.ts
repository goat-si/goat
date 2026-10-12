import { GITHUB_REPOSITORY_URL } from "./site";

const REPOSITORY = new URL(GITHUB_REPOSITORY_URL).pathname.replace(/^\//, "");

/**
 * Rounds a star count down to a short badge label, e.g. 24310 -> "24k+".
 * Exact below 1,000 so a young repository shows its real number.
 */
export function formatStarCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) {
    const thousands = Math.floor(count / 100) / 10;
    return `${thousands}k+`;
  }
  return `${Math.floor(count / 1000)}k+`;
}

let starsRequest: Promise<string | null> | undefined;

/**
 * The repository's star count as a badge label, read once per build. Null when
 * GitHub does not answer (rate limit, network, or a private repository), so
 * pages show the GitHub link without a number instead of failing the build.
 */
export function fetchGithubStars(): Promise<string | null> {
  starsRequest ??= fetch(`https://api.github.com/repos/${REPOSITORY}`, {
    headers: { Accept: "application/vnd.github+json" },
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const body: { stargazers_count?: unknown } = await response.json();
      return typeof body.stargazers_count === "number"
        ? formatStarCount(body.stargazers_count)
        : null;
    })
    .catch(() => null);
  return starsRequest;
}
