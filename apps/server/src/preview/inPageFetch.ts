// @effect-diagnostics globalTimers:off - Playwright calls run outside the Effect runtime.
/** Reads same-origin session content in the page; fields, hidden markup and credentials stay out. */
import { MARKDOWN_FORMAT, normalizeText } from "./markdownFormat.ts";
import { extractCleanMarkdown } from "./BrowserCleanMarkdown.ts";
import type { Page, Request, Response } from "playwright-core";
import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";
import type { SessionControl } from "./SessionControl.ts";
import type { DispatchGate } from "./ServerBrowserPage.ts";
import { REDACTED, redactCookieValues } from "./cookieValues.ts";
import { tabCookies } from "./pageSecrets.ts";
import { FETCHED_BODY } from "./browserArtifacts.ts";

export interface InPageFetchInput {
  readonly url: string;
  readonly format?: "text" | "markdown" | undefined;
  readonly maxChars?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /** Largest body that is not text kept for a file; larger ones are dropped as truncated. */
  readonly maxSavedBytes?: number | undefined;
  /** The request's deadline on the performance.now() clock; the fetch and its copy end by then. */
  readonly deadline?: number | undefined;
}

export interface InPageFetchResult {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly contentType: string;
  /** "raw" when the body is not text, such as an image: its content is not returned as text. */
  readonly format: "text" | "markdown" | "raw";
  readonly text: string;
  readonly truncated: boolean;
  /** A raw body's bytes, held in memory until the server saves them; never sent to a caller. */
  readonly [FETCHED_BODY]?: Uint8Array;
}

type PageOutcome =
  | {
      readonly error: string;
      readonly timedOut: boolean;
      readonly reachable?: boolean;
      readonly policyBlocked?: boolean;
      readonly invalidUrl?: boolean;
    }
  | {
      readonly url: string;
      readonly status: number;
      readonly ok: boolean;
      readonly contentType: string;
      readonly kind: "html" | "html_markdown" | "text" | "raw" | "binary";
      readonly title?: string;
      readonly text: string;
      readonly truncated: boolean;
      readonly size?: number;
    };

const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_REDIRECT_HOPS = 10;
const MAX_BODY_BYTES = 5_000_000;
const MAX_SAVED_BYTES = 25 * 1024 * 1024;
const SLICE_BYTES = 1024 * 1024;

const bounded = (value: number | undefined, fallback: number, low: number, high: number) =>
  value !== undefined && Number.isFinite(value)
    ? Math.min(high, Math.max(low, Math.round(value)))
    : fallback;

const FETCH_SCRIPT = `async ({ url, format, maxChars, maxBytes, maxSavedBytes, timeoutMs, secretPattern }, held) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let policyBlocked = false;
  const onViolation = (event) => {
    if (event.disposition !== "enforce") return;
    try { if (new URL(event.blockedURI).origin === new URL(url).origin) policyBlocked = true; } catch {}
  };
  document.addEventListener("securitypolicyviolation", onViolation);
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    const finalUrl = response.url || url;
    let finalProtocol = "";
    try { finalProtocol = new URL(finalUrl).protocol; } catch {}
    if (finalProtocol !== "http:" && finalProtocol !== "https:") {
      controller.abort();
      return {
        error: "Only http and https URLs can be fetched, not " + (finalProtocol || "an invalid URL") + ".",
        timedOut: false,
        invalidUrl: true,
      };
    }
    const contentType = response.headers.get("content-type") || "";
    const head = { url: finalUrl, status: response.status, ok: response.ok, contentType };
    const mime = contentType.split(";")[0].trim().toLowerCase();
    const html = mime === "text/html" || mime === "application/xhtml+xml";
    const textual =
      html ||
      mime === "" ||
      mime.startsWith("text/") ||
      /^application\\/(json|xml|javascript|ecmascript)$/.test(mime) ||
      /\\+(json|xml)$/.test(mime);
    if (!textual) {
      const parts = [];
      let saved = 0;
      const reader = response.body ? response.body.getReader() : null;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        saved += value.byteLength;
        if (saved > maxSavedBytes) {
          controller.abort();
          return { ...head, kind: "raw", text: "", truncated: true };
        }
        parts.push(value);
      }
      const body = new Uint8Array(saved);
      let at = 0;
      for (const part of parts) {
        body.set(part, at);
        at += part.byteLength;
      }
      held.body = body;
      return { ...head, kind: "binary", text: "", truncated: false, size: saved };
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
    const charset = (/charset=\\s*"?([^";]+)/i.exec(contentType) || [])[1];
    let decoder;
    try {
      decoder = new TextDecoder(charset ? charset.trim() : "utf-8");
    } catch {
      decoder = new TextDecoder();
    }
    const body = decoder.decode(bytes);
    if (!html) {
      return { ...head, kind: "text", text: body.slice(0, maxChars), truncated: cut || body.length > maxChars };
    }
    if (format === "markdown") {
      const parsed = new DOMParser().parseFromString(body, "text/html");
      const title = (parsed.title || "").trim();
      return { ...head, kind: "html_markdown", title, text: body, truncated: cut };
    }
    const markdown = false;
    const secretName = new RegExp(secretPattern, "i");
    const skipped = new Set([
      "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "object",
      "embed", "head", "input", "textarea", "select", "option", "button",
    ]);
    const formatNode = ${MARKDOWN_FORMAT};
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
        return "\\n\\n" + code + "\\n\\n";
      }
      const inner = [...node.childNodes].map(render).join("");
      return formatNode(node, inner, markdown, hrefOf);
    };
    const parsed = new DOMParser().parseFromString(body, "text/html");
    const title = (parsed.title || "").trim();
    const content = render(parsed.body || parsed.documentElement);
    const text = (title ? title + "\\n\\n" : "") + content;
    const room = maxChars * 2;
    return { ...head, kind: "html", text: text.slice(0, room), truncated: cut || text.length > room };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    if (!timedOut) await new Promise((resolve) => setTimeout(resolve, 0));
    let reachable = false;
    if (!timedOut && !policyBlocked) {
      try {
        const probe = await fetch(url, { mode: "no-cors", credentials: "omit", cache: "no-store", signal: controller.signal });
        reachable = probe.type === "opaque";
      } catch {}
    }
    return { error: String((error && error.message) || error), timedOut, reachable, policyBlocked };
  } finally {
    document.removeEventListener("securitypolicyviolation", onViolation);
    clearTimeout(timer);
  }
}`;

