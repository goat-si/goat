/**
 * Reads a URL from inside a browser tab, with the tab's own same-origin session, and returns
 * its text or Markdown, so an agent can read a signed-in page without a navigation.
 *
 * It gives an agent nothing it could not already reach by evaluating script in the tab, and it
 * keeps the session itself out of the result: it never reads document.cookie, returns no response
 * header but content-type (so no Set-Cookie or authorization values), sends cookies only to the
 * same origin, and drops form fields (hidden CSRF tokens included), scripts, templates and hidden
 * subtrees before anything leaves the page. A body that itself contains a token is page content.
 *
 * @module inPageFetch
 */
import type { Page } from "playwright-core";
import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";
import type { SessionControl } from "./SessionControl.ts";

export interface InPageFetchInput {
  readonly url: string;
  readonly format?: "text" | "markdown";
  readonly maxChars?: number;
  readonly timeoutMs?: number;
}

export interface InPageFetchResult {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly contentType: string;
  /** "raw" when the body is not text, such as an image: its content is not returned. */
  readonly format: "text" | "markdown" | "raw";
  readonly text: string;
  readonly truncated: boolean;
}

type PageOutcome =
  | { readonly error: string; readonly timedOut: boolean }
  | {
      readonly url: string;
      readonly status: number;
      readonly ok: boolean;
      readonly contentType: string;
      readonly kind: "html" | "text" | "raw";
      readonly text: string;
      readonly truncated: boolean;
    };

const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
/** Markup outweighs its text many times over, so the body may be larger than the result. */
const MAX_BODY_BYTES = 5_000_000;

const bounded = (value: number | undefined, fallback: number, low: number, high: number) =>
  value !== undefined && Number.isFinite(value)
    ? Math.min(high, Math.max(low, Math.round(value)))
    : fallback;

/** Runs in the page. DOMParser builds an inert document: no scripts run, nothing loads. */
const FETCH_SCRIPT = `async ({ url, format, maxChars, maxBytes, timeoutMs, secretPattern }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const head = { url: response.url || url, status: response.status, ok: response.ok, contentType };
    const mime = contentType.split(";")[0].trim().toLowerCase();
    const html = mime === "text/html" || mime === "application/xhtml+xml";
    const textual =
      html ||
      mime === "" ||
      mime.startsWith("text/") ||
      /^application\\/(json|xml|javascript|ecmascript)$/.test(mime) ||
      /\\+(json|xml)$/.test(mime);
    if (!textual) {
      controller.abort();
      return { ...head, kind: "raw", text: "", truncated: false };
    }
    const chunks = [];
    let size = 0;
    let cut = false;
    const reader = response.body ? response.body.getReader() : null;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size >= maxBytes) {
        cut = true;
        controller.abort();
        break;
      }
    }
    const bytes = new Uint8Array(Math.min(size, maxBytes));
    let offset = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, bytes.length - offset);
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const body = new TextDecoder().decode(bytes);
    if (!html) {
      return { ...head, kind: "text", text: body.slice(0, maxChars), truncated: cut || body.length > maxChars };
    }
    const markdown = format === "markdown";
    const secretName = new RegExp(secretPattern, "i");
    const skipped = new Set([
      "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "object",
      "embed", "head", "input", "textarea", "select", "option", "button",
    ]);
    const blocks = new Set([
      "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "ul", "ol",
      "table", "tr", "blockquote", "figure", "figcaption", "dl", "dt", "dd", "form", "fieldset",
      "details", "summary", "address", "hr",
    ]);
    const hrefOf = (element) => {
      try {
        const target = new URL(element.getAttribute("href") || "", head.url);
        if (!["http:", "https:", "mailto:"].includes(target.protocol)) return "";
        for (const key of [...target.searchParams.keys()])
          if (secretName.test(key)) target.searchParams.set(key, "redacted");
        return target.href;
      } catch {
        return "";
      }
    };
    const render = (node) => {
      if (node.nodeType === 3) return node.nodeValue.replace(/\\s+/g, " ");
      if (node.nodeType !== 1) return "";
      const tag = node.localName;
      if (skipped.has(tag) || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true")
        return "";
      if (tag === "br") return "\\n";
      if (tag === "img") return (node.getAttribute("alt") || "").trim();
      if (tag === "pre") {
        const code = node.textContent.replace(/\\n+$/, "");
        return markdown ? "\\n\\n~~~\\n" + code + "\\n~~~\\n\\n" : "\\n\\n" + code + "\\n\\n";
      }
      const inner = [...node.childNodes].map(render).join("");
      if (/^h[1-6]$/.test(tag)) {
        const title = inner.trim();
        if (!title) return "";
        return "\\n\\n" + (markdown ? "#".repeat(Number(tag[1])) + " " : "") + title + "\\n\\n";
      }
      if (tag === "li") return "\\n" + (markdown ? "- " : "") + inner.trim() + "\\n";
      if (tag === "td" || tag === "th") return inner.trim() + " ";
      if (tag === "a" && markdown) {
        const label = inner.trim().replace(/[[\\]]/g, "");
        const href = hrefOf(node).replace(/[()]/g, encodeURIComponent);
        return label && href ? "[" + label + "](" + href + ")" : inner;
      }
      return blocks.has(tag) ? "\\n\\n" + inner + "\\n\\n" : inner;
    };
    const parsed = new DOMParser().parseFromString(body, "text/html");
    const title = (parsed.title || "").trim();
    const content = render(parsed.body || parsed.documentElement);
    const text = (title && markdown ? "# " + title + "\\n\\n" : title ? title + "\\n\\n" : "") + content;
    // Leave room for whitespace that Node collapses afterwards.
    const room = maxChars * 2;
    return { ...head, kind: "html", text: text.slice(0, room), truncated: cut || text.length > room };
  } catch (error) {
    return { error: String((error && error.message) || error), timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}`;

