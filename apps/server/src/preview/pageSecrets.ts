/**
 * Masks secret values in text bound for an agent: password, one-time code and masked field values
 * as dots, and the values of cookies the tab holds, HttpOnly ones included.
 *
 * @module pageSecrets
 */
import type {
  PreviewAutomationActionEvent,
  PreviewAutomationConsoleEntry,
  PreviewAutomationNetworkEntry,
  PreviewAutomationPageError,
} from "@goat/contracts";
import type { Page } from "playwright-core";

import { MIN_SECRET_LENGTH, redactCookieValues } from "./cookieValues.ts";

const MASKED_VALUE = "••••••••";

/** A cookie value, or a secret GOAT filled, which masks as a substring wherever it stands. */
type Cookie = { readonly name: string; readonly value: string; readonly filled?: boolean };
type Cookies = ReadonlyArray<Cookie>;

type CookiePage = Pick<Page, "url" | "context"> & Partial<Pick<Page, "frames">>;

/** Cookie values a context held, newest last; far more than a page sets in a session. */
const MAX_REMEMBERED = 10_000;
const remembered = new WeakMap<object, Map<string, Cookie>>();
/** Secrets GOAT filled in a context's pages, kept apart so no cookie churn evicts them. */
const filledSecrets = new WeakMap<object, Set<string>>();

/** The page's URL and every frame's, cross-origin iframes included. */
export const frameUrls = (page: CookiePage) => [
  page.url(),
  ...(typeof page.frames === "function" ? page.frames().map((frame) => frame.url()) : []),
];

/**
 * Cookies sent to the tab's frames or earlier URLs, every credential-length cookie its context
 * holds (one it only fetched with, a service worker's, one from before GOAT watched), and values
 * the context held before, so a log written with a replaced cookie stays masked.
 */
export const tabCookies = async (page: CookiePage, earlier: ReadonlyArray<string> = []) => {
  const urls = [...new Set([...earlier, ...frameUrls(page)])].filter((url) =>
    /^https?:/i.test(url),
  );
  const context = page.context();
  const [sent, held] = await Promise.all([
    // An empty list would return every cookie in the context.
    urls.length === 0 ? Promise.resolve([]) : context.cookies(urls),
    context.cookies(),
  ]);
  const cookies = [...sent, ...held.filter((cookie) => cookie.value.length >= MIN_SECRET_LENGTH)];
  const seen = remembered.get(context) ?? new Map<string, Cookie>();
  remembered.set(context, seen);
  for (const { name, value } of cookies) {
    const key = `${name}=${value}`;
    seen.delete(key);
    seen.set(key, { name, value });
    if (seen.size > MAX_REMEMBERED) seen.delete(seen.keys().next().value ?? key);
  }
  const filled = [...(filledSecrets.get(context) ?? [])].map((value) => ({
    name: "",
    value,
    filled: true,
  }));
  return [...seen.values(), ...filled];
};

/** A secret GOAT filled joins the tab's values, so it and a cookie it overlaps mask as one. */
export const rememberSecret = (page: Pick<Page, "context">, value: string) => {
  const context = page.context();
  filledSecrets.set(context, (filledSecrets.get(context) ?? new Set<string>()).add(value));
};

export const maskSecrets = (dotted: RegExp | undefined, cookies: Cookies) => (text: string) =>
  redactCookieValues(dotted ? text.replace(dotted, MASKED_VALUE) : text, cookies);

/** Masks every string in an evaluation result, object keys included: all of it is the page's. */
export const redactValue = (value: unknown, mask: (text: string) => string): unknown => {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((each) => redactValue(each, mask));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, each]) => [mask(key), redactValue(each, mask)]),
  );
};

/**
 * Maskers for GOAT's own records of a tab: only the text the page wrote into them is masked, so
 * field names, levels, phases and statuses keep the values their contracts allow.
 */
export const maskRecords = (mask: (text: string) => string) => {
  const optional = (text: string | undefined) => (text === undefined ? text : mask(text));
  return {
    console: (entry: PreviewAutomationConsoleEntry): PreviewAutomationConsoleEntry => ({
      ...entry,
      text: mask(entry.text),
      source: optional(entry.source),
    }),
    error: (entry: PreviewAutomationPageError): PreviewAutomationPageError => ({
      ...entry,
      message: mask(entry.message),
      stack: optional(entry.stack),
    }),
    network: (entry: PreviewAutomationNetworkEntry): PreviewAutomationNetworkEntry => ({
      ...entry,
      // A page names a request's method itself; any string goes.
      method: mask(entry.method),
      url: mask(entry.url),
      errorText: optional(entry.errorText),
    }),
    action: (entry: PreviewAutomationActionEvent): PreviewAutomationActionEvent => ({
      ...entry,
      error: optional(entry.error),
    }),
  };
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

/** A snapshot's console, network and action records with the page's text in them masked. */
export const maskSnapshotRecords = (
  mask: (text: string) => string,
  input: {
    readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
    readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
    readonly actionTimeline: ReadonlyArray<PreviewAutomationActionEvent>;
  },
) => {
  const records = maskRecords(mask);
  return {
    consoleEntries: input.consoleEntries.map(records.console),
    networkEntries: input.networkEntries.map(records.network),
    actionTimeline: input.actionTimeline.map(records.action),
  };
};
