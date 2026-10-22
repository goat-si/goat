// @effect-diagnostics globalDate:off -- Playwright event callbacks run outside Effect.
/*
 * URL redaction adapted from Synara's browserAutomation/browserDiagnostics.ts.
 * MIT License
 * Copyright (c) 2026 T3 Tools Inc.
 * Copyright (c) 2026 Emanuele Di Pietro
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type {
  PreviewAutomationConsoleEntry,
  PreviewAutomationLogs,
  PreviewAutomationLogsInput,
  PreviewAutomationNetworkEntry,
  PreviewAutomationPageError,
} from "@goat/contracts";
import type { ConsoleMessage, Page, Request, Response } from "playwright-core";
import { consoleText } from "./ServerBrowserPage.ts";

const BUFFER_LIMIT = 200;
const ENTRY_BUDGET_BYTES = 24_000;
const TEXT_LIMIT = 2_000;
const STACK_LIMIT = 4_000;
const URL_LIMIT = 2_048;
const INPUT_LIMIT = 8_192;
const QUERY_PARAMETER_LIMIT = 32;

const redactUrl = (raw: string) => {
  // Reject oversized URLs before parsing; a truncated authority can expose credentials.
  if (raw.length > INPUT_LIMIT) return "url:[redacted]";
  try {
    // Bound the query before URLSearchParams parses it, including duplicate keys.
    const bounded = raw.replace(/\?[^#]*/, (query) =>
      query.split("&", QUERY_PARAMETER_LIMIT).join("&"),
    );
    const url = new URL(bounded);
    if (!["http:", "https:", "ws:", "wss:", "about:"].includes(url.protocol)) {
      return `${url.protocol}[redacted]`;
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    const redacted = new URLSearchParams();
    const keys = new Set<string>();
    for (const key of url.searchParams.keys()) {
      if (keys.has(key)) continue;
      keys.add(key);
      redacted.append(key, "[REDACTED]");
    }
    url.search = redacted.toString();
    return url.href.slice(0, URL_LIMIT);
  } catch {
    return "invalid:[redacted]";
  }
};

// URL credentials and URL query values are redacted, and fragments are dropped.
// Within the output limits, other free-form console/error text is returned as the
// page produced it and is not scrubbed for secrets. String escapes, quotes and closing
// brackets delimit URL tokens; quoted query values are only parsed in structured fields.
export const scanDiagnosticUrlTokens = (text: string) => {
  const tokens: { start: number; end: number }[] = [];
  let cursor = 0;
  let examinedCharacters = 0;
  while (cursor < text.length) {
    // A fixed delimiter supports every scheme the old scan accepted. Charge the
    // searched span as well as explicit character visits to expose the linear budget.
    const separator = text.indexOf("://", cursor);
    examinedCharacters += separator === -1 ? text.length - cursor : separator + 3 - cursor;
    if (separator === -1) break;
    let start = -1;
    for (; cursor < separator; cursor++) {
      examinedCharacters++;
      const char = text[cursor]!;
      if (!/[a-z0-9+.-]/i.test(char)) start = -1;
      else if (
        start === -1 &&
        /[a-z]/i.test(char) &&
        (cursor === 0 || !/\w/.test(text[cursor - 1]!))
      ) {
        start = cursor;
      }
    }
    cursor = separator + 3;
    if (start === -1) continue;
    const contentStart = cursor;
    while (cursor < text.length) {
      examinedCharacters++;
      if (/[\s"'`\\<>\])}]/.test(text[cursor]!)) break;
      cursor++;
    }
    if (cursor > contentStart) tokens.push({ start, end: cursor });
  }
  return { tokens, examinedCharacters };
};

const redactText = (text: string, limit: number) => {
  const bounded = text.slice(0, INPUT_LIMIT);
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end } of scanDiagnosticUrlTokens(bounded).tokens) {
    parts.push(
      bounded.slice(cursor, start),
      text.length > INPUT_LIMIT && end === bounded.length
        ? "url:[redacted]"
        : redactUrl(bounded.slice(start, end)),
    );
    cursor = end;
  }
  parts.push(bounded.slice(cursor));
  return parts.join("").slice(0, limit);
};

const contains = (value: string, filter: string | undefined) =>
  filter === undefined || value.toLowerCase().includes(filter.toLowerCase());