const REDACTED = "[redacted]";
/** Cookie values this long are redacted wherever they appear, even inside other text. */
const MIN_SECRET_LENGTH = 6;
/**
 * Shorter values down to this length are redacted as whole tokens. One or two characters cannot
 * hold a credential and match everywhere, so those are redacted only as name=value.
 */
const MIN_TOKEN_LENGTH = 3;
/** Names of fields and query parameters whose values are credentials, matched loosely. */
const SECRET_NAME =
  /token|secret|passw|session|cookie|credential|authoriz|^auth$|api[-_]?key|csrf|xsrf/i;

/** Escapes text for use as a literal inside a RegExp. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces credentials in text bound for an agent. Each cookie is redacted wherever it appears as
 * name=value, which is how an echoed Cookie or Set-Cookie header looks. Its value is redacted
 * anywhere once it has six characters, and as a whole token from three; a one or two character
 * value such as lang=en stays in ordinary text, where redacting it would corrupt the page. Echoed
 * authorization or cookie header lines, bare Bearer/Basic tokens and string values under
 * credential-like JSON keys go too.
 */
export const redactSecrets = (
  text: string,
  cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) => {
  let result = text.replace(
    /^(\s*(?:proxy-)?(?:authorization|cookie|set-cookie)\s*:).*$/gim,
    `$1 ${REDACTED}`,
  );
  for (const { name, value } of cookies) {
    if (!name || !value) continue;
    result = result.replace(
      new RegExp(
        `(^|[^\\w-])(${literal(name)})=(${literal(value)}|${literal(encodeURIComponent(value))})(?![\\w%-])`,
        "g",
      ),
      `$1$2=${REDACTED}`,
    );
  }
  // Longest first, so a value containing another is replaced whole.
  const values = [...new Set(cookies.map((cookie) => cookie.value))]
    .filter((value) => value.length >= MIN_TOKEN_LENGTH)
    .toSorted((left, right) => right.length - left.length);
  for (const value of values) {
    for (const form of new Set([value, encodeURIComponent(value)])) {
      result =
        value.length >= MIN_SECRET_LENGTH
          ? result.replaceAll(form, REDACTED)
          : // A short value only as a whole token, so "ab12" never eats into "ab123" or a word.
            result.replace(
              new RegExp(`(?<![A-Za-z0-9])${literal(form)}(?![A-Za-z0-9])`, "g"),
              REDACTED,
            );
    }
  }
  return result
    .replace(
      /("((?:[^"\\]|\\.)*)"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
      (pair, prefix: string, key: string) =>
        SECRET_NAME.test(key) ? `${prefix}"${REDACTED}"` : pair,
    )
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, `$1 ${REDACTED}`);
};

