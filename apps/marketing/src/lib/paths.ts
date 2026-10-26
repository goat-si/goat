import type { Locale } from "../i18n";

// BASE_URL is "/" for a root deploy and "/goat" or "/goat/" for the GitHub Pages project site.
const rawBase = import.meta.env.BASE_URL;
const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;

/** Prefixes a site path with the deploy's base path. */
export function withBase(path: string): string {
  return base + path.replace(/^\/+/, "");
}

/** The same page in another locale: English is unprefixed, Korean lives under /ko/. */
export function localePath(locale: Locale, path = "/"): string {
  const clean = path.replace(/^\/+/, "");
  return withBase(locale === "ko" ? `ko/${clean}` : clean);
}

export function absoluteUrl(path: string, site: URL | undefined): string {
  if (!site) throw new Error("Set `site` in astro.config.mjs to build absolute URLs.");
  return new URL(path, site).href;
}
