import { normalizeMarkdownLinkDestination } from "@goat/shared/markdownLinks";
import { rewriteMarkdownFileUriHref } from "../markdown-links";

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

export function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}