/** Only http(s) URLs, resolved against the tab's page so relative paths work. */
export const resolveFetchUrl = (raw: string, pageUrl: string) => {
  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      `Cannot resolve ${JSON.stringify(raw)} against this tab's page.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      `Only http and https URLs can be fetched, not ${url.protocol}.`,
    );
  }
  return url.href;
};

/** Redacts credential-like query parameters, such as a token in a redirect target. */
const redactQuery = (raw: string) => {
  try {
    const url = new URL(raw);
    // A copy: setting a key while iterating the live list could skip entries.
    for (const key of Array.from(url.searchParams.keys()))
      if (SECRET_NAME.test(key)) url.searchParams.set(key, "redacted");
    return url.href;
  } catch {
    return raw;
  }
};

/** Trims lines and blank runs; leaves code fences exactly as the page had them. */
export const normalizeText = (text: string) => {
  let fenced = false;
  const lines: Array<string> = [];
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (line.trimStart().startsWith("~~~")) fenced = !fenced;
    lines.push(fenced ? line.trimEnd() : line.trim());
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

export const truncateText = (text: string, maxChars: number) =>
  text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };

/**
 * Runs as an observation of `control`: a private tab refuses it before any request, and a secret
 * prompt that opened while it ran, even briefly, withholds the whole answer.
 */
export const inPageFetch = (
  page: Pick<Page, "evaluate" | "url" | "context">,
  control: Pick<SessionControl, "observe">,
  input: InPageFetchInput,
) => control.observe(() => fetchInPage(page, input));

const fetchInPage = async (
  page: Pick<Page, "evaluate" | "url" | "context">,
  input: InPageFetchInput,
): Promise<InPageFetchResult> => {
  const url = resolveFetchUrl(input.url, page.url());
  const format = input.format ?? "markdown";
  const maxChars = bounded(input.maxChars, DEFAULT_MAX_CHARS, 1, MAX_CHARS);
  const timeoutMs = bounded(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const args = JSON.stringify({
    url,
    format,
    maxChars,
    maxBytes: MAX_BODY_BYTES,
    timeoutMs,
    secretPattern: SECRET_NAME.source,
  });
  // Page-side code is passed as source: the server compiles without DOM types.
  const outcome = (await page.evaluate(`(${FETCH_SCRIPT})(${args})`)) as PageOutcome;
  if ("error" in outcome) {
    throw outcome.timedOut
      ? new ServerBrowserOperationError(
          "PreviewAutomationTimeoutError",
          `Fetching ${url} did not finish within ${timeoutMs}ms.`,
        )
      : new ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          `Fetching ${url} failed: ${outcome.error}`,
        );
  }
  // Every cookie the browser would send to the request, its redirect target or the tab, HttpOnly
  // ones included.
  const origins = [url, page.url(), outcome.url].filter((candidate) => /^https?:/.test(candidate));
  const cookies = await page.context().cookies(origins);
  const redact = (text: string) => redactSecrets(text, cookies);
  const head = {
    url: redact(redactQuery(outcome.url)),
    status: outcome.status,
    ok: outcome.ok,
    contentType: outcome.contentType,
  };
  if (outcome.kind === "raw") return { ...head, format: "raw", text: "", truncated: false };
  // Plain text such as JSON keeps its own layout; only rendered HTML is tidied.
  const shown = outcome.kind === "html" ? normalizeText(outcome.text) : outcome.text;
  // A cut in the page can split a credential, and half of one no longer matches; drop the cut word.
  const text = redact(outcome.truncated ? shown.replace(/\S+$/, "") : shown);
  const result = truncateText(text, maxChars);
  return {
    ...head,
    format: outcome.kind === "html" ? format : "text",
    text: result.text,
    truncated: outcome.truncated || result.truncated,
  };
};
