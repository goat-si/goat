/**
 * Masks secret values in text bound for an agent: password, one-time code and masked field values
 * as dots, and the values of cookies the tab holds, HttpOnly ones included.
 *
 * @module pageSecrets
 */
import type { Page } from "playwright-core";

import { redactCookieValues } from "./cookieValues.ts";

const MASKED_VALUE = "••••••••";

type Cookies = ReadonlyArray<{ readonly name: string; readonly value: string }>;

type CookiePage = Pick<Page, "url" | "context"> & Partial<Pick<Page, "frames">>;

/** Enough recent request paths for a page's API calls; the oldest unused one goes first. */
const MAX_REQUEST_SCOPES = 256;
const requestScopes = new WeakMap<object, Map<string, true>>();

/**
 * Remembers where a page sent a request. A cookie scoped to a path the page only fetched, never
 * showed in a frame, is sent there, so its value can come back in what the page shows.
 */
export const noteRequestUrl = (page: object, url: string) => {
  if (!/^https?:/i.test(url)) return;
  let scope: string;
  try {
    const parsed = new URL(url);
    scope = parsed.origin + parsed.pathname;
  } catch {
    return;
  }
  const scopes = requestScopes.get(page) ?? new Map<string, true>();
  requestScopes.set(page, scopes);
  scopes.delete(scope);
  scopes.set(scope, true);
  if (scopes.size > MAX_REQUEST_SCOPES) scopes.delete(scopes.keys().next().value ?? scope);
};

/** The page's URL and every frame's, cross-origin iframes included. */
export const frameUrls = (page: CookiePage) => [
  page.url(),
  ...(typeof page.frames === "function" ? page.frames().map((frame) => frame.url()) : []),
];

/** Cookies sent to any of the tab's frames, to URLs it showed earlier, and to what it fetched. */
export const tabCookies = (page: CookiePage, earlier: ReadonlyArray<string> = []) => {
  const fetched = requestScopes.get(page)?.keys() ?? [];
  const urls = [...new Set([...earlier, ...frameUrls(page), ...fetched])].filter((url) =>
    /^https?:/i.test(url),
  );
  // An empty list would return every cookie in the context.
  return urls.length === 0 ? Promise.resolve([]) : page.context().cookies(urls);
};

export const maskSecrets = (dotted: RegExp | undefined, cookies: Cookies) => (text: string) =>
  redactCookieValues(dotted ? text.replace(dotted, MASKED_VALUE) : text, cookies);

/** Masks every string in an evaluation result, object keys included. */
export const redactValue = (value: unknown, mask: (text: string) => string): unknown => {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((each) => redactValue(each, mask));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, each]) => [mask(key), redactValue(each, mask)]),
  );
};

// Playwright single-quotes keys containing ': ' and leaves /.../ names unquoted. Recognize only its attributes so name text cannot spoof them.
const TREE_LINE =
  /^(\s*- '?[^\s"':]+)( "(?:[^"\\]|\\.)*"| \/(?:.*?\/)?)?((?: \[(?:active|checked(?:=mixed)?|disabled|expanded|level=\d+|pressed(?:=mixed)?|selected|ref=(?:f\d+)?e\d+|cursor=pointer|box=-?\d+,-?\d+,\d+,\d+)\])*'?)(:.*)?$/;

/** Preserve roles and attributes so refs work; unquoted /.../ names can make matches cross boundaries. */
export const maskTree = (tree: string, dotted: RegExp) =>
  tree
    .split("\n")
    .map((line) => {
      const node = TREE_LINE.exec(line);
      const name = node?.[1]?.length ?? 0;
      const attributes = name + (node?.[2]?.length ?? 0);
      const end = attributes + (node?.[3]?.length ?? 0);
      const kept = (from: number, to: number) => to <= name || (from >= attributes && to <= end);
      return line.replace(dotted, (match: string, offset: number) =>
        kept(offset, offset + match.length) ? match : MASKED_VALUE,
      );
    })
    .join("\n");
