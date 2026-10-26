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
  });
});

describe("inPageFetch privacy", () => {
  const fakePage = (onEvaluate: () => void = () => undefined) => ({
    url: () => "https://app.example/",
    evaluate: vi.fn(async () => {
      onEvaluate();
      return {
        url: "https://app.example/me",
        status: 200,
        ok: true,
        contentType: "text/plain",
        kind: "text",
        text: "hello",
        truncated: false,
      };
    }),
    context: () => ({ cookies: async () => [] }),
  });

  it("never touches a private tab", async () => {
    const control = new SessionControl("agent");
    control.setPrivate(true);
    const page = fakePage();
    await expect(
      inPageFetch(page as unknown as Page, control, { url: "/me" }),
    ).rejects.toMatchObject({ reason: "privateMode" });
    expect(page.evaluate).not.toHaveBeenCalled();
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
        body: `Cookie: ${route.request().headers()["cookie"]}\nAuthorization: Basic dXNlcjpwYXNz\nsid is ab12\n{"sid":"ab12","token":"tok-value-6","user":"jane"}\n`,
      });
    }
    if (url.pathname === "/logo.png")
      return route.fulfill({ contentType: "image/png", body: Buffer.from([137, 80, 78, 71]) });
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
    expect(result.text).toContain("- Second item");
    expect(result.text).toContain("[docs](https://app.example/docs?token=redacted&page=2)");
    expect(result.text).toContain("~~~\n  code line\n~~~");
    expect(result.text).not.toMatch(
      /script-token|template-token|hidden-token|csrf-hidden|pw-value|draft-text|abc123|javascript/,
    );
  });

  it("sends the session's cookies but returns none of them, nor any credential header", async () => {
    const result = await inPageFetch(page, control, { url: "https://app.example/echo" });
    expect(sentCookies.at(-1)).toContain("session=LongHttpOnlyValue123");
    expect(result.format).toBe("text");
    expect(result.text).toContain('"user":"jane"');
    expect(result.text).not.toMatch(
      /LongHttpOnlyValue123|ab12|dXNlcjpwYXNz|tok-value-6|SetCookieValue99|XAuthHeader88/,
    );
  });

  it("returns no content for a body that is not text, and bounds long text", async () => {
    expect(await inPageFetch(page, control, { url: "/logo.png" })).toMatchObject({
      format: "raw",
      text: "",
      contentType: "image/png",
    });
    const long = await inPageFetch(page, control, { url: "/long", maxChars: 50 });
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(50);
  });
});