/** Names of fields and query parameters whose values are credentials, matched loosely. */
const SECRET_NAME =
  /token|secret|passw|session|cookie|credential|authoriz|^auth$|api[-_]?key|csrf|xsrf/i;

// Short cookie values match whole tokens so masking does not erase ordinary prose.
export const redactSecrets = (
  text: string,
  cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) => {
  const result = redactCookieValues(
    text.replace(
      /^(\s*(?:proxy-)?(?:authorization|cookie|set-cookie)\s*:).*$/gim,
      `$1 ${REDACTED}`,
    ),
    cookies,
  );
  return (
    result
      .replace(
        /("((?:[^"\\]|\\.)*)"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
        (pair, prefix: string, key: string) =>
          SECRET_NAME.test(key) ? `${prefix}"${REDACTED}"` : pair,
      )
      // Case-sensitive and token-shaped, so prose such as "Basic usage" stays.
      .replace(/\b(Bearer|Basic)[ \t]+[\w.~+/-]{8,}=*/g, `$1 ${REDACTED}`)
  );
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

export { normalizeText } from "./markdownFormat.ts";

export const truncateText = (text: string, maxChars: number) =>
  text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };

export type FetchUrlValidator = (url: string) => void | Promise<void>;

const assertHttpUrl = (raw: string) => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      "Refused fetch response with an invalid URL.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      `Only http and https URLs can be fetched, not ${parsed.protocol}.`,
    );
  }
  return parsed.href;
};

export const inPageFetch = (
  page: FetchPage,
  control: Pick<SessionControl, "observe">,
  input: InPageFetchInput,
  gate?: DispatchGate,
  validateUrl?: FetchUrlValidator,
) => control.observe(() => fetchInPage(page, input, gate, validateUrl));

type FetchPage = Pick<Page, "evaluateHandle" | "url" | "context" | "on" | "off">;
type Held = { readonly outcome: PageOutcome; readonly body: Uint8Array | null };

const DNS_ERRORS = new Set(["net::ERR_NAME_NOT_RESOLVED", "net::ERR_NAME_RESOLUTION_FAILED"]);

