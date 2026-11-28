// @effect-diagnostics-next-line nodeBuiltinImport:off - a real origin for the page, since Playwright's own fulfilled responses carry CORS headers.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  inPageFetch,
  normalizeText,
  redactSecrets,
  resolveFetchUrl,
  truncateText,
} from "./inPageFetch.ts";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import { FETCHED_BODY } from "./browserArtifacts.ts";
import { SessionControl } from "./SessionControl.ts";

describe("resolveFetchUrl", () => {
  it("resolves relative paths against the tab and allows only http and https", () => {
    expect(resolveFetchUrl("/api/me?x=1", "https://app.example/inbox")).toBe(
      "https://app.example/api/me?x=1",
    );
    expect(resolveFetchUrl("http://other.example/", "https://app.example/")).toBe(
      "http://other.example/",
    );
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "blob:https://app.example/1",
      "about:blank",
    ]) {
      expect(() => resolveFetchUrl(url, "https://app.example/")).toThrow(/Only http and https/);
    }
  });
});

describe("text shaping", () => {
  it("tidies rendered text but keeps code fences as the page had them", () => {
    expect(normalizeText("  Title  \r\n\r\n\r\n\r\nBody\n~~~\n  indented\n~~~\n")).toBe(
      "Title\n\nBody\n~~~\n  indented\n~~~",
    );
    expect(truncateText("abcdef", 4)).toEqual({ text: "abcd", truncated: true });
    expect(truncateText("abc", 4)).toEqual({ text: "abc", truncated: false });
  });
});

describe("redactSecrets", () => {
  const cookies = [
    { name: "session", value: "LongHttpOnlyValue123" },
    { name: "sid", value: "ab12" },
    { name: "lang", value: "en" },
  ];

  it("removes every cookie the browser would send, however the page echoes it", () => {
    const echoed = redactSecrets(
      [
        "Cookie: session=LongHttpOnlyValue123; sid=ab12; lang=en",
        "pairs session=LongHttpOnlyValue123 sid=ab12 lang=en",
        'json {"sid":"ab12","session":"LongHttpOnlyValue123"}',
        "bare ab12 and xLongHttpOnlyValue123x and LongHttpOnlyValue123%20",
      ].join("\n"),
      cookies,
    );
    expect(echoed).not.toMatch(/LongHttpOnlyValue123|ab12|lang=en/);
    expect(echoed).toContain("Cookie: [redacted]");
    expect(echoed).toContain("lang=[redacted]");
  });

  it("keeps ordinary text that only resembles a short cookie", () => {
    const text = redactSecrets("ab123 open seven tokens; English is spoken", cookies);
    expect(text).toBe("ab123 open seven tokens; English is spoken");
  });

  it("removes authorization headers of any scheme and credential-like JSON fields", () => {
    const text = redactSecrets(
      [
        "Authorization: Basic dXNlcjpwYXNz",
        "proxy-authorization: Digest username=x",
        "Set-Cookie: a=b",
        "token in prose: Bearer eyJhbGciOi.abc.def",
        '{"accessToken":"t0k3n","user":"jane","csrf_token":"c5rf","author":"Kim"}',
      ].join("\n"),
      [],
    );
    expect(text).not.toMatch(/dXNlcjpwYXNz|username=x|a=b|eyJhbGciOi|t0k3n|c5rf/);
    expect(text).toContain('"user":"jane"');
    expect(text).toContain('"author":"Kim"');
    expect(redactSecrets("See Basic usage and Bearer of bad news", [])).toBe(
      "See Basic usage and Bearer of bad news",
    );
  });
});

