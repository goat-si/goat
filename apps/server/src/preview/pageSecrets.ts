// @effect-diagnostics globalTimers:off - frame reads are bounded at the browser callback boundary.
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
import { constVoid } from "effect/Function";
import type { CDPSession, Frame, Page } from "playwright-core";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import { playwrightQuoted } from "./secretForms.ts";

import { MIN_SECRET_LENGTH, redactCookieValues, type Span } from "./cookieValues.ts";

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

/**
 * A secret GOAT filled joins the tab's values, so it and a cookie it overlaps mask as one. Keyed
 * by browser context, which several threads' tabs can share: there it masks in each of their
 * answers, which only hides more. The answer mask itself stays per thread.
 */
export const rememberSecret = (page: Pick<Page, "context">, value: string) => {
  const context = page.context();
  filledSecrets.set(context, (filledSecrets.get(context) ?? new Set<string>()).add(value));
};

/** Where field values show, as dots; found with the other secrets so neither splits the other. */
const dottedSpans = (
  text: string,
  dotted: RegExp,
  offset = 0,
  kept = (_: number, __: number) => false,
) =>
  [...text.matchAll(dotted)].flatMap(({ index, 0: match }): Array<Span> =>
    kept(index, index + match.length)
      ? []
      : [[offset + index, offset + index + match.length, MASKED_VALUE]],
  );

export const maskSecrets = (dotted: RegExp | undefined, cookies: Cookies) => (text: string) =>
  redactCookieValues(text, cookies, dotted ? dottedSpans(text, dotted) : []);

/**
 * The numbers a page script gets from masked fields that hold digits (a one-time code, a phone or
 * card number): `Number()` of their digits, which drops separators and leading zeros and rounds
 * past 2^53 exactly as the page's own conversion does.
 */
export const protectedNumbers = (values: ReadonlyArray<string>): ReadonlySet<number> =>
  new Set(
    values.flatMap((value) => {
      const digits = value.replace(/\D/g, "");
      return /^[\d\s+().-]+$/.test(value) && digits.length >= 4 ? [Number(digits)] : [];
    }),
  );

/**
 * Masks every string in an evaluation result, object keys included: all of it is the page's. A
 * number equal to a masked field's numeric form is masked too; numbers never join the text mask.
 */
export const redactValue = (
  value: unknown,
  mask: (text: string) => string,
  numbers: ReadonlySet<number> = new Set(),
): unknown => {
  if (typeof value === "string") return mask(value);
  if ((typeof value === "number" || typeof value === "bigint") && numbers.has(Number(value)))
    return MASKED_VALUE;
  if (Array.isArray(value)) return value.map((each) => redactValue(each, mask, numbers));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, each]) => [mask(key), redactValue(each, mask, numbers)]),
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
export const maskTree = (tree: string, dotted: RegExp | undefined, cookies: Cookies) => {
  const spans: Array<Span> = [];
  let offset = 0;
  for (const line of dotted ? tree.split("\n") : []) {
    const node = TREE_LINE.exec(line);
    const name = node?.[1]?.length ?? 0;
    const attributes = name + (node?.[2]?.length ?? 0);
    const end = attributes + (node?.[3]?.length ?? 0);
    const kept = (from: number, to: number) => to <= name || (from >= attributes && to <= end);
    if (dotted) spans.push(...dottedSpans(line, dotted, offset, kept));
    offset += line.length + 1;
  }
  return redactCookieValues(tree, cookies, spans);
};

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

// How long a frame in another process gets to answer; one that crashed never does.

const FRAME_ANSWER_MS = 1_000;

// Include password, phone, email and one-time-code fields and CSS-masked text in open shadow
// roots, normalized like accessible text. A field counts by its type or an autocomplete token.
const DOTTED_SCRIPT = `(() => {
  const values = [];
  const sensitive = (element) =>
    ["password", "tel", "email"].includes(element.type) ||
    String(element.getAttribute("autocomplete") ?? "")
      .toLowerCase()
      .split(/\\s+/)
      .some((token) => /^(?:tel(?:-.*)?|email|cc-.*|one-time-code|current-password|new-password)$/.test(token));
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
      const field = element.localName === "input" || element.localName === "textarea";
      if (!field && !element.isContentEditable) continue;
      const dots = getComputedStyle(element).getPropertyValue("-webkit-text-security");
      if (!(field && sensitive(element)) && (dots === "none" || dots === "")) continue;
      // Raw as page text shows it, and normalized as the tree does.
      for (const value of field ? [element.value, element.defaultValue] : [element.textContent ?? ""])
        values.push(value, value.replace(/[\\u200b\\u00ad]/g, "").trim().replace(/\\s+/g, " "));
    }
  };
  visit(document);
  return [...new Set(values.filter((value) => value.trim()))];
})()`;

/** A frame came or went while the secret readers ran; another try can get past it. */
export const SECRETS_PAGE_CHANGED = "The page changed while reading its secrets.";
const pageChanged = () =>
  new ServerBrowserOperationError("PreviewAutomationExecutionError", SECRETS_PAGE_CHANGED);