/** One collector per Playwright page, shared by snapshots and logs-only reads. */
export class ServerBrowserDiagnostics {
  readonly consoleEntries: PreviewAutomationConsoleEntry[] = [];
  readonly networkEntries: PreviewAutomationNetworkEntry[] = [];
  private readonly errors: PreviewAutomationPageError[] = [];
  private readonly dropped = { console: 0, errors: 0, network: 0 };
  private readonly requests = new WeakMap<
    Request,
    {
      id: string;
      startedAt?: number;
      entry?: PreviewAutomationNetworkEntry;
    }
  >();
  private sequence = 0;
  private disposed = false;
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
    page.on("console", this.onConsole);
    page.on("pageerror", this.onError);
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfailed", this.onFailed);
    page.on("requestfinished", this.onFinished);
    page.on("close", this.dispose);
    page.on("crash", this.dispose);
  }

  private push<A>(stream: keyof typeof this.dropped, entries: A[], entry: A) {
    if (this.disposed) return;
    entries.push(entry);
    if (entries.length > BUFFER_LIMIT) {
      this.dropped[stream] += entries.length - BUFFER_LIMIT;
      entries.splice(0, entries.length - BUFFER_LIMIT);
    }
  }

  private readonly onConsole = (message: ConsoleMessage) => {
    this.push("console", this.consoleEntries, {
      level: message.type().slice(0, 32),
      text: redactText(consoleText(message), TEXT_LIMIT),
      timestamp: new Date().toISOString(),
    });
  };

  private readonly onError = (error: Error) => {
    this.push("errors", this.errors, {
      message: redactText(error.message, TEXT_LIMIT),
      ...(error.stack === undefined ? {} : { stack: redactText(error.stack, STACK_LIMIT) }),
      timestamp: new Date().toISOString(),
    });
  };

  private track(request: Request) {
    let tracked = this.requests.get(request);
    if (!tracked) {
      tracked = { id: String(++this.sequence) };
      this.requests.set(request, tracked);
    }
    return tracked;
  }

  private network(
    request: Request,
    phase: NonNullable<PreviewAutomationNetworkEntry["phase"]>,
    status: number | null,
    url = request.url(),
  ) {
    const tracked = this.track(request);
    const previous = tracked.entry;
    const entry: PreviewAutomationNetworkEntry = {
      requestId: tracked.id,
      phase,
      url: redactUrl(url),
      method: request.method().slice(0, 32),
      status: status ?? previous?.status ?? null,
      failed: phase === "failed",
      ...(phase === "failed"
        ? { errorText: redactText(request.failure()?.errorText ?? "", TEXT_LIMIT) }
        : {}),
      ...(tracked.startedAt === undefined
        ? {}
        : { durationMs: Math.max(0, Date.now() - tracked.startedAt) }),
      timestamp: new Date().toISOString(),
    };
    // Keep one record per request and refresh its position as it progresses.
    // Snapshots and filtered reads share the same bounded evidence.
    const index = previous === undefined ? -1 : this.networkEntries.indexOf(previous);
    if (index !== -1) this.networkEntries.splice(index, 1);
    tracked.entry = entry;
    this.push("network", this.networkEntries, entry);
  }

  private readonly onRequest = (request: Request) => {
    this.track(request).startedAt = Date.now();
    this.network(request, "request", null);
  };
  private readonly onResponse = (response: Response) =>
    this.network(response.request(), "response", response.status(), response.url());
  private readonly onFailed = (request: Request) => this.network(request, "failed", null);
  private readonly onFinished = (request: Request) => this.network(request, "finished", null);

  /** Newest-first reads never touch the page, clear evidence, or change refs. */
  read(input: PreviewAutomationLogsInput): PreviewAutomationLogs {
    const limit = input.limit ?? 50;
    let remainingBytes = ENTRY_BUDGET_BYTES;
    const select = <A>(
      stream: keyof typeof this.dropped,
      source: readonly A[],
      include: boolean,
      matches: (entry: A) => boolean,
    ) => {
      const matching = include ? source.filter(matches).toReversed() : [];
      const entries: A[] = [];
      for (const entry of matching.slice(0, limit)) {
        const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes > remainingBytes) break;
        remainingBytes -= bytes;
        entries.push(entry);
      }
      return {
        entries,
        droppedCount: this.dropped[stream],
        omittedCount: matching.length - entries.length,
      };
    };
    return {
      console: select(
        "console",
        this.consoleEntries,
        input.includeConsole ?? true,
        (entry) =>
          (input.consoleLevels === undefined || input.consoleLevels.includes(entry.level)) &&
          contains(entry.text, input.text),
      ),
      errors: select("errors", this.errors, input.includeErrors ?? true, (entry) =>
        contains(`${entry.message}\n${entry.stack ?? ""}`, input.text),
      ),
      network: select(
        "network",
        this.networkEntries,
        input.includeNetwork ?? true,
        (entry) =>
          contains(entry.url, input.url) &&
          (input.status === undefined || entry.status === input.status) &&
          (input.failed === undefined || entry.failed === input.failed) &&
          (input.method === undefined || entry.method.toUpperCase() === input.method.toUpperCase()),
      ),
    };
  }

  readonly dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.page.off("console", this.onConsole);
    this.page.off("pageerror", this.onError);
    this.page.off("request", this.onRequest);
    this.page.off("response", this.onResponse);
    this.page.off("requestfailed", this.onFailed);
    this.page.off("requestfinished", this.onFinished);
    this.page.off("close", this.dispose);
    this.page.off("crash", this.dispose);
  };
}