describe("inPageFetch privacy", () => {
  const fakePage = (onEvaluate: () => void = () => undefined) => ({
    url: () => "https://app.example/",
    evaluateHandle: vi.fn(async () => {
      onEvaluate();
      const held = {
        outcome: {
          url: "https://app.example/me",
          status: 200,
          ok: true,
          contentType: "text/plain",
          kind: "text",
          text: "hello",
          truncated: false,
        },
        body: null,
      };
      return {
        evaluate: async (read: (value: typeof held) => unknown) => read(held),
        dispose: async () => undefined,
      };
    }),
    context: () => ({ cookies: async () => [] }),
    on: () => undefined,
    off: () => undefined,
  });

  it("never touches a private tab", async () => {
    const control = new SessionControl("agent");
    control.setPrivate(true);
    const page = fakePage();
    await expect(
      inPageFetch(page as unknown as Page, control, { url: "/me" }),
    ).rejects.toMatchObject({ reason: "privateMode" });
    expect(page.evaluateHandle).not.toHaveBeenCalled();
  });

  it("withholds the answer when a secret prompt opened while it ran, even briefly", async () => {
    const control = new SessionControl("agent");
    const page = fakePage(() => {
      control.setPrivate(true);
      control.setPrivate(false);
    });
    await expect(
      inPageFetch(page as unknown as Page, control, { url: "/me" }),
    ).rejects.toMatchObject({ reason: "privateMode" });
  });

  it("validates final response URL scheme and blocked-host validator before reading cookies or returning data", async () => {
    const control = new SessionControl("agent");
    const cookies = vi.fn(async () => []);
    const pageWithFinalUrl = (finalUrl: string) => ({
      url: () => "https://app.example/",
      evaluateHandle: vi.fn(async () => {
        const held = {
          outcome: {
            url: finalUrl,
            status: 200,
            ok: true,
            contentType: "text/plain",
            kind: "text" as const,
            text: "SENSITIVE_BODY",
            truncated: false,
          },
          body: null,
        };
        return {
          evaluate: async (read: (value: typeof held) => unknown) => read(held),
          dispose: async () => undefined,
        };
      }),
      context: () => ({ cookies }),
      on: () => undefined,
      off: () => undefined,
    });
    await expect(
      inPageFetch(pageWithFinalUrl("file:///etc/passwd") as unknown as Page, control, {
        url: "/me",
      }),
    ).rejects.toThrow(/Only http and https/);
    await expect(
      inPageFetch(
        pageWithFinalUrl("https://blocked.example/secret") as unknown as Page,
        control,
        { url: "/me" },
        undefined,
        (targetUrl) => {
          if (new URL(targetUrl).hostname === "blocked.example")
            throw new Error("blocked_final_url");
        },
      ),
    ).rejects.toThrow("blocked_final_url");
    expect(cookies).not.toHaveBeenCalled();
  });

  it("gives up on a page that never answers at its deadline, releases its handle and lets the next queued action run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const control = new SessionControl("agent");
      const disposed = Promise.withResolvers<void>();
      const asked = Promise.withResolvers<void>();
      const page = {
        url: () => "https://app.example/",
        evaluateHandle: async () => ({
          evaluate: () => {
            asked.resolve();
            return new Promise<never>(() => undefined);
          },
          dispose: async () => disposed.resolve(),
        }),
        context: () => ({ cookies: async () => [] }),
        on: () => undefined,
        off: () => undefined,
      };
      // Queued as the server queues tab work: the next action waits for the fetch to settle.
      const fetching = control
        .agent("agent", () =>
          inPageFetch(page as unknown as Page, control, { url: "/me", timeoutMs: 1_000 }),
        )
        .then(
          () => "answered",
          (error: unknown) => error,
        );
      const next = control.agent("agent", async () => "next");
      await asked.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await fetching).toMatchObject({ tag: "PreviewAutomationTimeoutError" });
      await disposed.promise;
      expect(await next).toBe("next");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!chromiumInstalled)("inPageFetch in a browser", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let sentCookies: Array<string | undefined>;
  const control = new SessionControl("agent");

  const ARTICLE = `<html><head><title>Inbox</title><script>window.secret = "script-token-1"</script></head>
<body>
  <h1>Messages</h1>
  <ul><li>First item</li><li>Second <b>item</b></li></ul>
  <p>Read the <a href="/docs?token=abc123&amp;page=2">docs</a> or <a href="javascript:alert(1)">this</a>.</p>
  <form><input type="hidden" name="csrf" value="csrf-hidden-9"><input type="password" value="pw-value-7"><textarea>draft-text-5</textarea><button>Send</button></form>
  <template><p>template-token-3</p></template>
  <div hidden>hidden-token-4</div>
  <pre>  code line</pre>
</body></html>`;

  const serve = async (route: Route) => {
    const url = new URL(route.request().url());
    sentCookies.push(route.request().headers()["cookie"]);
    if (url.pathname === "/")
      return route.fulfill({ contentType: "text/html", body: "<p>home</p>" });
    if (url.pathname === "/article")
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: ARTICLE });
    if (url.pathname === "/echo") {
      return route.fulfill({
        contentType: "text/plain",
        headers: { "set-cookie": "fresh=SetCookieValue99", "x-auth": "XAuthHeader88" },
        body: `Cookie: ${route.request().headers()["cookie"]}\nAuthorization: Basic dXNlcjpwYXNz\nsid is ab12\ncopied LongHttpOnlyValue123 here\n{"sid":"ab12","token":"tok-value-6","user":"jane"}\n`,
      });
    }
    if (url.pathname === "/logo.png")
      return route.fulfill({ contentType: "image/png", body: Buffer.from([137, 80, 78, 71]) });
    if (url.pathname === "/korean") {
      // "한국어" in EUC-KR.
      return route.fulfill({
        contentType: "text/plain; charset=euc-kr",
        body: Buffer.from([0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee]),
      });
    }
    if (url.pathname === "/long")
      return route.fulfill({ contentType: "text/plain", body: "word ".repeat(1000) });
    return route.fulfill({ status: 404, body: "missing" });
  };

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    sentCookies = [];
    context = await browser.newContext();
    await context.addCookies([
      {
        name: "session",
        value: "LongHttpOnlyValue123",
        url: "https://app.example",
        httpOnly: true,
      },
      { name: "sid", value: "ab12", url: "https://app.example" },
    ]);
    page = await context.newPage();
    await page.route("https://app.example/**", serve);
    await page.goto("https://app.example/");
  });
  afterEach(async () => {
    await context.close();
  });

  it("returns the page as Markdown without scripts, templates, hidden text or form values", async () => {
    const result = await inPageFetch(page, control, { url: "/article" });
    expect(result).toMatchObject({ status: 200, ok: true, format: "markdown", truncated: false });
    expect(result.text).toContain("# Inbox");
    expect(result.text).toContain("# Messages");
    expect(result.text).toContain("- First item");
    expect(result.text).toContain("- Second **item**");
    expect(result.text).toContain("[docs](/docs?token=redacted&page=2)");
    expect(result.text).toContain("```\n  code line\n```");
    expect(result.text).not.toMatch(
      /script-token|template-token|hidden-token|csrf-hidden|pw-value|draft-text|abc123|javascript/,
    );
  });

  it("uses clean markdown extraction to drop SPA JSON blobs, display:none, and inert noise while keeping secret redaction", async () => {
    const spaBlob = JSON.stringify({ $type: "hydration", payload: "x".repeat(150) });
    await page.route("https://app.example/spa", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<html><head><title>App</title></head><body><h1>Feed</h1><p>${spaBlob}</p><div style="display:none">hidden-display-1</div><div inert>inert-block-2</div><p>Cookie LongHttpOnlyValue123 ok</p></body></html>`,
      }),
    );
    const result = await inPageFetch(page, control, { url: "/spa", format: "markdown" });
    expect(result.format).toBe("markdown");
    expect(result.text).toContain("# App");
    expect(result.text).toContain("# Feed");
    expect(result.text).toContain("Cookie [redacted] ok");
    expect(result.text).not.toContain("hydration");
    expect(result.text).not.toContain("hidden-display-1");
    expect(result.text).not.toContain("inert-block-2");
    expect(result.text).not.toContain("LongHttpOnlyValue123");
  });

  it("refuses 302 redirects to blocked hosts or non-http schemes without leaking response data", async () => {
    const server = NodeHttp.createServer((request, response) => {
      const port = (server.address() as NodeNet.AddressInfo).port;
      if (request.url === "/page") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<p>ok</p>");
        return;
      }
      if (request.url === "/to-blocked") {
        response.writeHead(302, { location: `http://localhost:${port}/secret` });
        response.end();
        return;
      }
      if (request.url === "/bounce") {
        response.writeHead(302, { location: `http://localhost:${port}/hop` });
        response.end();
        return;
      }
      if (request.url === "/hop") {
        response.writeHead(302, {
          location: `http://127.0.0.1:${port}/final`,
          "access-control-allow-origin": "*",
        });
        response.end();
        return;
      }
      if (request.url === "/secret") {
        response.writeHead(200, {
          "content-type": "text/plain",
          "access-control-allow-origin": "*",
        });
        response.end("TOP_SECRET_BODY");
        return;
      }
      if (request.url === "/final") {
        response.writeHead(200, {
          "content-type": "text/plain",
          "access-control-allow-origin": "*",
        });
        response.end("FINAL_AFTER_BLOCKED_HOP");
        return;
      }
      if (request.url === "/to-file") {
        response.writeHead(302, { location: "file:///etc/passwd" });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await using _server = {
      [Symbol.asyncDispose]: () => new Promise<void>((done) => server.close(() => done())),
    };
    const port = (server.address() as NodeNet.AddressInfo).port;
    await page.goto(`http://127.0.0.1:${port}/page`);
    const blockedUrls: Array<string> = [];
    const validateUrl = (targetUrl: string) => {
      if (new URL(targetUrl).hostname === "localhost") {
        blockedUrls.push(targetUrl);
        throw new Error("blocked_redirect_host");
      }
    };
    await expect(
      inPageFetch(page, control, { url: "/to-blocked" }, undefined, validateUrl),
    ).rejects.toThrow("blocked_redirect_host");
    await expect(
      inPageFetch(page, control, { url: "/bounce" }, undefined, validateUrl),
    ).rejects.toThrow("blocked_redirect_host");
    await expect(
      inPageFetch(page, control, { url: "/to-file" }, undefined, validateUrl),
    ).rejects.toThrow(/Only http and https/);
    expect(blockedUrls.some((entry) => entry.includes("/secret"))).toBe(true);
    expect(blockedUrls.some((entry) => entry.includes("/hop"))).toBe(true);
  });

  it("sends the session's cookies but returns none of them, nor any credential header", async () => {
    const result = await inPageFetch(page, control, { url: "https://app.example/echo" });
    expect(sentCookies.at(-1)).toContain("session=LongHttpOnlyValue123");
    expect(result.format).toBe("text");
    expect(result.text).toContain('"user":"jane"');
    expect(result.text).not.toMatch(
      /LongHttpOnlyValue123|ab12|dXNlcjpwYXNz|tok-value-6|SetCookieValue99|XAuthHeader88/,
    );
    // The bare copy is caught only through the browser's cookie list, HttpOnly included.
    expect(result.text).toContain("copied [redacted] here");
    expect(result.text).not.toMatch(/set-cookie|x-auth/i);
  });

  it("redacts a cookie the tab only sent to another path, wherever it comes back", async () => {
    await context.addCookies([
      {
        name: "api",
        value: "ApiScopedValue456",
        domain: "app.example",
        path: "/api",
        httpOnly: true,
      },
    ]);
    await page.route("https://app.example/profile", (route) =>
      route.fulfill({ contentType: "text/plain", body: "your key is ApiScopedValue456" }),
    );
    await page.evaluate("fetch('/api/me').then((answer) => answer.text())");
    const result = await inPageFetch(page, control, { url: "/profile" });
    expect(result.text).toBe("your key is [redacted]");
  });

  it("redacts a cookie from the response's content type and from a failure's message", async () => {
    await context.addCookies([
      {
        name: "api",
        value: "ApiScopedValue456",
        domain: "app.example",
        path: "/api",
        httpOnly: true,
      },
    ]);
    await page.route("https://app.example/typed", (route) =>
      route.fulfill({ contentType: "text/plain; note=ApiScopedValue456", body: "ok" }),
    );
    expect((await inPageFetch(page, control, { url: "/typed" })).contentType).toBe(
      "text/plain; note=[redacted]",
    );
    // A page's own fetch wrapper decides what a failure says.
    await page.evaluate("window.fetch = () => Promise.reject(new Error('saw ApiScopedValue456'))");
    const failure = await inPageFetch(page, control, { url: "/typed" }).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    expect(failure).not.toContain("ApiScopedValue456");
  });

  it("says whether a failed fetch was refused by CORS, the page's CSP, DNS or the network", async () => {
    // A real server: Playwright adds CORS headers to the responses it fulfills itself.
    const server = NodeHttp.createServer((request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        ...(request.url === "/csp" ? { "content-security-policy": "connect-src 'self'" } : {}),
        ...(request.url === "/report-only"
          ? { "content-security-policy-report-only": "connect-src 'self'" }
          : {}),
      });
      response.end("<p>local</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await using _server = {
      [Symbol.asyncDispose]: () => new Promise<void>((done) => server.close(() => done())),
    };
    const port = (server.address() as NodeNet.AddressInfo).port;
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.route("https://gone.example/**", (route) => route.abort("namenotresolved"));
    await page.route("https://closed.example/**", (route) => route.abort("connectionrefused"));
    const failures = await Promise.all(
      [
        `http://localhost:${port}/data`,
        "https://gone.example/#section",
        "https://closed.example/",
      ].map((url) =>
        inPageFetch(page, control, { url }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    );
    expect(failures).toMatchObject([
      {
        tag: "PreviewAutomationExecutionError",
        detail: { fetchFailure: "cors" },
        message: expect.stringContaining("CORS"),
      },
      {
        detail: { fetchFailure: "dns" },
        message: expect.stringContaining("ERR_NAME_NOT_RESOLVED"),
      },
      {
        detail: { fetchFailure: "network" },
        message: expect.stringContaining("ERR_CONNECTION_REFUSED"),
      },
    ]);
    await page.goto(`http://127.0.0.1:${port}/csp`);
    await expect(
      inPageFetch(page, control, { url: `http://localhost:${port}/data` }),
    ).rejects.toMatchObject({
      detail: { fetchFailure: "csp" },
      message: expect.stringContaining("Content-Security-Policy"),
    });
    // A report-only policy lets the request go; CORS is what refused it.
    await page.goto(`http://127.0.0.1:${port}/report-only`);
    await expect(
      inPageFetch(page, control, { url: `http://localhost:${port}/data` }),
    ).rejects.toMatchObject({ detail: { fetchFailure: "cors" } });
    // A request the network dropped stays a network failure, even if a second one gets through.
    let flaky = 0;
    await page.route(`http://127.0.0.1:${port}/flaky`, (route) =>
      flaky++ === 0 ? route.abort("connectionreset") : route.fulfill({ body: "ok" }),
    );
    await expect(inPageFetch(page, control, { url: "/flaky" })).rejects.toMatchObject({
      detail: { fetchFailure: "network" },
      message: expect.stringContaining("ERR_CONNECTION_RESET"),
    });
    // A readable same-origin probe proves nothing about CORS, even after a bare ERR_FAILED.
    let failedOnce = 0;
    await page.route(`http://127.0.0.1:${port}/failed-once`, (route) =>
      failedOnce++ === 0 ? route.abort("failed") : route.fulfill({ body: "ok" }),
    );
    await expect(inPageFetch(page, control, { url: "/failed-once" })).rejects.toMatchObject({
      detail: { fetchFailure: "network" },
    });
  });

  it("keeps a body that is not text as bytes for a file, and bounds long text", async () => {
    const image = await inPageFetch(page, control, { url: "/logo.png" });
    expect(image).toMatchObject({ format: "raw", text: "", contentType: "image/png" });
    expect([...(image[FETCHED_BODY] ?? [])]).toEqual([137, 80, 78, 71]);
    // Held under a symbol, the bytes never appear in the result's JSON.
    expect(JSON.stringify(image)).not.toContain("137");
    const capped = await inPageFetch(page, control, { url: "/logo.png", maxSavedBytes: 3 });
    expect(capped).toMatchObject({ format: "raw", text: "", truncated: true });
    expect(capped[FETCHED_BODY]).toBeUndefined();
    expect((await inPageFetch(page, control, { url: "/korean" })).text).toBe("한국어");
    const long = await inPageFetch(page, control, { url: "/long", maxChars: 50 });
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(50);
  });
});
