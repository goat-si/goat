import * as NodeEvents from "node:events";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";
import { scanDiagnosticUrlTokens, ServerBrowserDiagnostics } from "./ServerBrowserDiagnostics.ts";

const fixture = () => {
  const page = new NodeEvents.EventEmitter();
  const diagnostics = new ServerBrowserDiagnostics(page as unknown as Page);
  const consoleMessage = (text: string, level = "log", args: unknown[] = [text]) =>
    page.emit("console", { type: () => level, text: () => text, args: () => args });
  return { page, diagnostics, consoleMessage };
};

describe("ServerBrowserDiagnostics", () => {
  it("removes Chromium data URL payloads before recording while preserving page-authored text", () => {
    const { diagnostics, consoleMessage } = fixture();
    const url = "data:text/plain;name=private.txt,private payload\nwith more text";
    consoleMessage(`Blocked navigation to ${url}`, "error", []);
    expect(diagnostics.consoleEntries[0]?.text).toBe("Blocked navigation to data:text/plain,…");
    expect(diagnostics.read({ text: "private" }).console.entries).toEqual([]);
    consoleMessage(url);
    expect(diagnostics.read({}).console.entries[0]?.text).toBe(url);
  });
  it("keeps newest entries with separate eviction and filtered omission counts", () => {
    const { diagnostics, consoleMessage } = fixture();
    for (let i = 0; i < 205; i++) consoleMessage(`entry ${i}`, i % 2 === 0 ? "warning" : "log");
    const result = diagnostics.read({ consoleLevels: ["warning"], text: "ENTRY", limit: 2 });
    expect(result.console).toMatchObject({ droppedCount: 5, omittedCount: 98 });
    expect(result.console.entries.map((entry) => entry.text)).toEqual(["entry 204", "entry 202"]);
    expect(diagnostics.read({ consoleLevels: ["error"] }).console.entries).toEqual([]);
    expect(diagnostics.read({ limit: 2 })).toEqual(diagnostics.read({ limit: 2 }));
  });

  it("correlates request phases, filters metadata, and never reads bodies or headers", () => {
    const { page, diagnostics } = fixture();
    const forbidden = vi.fn(() => {
      throw new Error("Payload must not be read");
    });
    const request = {
      url: () => "https://user:password@example.test/api?token=secret&token=second#private",
      method: () => "POST",
      failure: () => ({ errorText: "net::ERR_FAILED" }),
      headers: forbidden,
      postData: forbidden,
    };
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(100);
      page.emit("request", request);
      const pending = diagnostics.read({}).network.entries[0];
      expect(pending).toMatchObject({
        phase: "request",
        status: null,
        failed: false,
        durationMs: 0,
      });
      now.mockReturnValue(125);
      page.emit("response", {
        request: () => request,
        url: request.url,
        status: () => 503,
        headers: forbidden,
        body: forbidden,
      });
      expect(diagnostics.read({}).network.entries[0]).toMatchObject({
        phase: "response",
        status: 503,
        requestId: pending?.requestId,
        durationMs: 25,
      });
      now.mockReturnValue(140);
      page.emit("requestfailed", request);
      const network = diagnostics.read({}).network.entries;
      expect(network).toHaveLength(1);
      expect(network[0]).toMatchObject({
        phase: "failed",
        requestId: pending?.requestId,
        method: "POST",
        failed: true,
        durationMs: 40,
      });
      expect(network[0]?.url).toBe("https://example.test/api?token=%5BREDACTED%5D");
      expect(
        diagnostics.read({ status: 503, method: "post", url: "/API" }).network.entries,
      ).toHaveLength(1);
      expect(diagnostics.read({ failed: true }).network.entries).toHaveLength(1);
      expect(diagnostics.read({ failed: false }).network.entries).toHaveLength(0);
      expect(diagnostics.read({ url: "secret" }).network.entries).toEqual([]);
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("includes completed requests and tolerates attachment after a request started", () => {
    const { page, diagnostics } = fixture();
    const request = { url: () => "https://example.test/", method: () => "GET" };
    page.emit("request", request);
    page.emit("response", { request: () => request, url: request.url, status: () => 200 });
    page.emit("requestfinished", request);
    expect(diagnostics.read({ status: 200 }).network.entries).toHaveLength(1);
    expect(diagnostics.read({}).network.entries[0]).toMatchObject({
      phase: "finished",
      status: 200,
    });
    const untracked = { url: () => "https://example.test/untracked", method: () => "GET" };
    page.emit("requestfinished", untracked);
    expect(diagnostics.read({}).network.entries[0]).toMatchObject({
      phase: "finished",
      failed: false,
    });
    expect(diagnostics.read({}).network.entries[0]?.durationMs).toBeUndefined();
  });

  it("redacts credentials, query values and fragments even in errors and console text", () => {
    const { page, diagnostics, consoleMessage } = fixture();
    const url = "https://user:password@example.test/app.js?token=secret#private";
    consoleMessage(`See ${url}`);
    const error = new Error(`Failed ${url}`);
    error.stack = `Error: Failed\n at ${url}:2:5`;
    page.emit("pageerror", error);
    const result = diagnostics.read({ text: "FAILED" });
    expect(result.errors.entries).toHaveLength(1);
    expect(result.errors.entries[0]?.stack).toContain("at https://example.test/app.js?token=");
    expect(result.console.entries).toEqual([]);
    const all = JSON.stringify(diagnostics.read({}));
    for (const secret of ["password", "secret", "private", "user:"])
      expect(all).not.toContain(secret);
    consoleMessage("file:///private/source.js data:text/plain,private blob:https://private/");
    expect(diagnostics.read({}).console.entries[0]?.text).toBe(
      "file:[redacted] data:text/plain,private blob:https://private/",
    );
  });

  it.each([
    '"TOP_SECRET"',
    "'TOP_SECRET'",
    `' {"token":"TOP_SECRET"} '`,
    '"TOP SECRET"',
    '"TOP_SECRET\\"suffix"',
    'prefix"TOP_SECRET"',
    `'{"html":"<div> TOP_SECRET"}'`,
    'prefix"TOP SECRET"',
  ])("redacts complete quoted query values in structured URLs: %s", (value) => {
    const { page, diagnostics } = fixture();
    const url = `https://USER_SECRET:PASS_SECRET@example.test/api?token=${value}&other=OTHER_SECRET#FRAGMENT_SECRET`;
    page.emit("requestfinished", {
      url: () => url,
      method: () => "GET",
    });
    expect(diagnostics.read({}).network.entries[0]?.url).toBe(
      "https://example.test/api?token=%5BREDACTED%5D&other=%5BREDACTED%5D",
    );
  });

  it.each([
    '"TOP SECRET"',
    "'TOP SECRET'",
    "`TOP SECRET`",
    '\\"TOP SECRET',
    "<div> TOP SECRET",
    "> TOP SECRET",
    "] TOP SECRET",
    ") TOP SECRET",
    "} TOP SECRET",
    " TOP SECRET",
    "\nTOP SECRET",
    "\tTOP SECRET",
  ])("preserves text after a URL token delimiter across diagnostics: %s", (suffix) => {
    const { page, diagnostics, consoleMessage } = fixture();
    const text = `See https://user:password@example.test/api?token=prefix${suffix}`;
    const expected = `See https://example.test/api?token=%5BREDACTED%5D${suffix}`;
    consoleMessage(text);
    const error = new Error(text);
    error.stack = `Error: Failed\n at ${text}`;
    page.emit("pageerror", error);
    page.emit("requestfailed", {
      url: () => "https://example.test/",
      method: () => "GET",
      failure: () => ({ errorText: text }),
    });
    const result = diagnostics.read({});
    expect(result.console.entries[0]?.text).toBe(expected);
    expect(result.errors.entries[0]?.message).toBe(expected);
    expect(result.errors.entries[0]?.stack).toBe(`Error: Failed\n at ${expected}`);
    expect(result.network.entries[0]?.errorText).toBe(expected);
  });

  it("redacts multiple URL tokens without rewriting the text between them", () => {
    const { diagnostics, consoleMessage } = fixture();
    consoleMessage(
      'URLs (https://user:password@example.test/a?token=secret#fragment), "keep this" [wss://user:password@example.test/b?session=secret#fragment]',
    );
    expect(diagnostics.read({}).console.entries[0]?.text).toBe(
      'URLs (https://example.test/a?token=%5BREDACTED%5D), "keep this" [wss://example.test/b?session=%5BREDACTED%5D]',
    );
  });

  it.each(['\\"secret', "\\nsecret", "\\u0022secret", "\\\\secret"])(
    "preserves JSON string escapes after a URL query: %s",
    (suffix) => {
      const { diagnostics, consoleMessage } = fixture();
      const text = `{"url":"https://example.test/?q=prefix${suffix}","other":"keep"}`;
      const expected = text.replace("q=prefix", "q=%5BREDACTED%5D");
      consoleMessage(text);
      const actual = diagnostics.read({}).console.entries[0]?.text;
      expect(actual).toBe(expected);
      expect(JSON.parse(actual!)).toEqual(JSON.parse(expected));
    },
  );

  it("scans adversarial scheme candidates with a linear character budget", () => {
    for (const length of [8_192, 65_536]) {
      for (const text of [
        "a-".repeat(length / 2),
        "a-:// ".repeat(length / 8),
        "9_a-:// ".repeat(length / 8),
      ]) {
        const result = scanDiagnosticUrlTokens(text);
        expect(result.tokens).toEqual([]);
        expect(result.examinedCharacters).toBeGreaterThanOrEqual(text.length);
        expect(result.examinedCharacters).toBeLessThanOrEqual(text.length * 4);
      }
    }
  });

  it("preserves scheme support, case and word boundaries in the linear scan", () => {
    const text =
      "_https://example.test/ 9https://example.test/ 9-HTTPS://example.test/ WS://example.test/ custom+v1.2://example.test/ file:///tmp/example";
    const result = scanDiagnosticUrlTokens(text);
    expect(result.tokens.map(({ start, end }) => text.slice(start, end))).toEqual([
      "HTTPS://example.test/",
      "WS://example.test/",
      "custom+v1.2://example.test/",
      "file:///tmp/example",
    ]);
    expect(result.examinedCharacters).toBeLessThanOrEqual(text.length * 4);
  });

  it.each([
    [
      '{"url":"https://example.test/a","other":"keep"}',
      '{"url":"https://example.test/a","other":"keep"}',
    ],
    [
      '{"url":"https://example.test/a?token=secret","other":"keep"}',
      '{"url":"https://example.test/a?token=%5BREDACTED%5D","other":"keep"}',
    ],
    [
      '{"url":"https://example.test/?q=\\"secret"}',
      '{"url":"https://example.test/?q=%5BREDACTED%5D\\"secret"}',
    ],
  ])("preserves surrounding JSON when redacting URL tokens: %s", (text, expected) => {
    const { diagnostics, consoleMessage } = fixture();
    consoleMessage(text);
    const actual = diagnostics.read({}).console.entries[0]?.text;
    expect(actual).toBe(expected);
    expect(JSON.parse(actual!)).toEqual(JSON.parse(expected));
  });

  it.each([200, 10_000])("bounds query processing for %i parameters", (count) => {
    const { page, diagnostics, consoleMessage } = fixture();
    const query = Array.from({ length: count }, (_, i) => `k${i}=SECRET`).join("&");
    const url = `https://example.test/api?${query}`;
    consoleMessage(url);
    page.emit("requestfinished", { url: () => url, method: () => "GET" });
    const result = diagnostics.read({});
    for (const text of [result.console.entries[0]?.text, result.network.entries[0]?.url]) {
      expect(text).toBeDefined();
      expect(text).not.toContain("SECRET");
      expect(text?.length).toBeLessThanOrEqual(2_048);
      expect(text?.match(/k\d+=/g)?.length ?? 0).toBeLessThanOrEqual(32);
      if (count === 200) expect(text).toContain("k31=%5BREDACTED%5D");
      else expect(text).toBe("url:[redacted]");
    }
  });

  it("rejects oversized structured URLs before parsing credentials or quoted values", () => {
    const { page, diagnostics } = fixture();
    const urls = [
      `https://USER_SECRET:${"PASSWORD_SECRET".repeat(1_000)}@example.test/`,
      `https://example.test/api?token="${"TOP SECRET ".repeat(1_000)}"`,
    ];
    for (const url of urls) {
      page.emit("requestfinished", { url: () => url, method: () => "GET" });
      const result = diagnostics.read({ limit: 1 });
      expect(result.network.entries[0]?.url).toBe("url:[redacted]");
    }
  });

  it("does not expose credentials in a URL token cut by the input limit", () => {
    const { diagnostics, consoleMessage } = fixture();
    consoleMessage(`https://USER_SECRET:${"PASSWORD_SECRET".repeat(1_000)}@example.test/`);
    expect(diagnostics.read({}).console.entries[0]?.text).toBe("url:[redacted]");
  });

  it("bounds UTF-8 output and reports entries omitted by the shared byte budget", () => {
    const { page, diagnostics, consoleMessage } = fixture();
    for (let i = 0; i < 205; i++) {
      consoleMessage("界".repeat(8_000));
      const error = new Error("界".repeat(8_000));
      error.stack = "界".repeat(8_000);
      page.emit("pageerror", error);
      page.emit("requestfinished", {
        url: () => `https://example.test/${"界".repeat(8_000)}`,
        method: () => "GET",
      });
    }
    const result = diagnostics.read({ limit: 100 });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(25_000);
    expect(result.console.omittedCount).toBeGreaterThan(100);
    expect(result.errors.droppedCount).toBe(5);
    expect(result.network.droppedCount).toBe(5);
    expect(diagnostics.read({ includeConsole: false }).errors.entries[0]?.stack?.length).toBe(
      4_000,
    );
    const excluded = diagnostics.read({
      includeConsole: false,
      includeErrors: false,
      includeNetwork: false,
    });
    expect(excluded.console.entries).toEqual([]);
    expect(excluded.errors.entries).toEqual([]);
    expect(excluded.network.entries).toEqual([]);
  });

  it.each(["close", "crash"])(
    "detaches collectors on %s and tolerates repeated disposal",
    (event) => {
      const { page, diagnostics, consoleMessage } = fixture();
      consoleMessage("before");
      page.emit(event);
      const before = diagnostics.read({});
      expect(page.eventNames()).toEqual([]);
      diagnostics.dispose();
      consoleMessage("after");
      page.emit("pageerror", new Error("after"));
      page.emit("requestfinished", { url: () => "https://example.test/", method: () => "GET" });
      expect(diagnostics.read({})).toEqual(before);
    },
  );
});