const VALUE_TOO_LONG = "A private field holds a value too long to mask.";

/** Reuse one CDP session per out-of-process frame across snapshots. */
const frameSessions = new WeakMap<Frame, Promise<CDPSession>>();

/** Returns undefined on failure or frame timeout. */
const answered = <A>(promise: Promise<A>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), FRAME_ANSWER_MS);
  });
  return Promise.race([promise.catch(() => undefined), late]).finally(() => clearTimeout(timer));
};

/** Isolated worlds prevent spoofing; desktop out-of-process frames use page worlds. Missing own-frame reads or changed frames fail; other missing reads return undefined. */
export const openReaders = async (page: Page, cdp: CDPSession) => {
  const frames = page.frames();
  const owners = new Map<Frame, CDPSession | null | undefined>(
    await Promise.all(
      frames.map(async (frame) => {
        if (frame === page.mainFrame()) return [frame, cdp] as const;
        const session = frameSessions.get(frame) ?? page.context().newCDPSession(frame);
        frameSessions.set(frame, session);
        try {
          return [frame, await session] as const;
        } catch (cause) {
          frameSessions.delete(frame);
          // CdpRelay supports only the page; other refusals fall back to the parent session, failing if the frame is absent.
          const desktop = String(cause).includes("Only this preview tab's page can be attached");
          return [frame, desktop ? null : undefined] as const;
        }
      }),
    ),
  );
  const ownerOf = (frame: Frame): CDPSession | null => {
    const owner = owners.get(frame);
    if (owner !== undefined) return owner;
    const parent = frame.parentFrame();
    return parent ? ownerOf(parent) : null;
  };
  const sessionReader = (frame: Frame, session: CDPSession) => {
    const owned = frames.filter((each) => ownerOf(each) === session);
    const open = async () => {
      const { frameTree } = await session.send("Page.getFrameTree");
      const ids = (node: typeof frameTree): Array<string> => [
        node.frame.id,
        ...(node.childFrames ?? []).flatMap(ids),
      ];
      // Every frame listed by the tab must belong to a readable session.
      if (ids(frameTree).length !== owned.length) throw pageChanged();
      return Promise.all(
        ids(frameTree).map(async (frameId) => {
          const world = await session.send("Page.createIsolatedWorld", {
            frameId,
            worldName: "goat-preview",
          });
          return world.executionContextId;
        }),
      );
    };
    let contexts: ReturnType<typeof open> | undefined;
    const read = async () => {
      const values = (contexts ??= open()).then((ids) =>
        Promise.all(
          ids.map(async (contextId) => {
            const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
              contextId,
              expression: DOTTED_SCRIPT,
              returnByValue: true,
            });
            if (exceptionDetails) throw pageChanged();
            return result.value as Array<string>;
          }),
        ),
      );
      try {
        return (await values).flat();
      } catch (cause) {
        // The frame may have moved to another process; the next snapshot opens a new session.
        if (session !== cdp) {
          frameSessions.delete(frame);
          void session.detach().catch(constVoid);
        }
        throw cause;
      }
    };
    return { frames: owned, read };
  };
  const readers = [
    sessionReader(page.mainFrame(), cdp),
    ...frames.flatMap((frame) => {
      const owner = owners.get(frame);
      if (owner) return owner === cdp ? [] : [sessionReader(frame, owner)];
      const own = () => frame.evaluate(DOTTED_SCRIPT) as Promise<Array<string>>;
      return ownerOf(frame) === null ? [{ frames: [frame], read: own }] : [];
    }),
  ];
  return {
    readers,
    read: async (before?: ReadonlyArray<unknown>) => {
      const now = page.frames();
      if (now.length !== frames.length || now.some((frame, i) => frame !== frames[i])) {
        throw pageChanged();
      }
      return Promise.all(
        readers.map((reader, i) => {
          if (i === 0) return reader.read().catch(() => Promise.reject(pageChanged()));
          return before && !before[i] ? undefined : answered(reader.read());
        }),
      );
    },
  };
};

/** Short values need word boundaries to avoid masking unrelated text. */
export const dottedPattern = (values: ReadonlyArray<string>) => {
  const sources = values
    .flatMap((value) => {
      const json = JSON.stringify(value).slice(1, -1);
      const quoted = playwrightQuoted(value);
      const forms = [value, json, quoted].flatMap((form) => [form, form.replaceAll("'", "''")]);
      return [...new Set(forms)].map((form) => ({ form, word: value.length < 4 }));
    })
    // Longest first, so a form inside another never leaves the rest showing.
    .toSorted((a, b) => b.form.length - a.form.length)
    .map(({ form, word }) => {
      const literal = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return word ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal;
    });
  if (sources.length === 0) return undefined;
  const pattern = new RegExp(sources.join("|"), "gu");
  try {
    // Force regex compilation for one-byte and two-byte strings now; size errors name every value.
    pattern.test("");
    pattern.test("\u2022");
  } catch {
    throw new ServerBrowserOperationError("PreviewAutomationExecutionError", VALUE_TOO_LONG);
  }
  return pattern;
};