const watchFetchFailure = (page: FetchPage, url: string, validateUrl?: FetchUrlValidator) => {
  const requested = url.split("#")[0];
  let failed: Request | undefined;
  const seenUrls = new Set<string>();
  const validations: Array<Promise<void>> = [];
  let redirectError: unknown;
  const recordError = (cause: unknown) => {
    if (redirectError === undefined) redirectError = cause;
  };
  const checkHopUrl = (hopUrl: string) => {
    if (seenUrls.has(hopUrl)) return;
    seenUrls.add(hopUrl);
    let checked: string;
    try {
      checked = assertHttpUrl(hopUrl);
    } catch (cause) {
      recordError(cause);
      return;
    }
    if (!validateUrl) return;
    validations.push(
      Promise.resolve()
        .then(() => validateUrl(checked))
        .catch((cause: unknown) => {
          recordError(cause);
        }),
    );
  };
  const requestChain = (request: Request) => {
    const chain: Array<Request> = [];
    for (let current: Request | null = request; current; current = current.redirectedFrom())
      chain.push(current);
    return chain;
  };
  const onRequest = (request: Request) => {
    const chain = requestChain(request);
    const first = chain.at(-1);
    if (!first || request.resourceType() !== "fetch" || first.url() !== requested) return;
    if (chain.length - 1 > MAX_REDIRECT_HOPS) {
      recordError(
        new ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          `Fetching ${url} exceeded the maximum redirect limit (${MAX_REDIRECT_HOPS}).`,
        ),
      );
      return;
    }
    for (let index = chain.length - 1; index >= 0; index--) {
      const hop = chain[index];
      if (hop && hop !== first) checkHopUrl(hop.url());
    }
  };
  const onResponse = (response: Response) => {
    const request = response.request();
    const chain = requestChain(request);
    const first = chain.at(-1);
    if (!first || request.resourceType() !== "fetch" || first.url() !== requested) return;
    const status = response.status();
    if (status < 300 || status >= 400) return;
    const location = response.headers()["location"];
    if (location === undefined || location.trim() === "") return;
    let resolved: string;
    try {
      resolved = new URL(location, request.url()).href;
    } catch {
      recordError(
        new ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          "Refused redirect to an invalid Location header.",
        ),
      );
      return;
    }
    checkHopUrl(resolved);
  };
  const onFailed = (request: Request) => {
    const first = requestChain(request).at(-1);
    if (
      failed === undefined &&
      first &&
      request.resourceType() === "fetch" &&
      first.url() === requested
    )
      failed = request;
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  return {
    dispose: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
    },
    assertRedirects: async () => {
      if (validations.length > 0) await Promise.all(validations);
      if (redirectError !== undefined) throw redirectError;
    },
    classify: (outcome: { readonly reachable?: boolean; readonly policyBlocked?: boolean }) => {
      if (outcome.policyBlocked)
        return {
          fetchFailure: "csp",
          reason: "this page's Content-Security-Policy does not allow requests there",
        } as const;
      const errorText = failed?.failure()?.errorText ?? "";
      if (outcome.reachable && (errorText === "" || errorText === "net::ERR_FAILED"))
        return {
          fetchFailure: "cors",
          reason: "the site does not allow this page to read it (CORS)",
        } as const;
      if (errorText === "net::ERR_UNSAFE_REDIRECT")
        return {
          fetchFailure: "network",
          reason: "Only http and https URLs are allowed (net::ERR_UNSAFE_REDIRECT)",
        } as const;
      if (DNS_ERRORS.has(errorText))
        return {
          fetchFailure: "dns",
          reason: `the host name did not resolve (${errorText})`,
        } as const;
      return errorText
        ? ({
            fetchFailure: "network",
            reason: `the request did not reach the site (${errorText})`,
          } as const)
        : undefined;
    },
  };
};

const fetchTimedOut = (url: string) =>
  new ServerBrowserOperationError(
    "PreviewAutomationTimeoutError",
    `Fetching ${url} did not finish within its deadline.`,
  );

