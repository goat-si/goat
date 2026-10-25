// Fills the download links from goat-si/goat-releases. Every link already points at the
// releases page, so a failed or blocked request leaves a working page behind.
const API = "https://api.github.com/repos/goat-si/goat-releases";
const CACHE_KEY = "goat-release";
const CACHE_MS = 10 * 60 * 1000;

interface Release {
  tag_name: string;
  published_at: string;
  assets: ReadonlyArray<{ name: string; browser_download_url: string }>;
}

interface Found {
  release: Release;
  channel: "stable" | "nightly";
}

async function fetchJson(path: string): Promise<Response> {
  return fetch(`${API}${path}`, { headers: { Accept: "application/vnd.github+json" } });
}

async function findRelease(): Promise<Found> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    const entry = JSON.parse(cached) as { at: number; found: Found };
    if (Date.now() - entry.at < CACHE_MS) return entry.found;
  }
  // /releases/latest skips prereleases and answers 404 while no stable release exists.
  const latest = await fetchJson("/releases/latest");
  let found: Found;
  if (latest.ok) {
    found = { release: (await latest.json()) as Release, channel: "stable" };
  } else if (latest.status === 404) {
    const list = await fetchJson("/releases?per_page=10");
    if (!list.ok) throw new Error(`GitHub answered ${list.status}`);
    const releases = (await list.json()) as Release[];
    const nightly = releases.find((release) => release.tag_name.includes("-nightly."));
    if (!nightly) throw new Error("No nightly release in the newest page");
    found = { release: nightly, channel: "nightly" };
  } else {
    throw new Error(`GitHub answered ${latest.status}`);
  }
  sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), found }));
  return found;
}

export async function fillReleaseLinks(root: HTMLElement): Promise<void> {
  const status = root.querySelector<HTMLElement>("[data-release-status]");
  try {
    const { release, channel } = await findRelease();
    for (const link of root.querySelectorAll<HTMLAnchorElement>("a[data-asset]")) {
      const pattern = new RegExp(link.dataset.asset ?? "^$");
      const asset = release.assets.find((candidate) => pattern.test(candidate.name));
      if (asset) link.href = asset.browser_download_url;
    }
    const date = new Intl.DateTimeFormat(root.dataset.locale, { dateStyle: "medium" }).format(
      new Date(release.published_at),
    );
    const template = (channel === "stable" ? root.dataset.stable : root.dataset.nightly) ?? "";
    if (status)
      status.textContent = template.replace("{tag}", release.tag_name).replace("{date}", date);
  } catch {
    if (status) status.textContent = root.dataset.failed ?? "";
  }
}
