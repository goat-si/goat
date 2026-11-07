export function artifactSiteSlug(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const slug = url.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
}