const beforeDeadline = async <A>(work: Promise<A>, deadline: number, url: string) => {
  const left = deadline - performance.now();
  void work.catch(() => undefined);
  if (left <= 0) throw fetchTimedOut(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(fetchTimedOut(url)), left);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const readHeldBody = async (
  held: { evaluate<R, A>(read: (value: Held, arg: A) => R, arg: A): Promise<R> },
  size: number,
  deadline: number,
  url: string,
) => {
  const body = new Uint8Array(size);
  for (let start = 0; start < size; start += SLICE_BYTES) {
    const end = Math.min(size, start + SLICE_BYTES);
    const encoded = await beforeDeadline(
      held.evaluate(
        (value, [from, to]) => {
          const bytes = (value.body ?? new Uint8Array()).subarray(from, to);
          let binary = "";
          for (let at = 0; at < bytes.length; at += 0x8000)
            binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
          return btoa(binary);
        },
        [start, end] as const,
      ),
      deadline,
      url,
    );
    body.set(Buffer.from(encoded, "base64"), start);
  }
  return body;
};

const fetchInPage = async (
  page: FetchPage,
  input: InPageFetchInput,
  gate?: DispatchGate,
  validateUrl?: FetchUrlValidator,
): Promise<InPageFetchResult> => {
  const url = resolveFetchUrl(input.url, page.url());
  await validateUrl?.(url);
  const format = input.format ?? "markdown";
  const maxChars = bounded(input.maxChars, DEFAULT_MAX_CHARS, 1, MAX_CHARS);
  const deadline = Math.min(
    input.deadline ?? Number.POSITIVE_INFINITY,
    performance.now() + bounded(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS),
  );
  const timeoutMs = Math.max(1, Math.floor(deadline - performance.now()));
  const args = JSON.stringify({
    url,
    format,
    maxChars,
    maxBytes: MAX_BODY_BYTES,
    maxSavedBytes: bounded(input.maxSavedBytes, MAX_SAVED_BYTES, 1, MAX_SAVED_BYTES),
    timeoutMs,
    secretPattern: SECRET_NAME.source,
  });
  const watch = watchFetchFailure(page, url, validateUrl);
  try {
    return await fetchHeld(
      page,
      args,
      url,
      format,
      maxChars,
      timeoutMs,
      deadline,
      watch,
      gate,
      validateUrl,
    );
  } finally {
    watch.dispose();
  }
};

const fetchHeld = async (
  page: FetchPage,
  args: string,
  url: string,
  format: "text" | "markdown",
  maxChars: number,
  timeoutMs: number,
  deadline: number,
  watch: ReturnType<typeof watchFetchFailure>,
  gate?: DispatchGate,
  validateUrl?: FetchUrlValidator,
): Promise<InPageFetchResult> => {
  await gate?.();
  const expression = `(async () => { const held = { body: null }; const outcome = await (${FETCH_SCRIPT})(${args}, held); return { outcome, body: held.body }; })()`;
  if (gate && !gate.channel) throw new Error("An action channel is required for fetch.");
  const pending = gate?.channel
    ? gate.channel.call(() => page.evaluateHandle<Held>(expression))
    : page.evaluateHandle<Held>(expression);
  const held = await beforeDeadline(pending, deadline, url).catch((cause: unknown) => {
    void pending.then((late) => late.dispose()).catch(() => undefined);
    throw cause;
  });
  try {
    return await shapeOutcome(
      page,
      held,
      url,
      format,
      maxChars,
      timeoutMs,
      deadline,
      watch,
      validateUrl,
    );
  } finally {
    void held.dispose().catch(() => undefined);
  }
};

const shapeOutcome = async (
  page: FetchPage,
  held: { evaluate<R, A>(read: (value: Held, arg: A) => R, arg: A): Promise<R> },
  url: string,
  format: "text" | "markdown",
  maxChars: number,
  timeoutMs: number,
  deadline: number,
  watch: ReturnType<typeof watchFetchFailure>,
  validateUrl?: FetchUrlValidator,
): Promise<InPageFetchResult> => {
  const outcome = await beforeDeadline(
    held.evaluate((value) => value.outcome, undefined),
    deadline,
    url,
  );
  await watch.assertRedirects();
  if ("error" in outcome) {
    if (outcome.invalidUrl)
      throw new ServerBrowserOperationError("PreviewAutomationExecutionError", outcome.error);
    if (outcome.timedOut)
      throw new ServerBrowserOperationError(
        "PreviewAutomationTimeoutError",
        `Fetching ${url} did not finish within ${timeoutMs}ms.`,
      );
    const known = watch.classify(outcome);
    if (known)
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `Fetching ${url} failed: ${known.reason}.`,
        { fetchFailure: known.fetchFailure },
      );
    const failed = redactSecrets(String(outcome.error), await tabCookies(page, [url]));
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      `Fetching ${url} failed: ${failed}`,
    );
  }
  const finalUrl = assertHttpUrl(outcome.url);
  await validateUrl?.(finalUrl);
  const cookies = await tabCookies(page, [url, finalUrl]);
  const redact = (text: string) => redactSecrets(text, cookies);
  const head = {
    url: redact(redactQuery(finalUrl)),
    status: outcome.status,
    ok: outcome.ok,
    contentType: redact(outcome.contentType),
  };
  if (outcome.kind === "raw")
    return { ...head, format: "raw", text: "", truncated: outcome.truncated };
  if (outcome.kind === "binary") {
    const body = await readHeldBody(held, outcome.size ?? 0, deadline, url);
    return { ...head, format: "raw", text: "", truncated: false, [FETCHED_BODY]: body };
  }
  let shown: string;
  let wasTruncated = outcome.truncated;
  if (outcome.kind === "html_markdown") {
    const cleaned = extractCleanMarkdown(outcome.text, { extractLinks: true });
    wasTruncated = wasTruncated || cleaned.stats.truncated;
    const title = outcome.title ? `# ${outcome.title}` : "";
    shown =
      title && cleaned.markdown ? `${title}\n\n${cleaned.markdown}` : title || cleaned.markdown;
  } else {
    shown = outcome.kind === "html" ? normalizeText(outcome.text) : outcome.text;
  }
  const text = redact(wasTruncated ? shown.replace(/\S+$/, "") : shown);
  const result = truncateText(text, maxChars);
  return {
    ...head,
    format: outcome.kind === "html" || outcome.kind === "html_markdown" ? format : "text",
    text: result.text,
    truncated: wasTruncated || result.truncated,
  };
};
