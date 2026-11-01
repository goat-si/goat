"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  WAIVER_LABEL,
  resolveMode,
  isUiPath,
  isChangedFileListTruncated,
  hasScreenshotEvidence,
  extractImageEmbeds,
  renderedImages,
  staticEmbedProblem,
  verifyImageUrl,
  isMaintainerPermission,
  latestLabelActor,
  decideGate,
  checkEmbeds,
  main,
} = require("./pr-screenshot-gate.cjs");

const SHA = "a".repeat(40);
const SHOT_PATH = "/goat-si/goat/" + SHA + "/120/after.png";
const SHOT = "![after](https://raw.githubusercontent.com" + SHOT_PATH + ")";
const FENCE = "\x60\x60\x60";
const CHECK_LIST_PATH = "/repos/goat-si/goat/commits/" + "c".repeat(40) + "/check-runs";
const png = () => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "image/png" }),
});
const notMutating = (request) => request.method === "GET" || request.method === "HEAD";

describe("hasScreenshotEvidence", () => {
  it("accepts inline markdown images, img tags, and defined reference images", () => {
    assert.equal(hasScreenshotEvidence(SHOT), true);
    assert.equal(hasScreenshotEvidence('<img width="600" src="https://example.com/ui.png">'), true);
    assert.equal(
      hasScreenshotEvidence("![after][shot]\n\n[shot]: https://example.com/a.png"),
      true,
    );
    assert.equal(hasScreenshotEvidence("![after][]\n\n[after]: https://example.com/a.png"), true);
  });

  it("ignores images inside fenced code and HTML comments", () => {
    assert.equal(hasScreenshotEvidence(FENCE + "\n" + SHOT + "\n" + FENCE), false);
    assert.equal(hasScreenshotEvidence('~~~\n<img src="https://example.com/ui.png">\n~~~'), false);
    assert.equal(hasScreenshotEvidence("<!-- " + SHOT + " -->"), false);
    assert.equal(hasScreenshotEvidence("<!--\n" + SHOT), false);
  });

  it("keeps a screenshot that follows a comment-like literal inside a fence", () => {
    const body = [FENCE + "html", "<!-- unclosed example", FENCE, "", SHOT].join("\n");
    assert.equal(hasScreenshotEvidence(body), true);
  });

  it("rejects links, bare URLs, empty img tags, and undefined references", () => {
    assert.equal(hasScreenshotEvidence("[Screenshot](https://example.com/ui.png)"), false);
    assert.equal(hasScreenshotEvidence("https://example.com/ui.png"), false);
    assert.equal(hasScreenshotEvidence('<img src="">'), false);
    assert.equal(hasScreenshotEvidence("![after][shot]"), false);
    assert.equal(hasScreenshotEvidence(undefined), false);
  });

  it("does not count the untouched PR template as evidence", () => {
    const template = fs.readFileSync(
      path.join(__dirname, "..", "pull_request_template.md"),
      "utf8",
    );
    assert.equal(hasScreenshotEvidence(template), false);
  });
});

describe("extractImageEmbeds", () => {
  it("locates every rendered embed's URL in the original body", () => {
    const body = [
      FENCE,
      "![in fence](pr-assets/x.png)",
      FENCE,
      "<!-- ![in comment](pr-assets/y.png) -->",
      '![before](pr-assets/before.png "title")',
      "![wrapped](<https://example.com/a b.png>)",
      "<img width=600 src='https://example.com/c.png?a=1&amp;b=2'>",
      "![ref][shot] ![ref again][shot]",
      "",
      "[shot]: https://example.com/d.png",
    ].join("\n");
    const embeds = extractImageEmbeds(body);
    assert.deepEqual(
      embeds.map((embed) => [embed.kind, embed.url, body.slice(embed.start, embed.end)]),
      [
        ["markdown", "pr-assets/before.png", "pr-assets/before.png"],
        ["markdown", "https://example.com/a b.png", "https://example.com/a b.png"],
        ["html", "https://example.com/c.png?a=1&b=2", "https://example.com/c.png?a=1&amp;b=2"],
        ["reference", "https://example.com/d.png", "https://example.com/d.png"],
      ],
    );
  });

  it("handles parentheses, &amp;, next-line definitions, and inline code", () => {
    const body = [
      "![paren](https://example.com/after(1).png)",
      "![amp](https://example.com/a.png?x=1&amp;y=2)",
      "Write \x60![example](pr-assets/x.png)\x60 or \x60\x60![two](pr-assets/y.png)\x60\x60 in prose.",
      "![ref][shot]",
      "",
      "[shot]:",
      "  https://example.com/d.png",
    ].join("\n");
    assert.deepEqual(
      extractImageEmbeds(body).map((embed) => embed.url),
      [
        "https://example.com/after(1).png",
        "https://example.com/a.png?x=1&y=2",
        "https://example.com/d.png",
      ],
    );
  });
});

describe("checkEmbeds", () => {
  it("does not let a code span swallow a CRLF paragraph break", () => {
    const body = "Use \x60one\r\n\r\n![real](https://example.com/a.png)\r\n\r\nand\x60 two";
    assert.deepEqual(
      extractImageEmbeds(body).map((embed) => embed.url),
      ["https://example.com/a.png"],
    );
  });

  it("keeps comments and code spans from hiding each other's neighbours", () => {
    const body = [
      "<!-- \x60 -->",
      "![real](pr-assets/real.png)",
      "<!-- \x60 -->",
      "\x60<!--\x60 ![after](pr-assets/after.png)",
    ].join("\n");
    assert.deepEqual(
      extractImageEmbeds(body).map((embed) => embed.url),
      ["pr-assets/real.png", "pr-assets/after.png"],
    );
  });

  it("reads src as an attribute, never from inside another attribute's value", () => {
    const tag =
      '<img alt="example src=\'https://example.com/ok.png\' > x" src="pr-assets/broken.png">';
    assert.deepEqual(
      extractImageEmbeds(tag).map((embed) => [embed.url, tag.slice(embed.start, embed.end)]),
      [["pr-assets/broken.png", "pr-assets/broken.png"]],
    );
    assert.deepEqual(
      renderedImages(tag).map((image) => image.url),
      ["pr-assets/broken.png"],
    );
  });

  it("reads GitHub's rendering, keeping the written URL and the proxied fetch URL", () => {
    const html = [
      "<pre><code>![code](https://example.com/a.png)</code></pre>",
      '<img src="pr-assets/x.png" alt="x">',
      '<a href="#"><img src="https://camo.githubusercontent.com/abc/def" alt="real" data-canonical-src="https://example.com/c(1).png?a=1&amp;b=2"></a>',
      '<img alt="no source">',
    ].join("\n");
    assert.deepEqual(renderedImages(html), [
      { kind: "rendered", url: "pr-assets/x.png", fetchUrl: "pr-assets/x.png" },
      {
        kind: "rendered",
        url: "https://example.com/c(1).png?a=1&b=2",
        fetchUrl: "https://camo.githubusercontent.com/abc/def",
      },
    ]);
  });

  it("applies URL rules to every embed and leaves images past the fetch cap unverified", async () => {
    const original = global.fetch;
    const fetched = [];
    global.fetch = async (url) => {
      fetched.push(url);
      return png();
    };
    try {
      const embeds = Array.from({ length: 105 }, (_, i) => ({
        url: "https://example.com/" + i + ".png",
      }));
      embeds.push({ url: "pr-assets/late.png" });
      const checked = await checkEmbeds(embeds);
      assert.equal(fetched.length, 100);
      assert.equal(checked.filter((embed) => embed.status === "ok").length, 100);
      assert.equal(checked.filter((embed) => embed.status === "unverified").length, 5);
      assert.equal(checked.at(-1).status, "broken");
    } finally {
      global.fetch = original;
    }
  });
});

describe("staticEmbedProblem", () => {
  it("rejects relative paths, branch names, and blob viewer pages", () => {
    for (const url of [
      "pr-assets/before-light.png",
      "./457/before.png",
      "/goat-si/goat/raw/pr-assets/457/a.png",
      "https://raw.githubusercontent.com/goat-si/goat/pr-assets/457/a.png",
      "https://raw.githubusercontent.com/goat-si/goat/refs/heads/pr-assets/457/a.png",
      "https://github.com/goat-si/goat/blob/pr-assets/457/a.png?raw=true",
      "https://github.com/goat-si/goat/raw/pr-assets/457/a.png",
      "https://github.com/goat-si/goat/blob/" + SHA + "/457/a.png",
      "https://raw.githubusercontent.com/goat-si/goat/abc123/120/after.png",
    ]) {
      assert.ok(staticEmbedProblem(url), url);
    }
  });

  it("leaves SHA-pinned and other absolute URLs to the fetch", () => {
    for (const url of [
      "https://raw.githubusercontent.com" + SHOT_PATH,
      "https://github.com/goat-si/goat/raw/" + SHA + "/457/a.png",
      "https://github.com/goat-si/goat/blob/" + SHA + "/457/a.png?raw=true",
      "https://github.com/user-attachments/assets/0b7c6e0e-1111-2222-3333-444455556666",
    ]) {
      assert.equal(staticEmbedProblem(url), null, url);
    }
  });
});

describe("verifyImageUrl", () => {
  function withFetch(handler, fn) {
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push(options.method);
      return handler(calls.length, options.method);
    };
    const delays = [];
    return fn({ sleep: async (ms) => delays.push(ms) })
      .then((result) => ({ result, calls, delays }))
      .finally(() => {
        global.fetch = original;
      });
  }
  const response = (status, type) => ({ status, headers: new Headers({ "content-type": type }) });

  it("accepts an image after HEAD, or after a GET when HEAD is refused", async () => {
    const head = await withFetch(png, (o) => verifyImageUrl("https://x.test/a.png", o));
    assert.deepEqual(head.result, { status: "ok" });
    assert.deepEqual(head.calls, ["HEAD"]);
    const get = await withFetch(
      (_n, method) => (method === "HEAD" ? response(405, "text/plain") : png()),
      (o) => verifyImageUrl("https://x.test/a.png", o),
    );
    assert.deepEqual(get.result, { status: "ok" });
    assert.deepEqual(get.calls, ["HEAD", "GET"]);
  });

  it("reports a missing file or a page that is not an image as broken", async () => {
    const missing = await withFetch(
      () => response(404, "text/plain"),
      (o) => verifyImageUrl("https://x.test/a.png", o),
    );
    assert.deepEqual(missing.result, { status: "broken", reason: "returns HTTP 404" });
    assert.deepEqual(missing.delays, []);
    const login = await withFetch(
      () => response(200, "text/html; charset=utf-8"),
      (o) => verifyImageUrl("https://x.test/a.png", o),
    );
    assert.equal(login.result.status, "broken");
    assert.match(login.result.reason, /text\/html.*not an image/);
  });

  it("retries network errors and 5xx, then reports unverified", async () => {
    const flaky = await withFetch(
      (n) => {
        if (n === 1) throw new TypeError("fetch failed");
        // Attempt 2: HEAD answers 503, so the GET fallback runs and succeeds.
        return n === 2 ? response(503, "text/plain") : png();
      },
      (o) => verifyImageUrl("https://x.test/a.png", o),
    );
    assert.deepEqual(flaky.result, { status: "ok" });
    assert.deepEqual(flaky.delays, [250]);
    const down = await withFetch(
      () => {
        throw new TypeError("fetch failed");
      },
      (o) => verifyImageUrl("https://x.test/a.png", o),
    );
    assert.deepEqual(down.result, { status: "unverified", reason: "fetch failed" });
    assert.deepEqual(down.delays, [250, 500]);
  });
});

describe("isUiPath", () => {
  it("covers the web, desktop, mobile, and marketing apps", () => {
    for (const file of [
      "apps/web/src/components/ChatView.tsx",
      "apps/desktop/src/main.ts",
      "apps/mobile/src/App.tsx",
      "apps/marketing/src/pages/index.astro",
      "apps/web/src/index.css",
    ]) {
      assert.equal(isUiPath(file), true, file);
    }
  });

  it("skips other areas, tests, and markdown inside UI apps", () => {
    for (const file of [
      "apps/server/src/ws.ts",
      "packages/contracts/src/rpc.ts",
      "docs/user/README.md",
      "apps/webby/x.ts",
      "apps/web/src/components/ChatView.test.tsx",
      "apps/web/src/components/ChatView.browser.tsx",
      "apps/desktop/src/__tests__/main.ts",
      "apps/mobile/test/setup.ts",
      "apps/mobile/README.md",
    ]) {
      assert.equal(isUiPath(file), false, file);
    }
  });
});

describe("decideGate", () => {
  const ui = ["apps/web/src/App.tsx", "apps/server/src/ws.ts"];

  it("skips drafts and PRs without UI changes", () => {
    assert.equal(decideGate({ draft: true, files: ui, body: "", waived: false }).outcome, "skip");
    const backend = decideGate({
      draft: false,
      files: ["apps/server/src/ws.ts"],
      body: "",
      waived: false,
    });
    assert.equal(backend.outcome, "skip");
  });

  it("reports missing evidence for a UI change without a screenshot", () => {
    const decision = decideGate({
      draft: false,
      files: ui,
      body: "Fixes the header.",
      waived: false,
    });
    assert.equal(decision.outcome, "missing");
    assert.deepEqual(decision.uiFiles, ["apps/web/src/App.tsx"]);
  });

  it("passes with a screenshot or a maintainer waiver", () => {
    assert.equal(
      decideGate({ draft: false, files: ui, body: SHOT, waived: false }).outcome,
      "pass",
    );
    assert.equal(decideGate({ draft: false, files: ui, body: "", waived: true }).outcome, "pass");
  });

  it("treats a description whose images do not load as missing, naming each one", () => {
    const decision = decideGate({
      draft: false,
      files: ui,
      body: SHOT + "\n![before](pr-assets/before.png)",
      waived: false,
    });
    assert.equal(decision.outcome, "missing");
    assert.deepEqual(
      decision.brokenEmbeds.map((embed) => embed.url),
      ["pr-assets/before.png"],
    );
    assert.match(decision.reason, /1 of 2 .*pr-assets\/before\.png \(relative path/);
  });

  it("is inconclusive when an image could not be fetched and none is known broken", () => {
    const base = { draft: false, files: ui, body: "", waived: false };
    const ok = { url: "https://x.test/a.png", status: "ok" };
    const down = { url: "https://x.test/b.png", status: "unverified", reason: "timed out" };
    const gone = { url: "https://x.test/c.png", status: "broken", reason: "returns HTTP 404" };
    assert.equal(decideGate({ ...base, embeds: [ok, down] }).outcome, "inconclusive");
    assert.equal(decideGate({ ...base, embeds: [down, gone] }).outcome, "missing");
    assert.equal(decideGate({ ...base, embeds: [ok] }).outcome, "pass");
  });

  it("fails closed when the file list is truncated", () => {
    const decision = decideGate({
      draft: false,
      files: ["apps/server/src/ws.ts"],
      filesTruncated: true,
      body: "",
      waived: false,
    });
    assert.equal(decision.outcome, "missing");
    assert.equal(isChangedFileListTruncated(3001, 3000), true);
    assert.equal(isChangedFileListTruncated(undefined, 3), true);
    assert.equal(isChangedFileListTruncated(3, 3), false);
  });
});

describe("waiver provenance", () => {
  const labeled = (login) => ({
    event: "labeled",
    label: { name: WAIVER_LABEL },
    actor: { login },
  });

  it("uses the latest application of the waiver label", () => {
    const other = { event: "labeled", label: { name: "size:S" }, actor: { login: "bot" } };
    assert.equal(latestLabelActor([labeled("alice"), other]), "alice");
    assert.equal(latestLabelActor([labeled("alice"), labeled("bob")]), "bob");
    const removed = {
      event: "unlabeled",
      label: { name: WAIVER_LABEL },
      actor: { login: "alice" },
    };
    assert.equal(latestLabelActor([labeled("alice"), removed]), null);
    assert.equal(latestLabelActor([]), null);
  });

  it("accepts only admin and maintain roles", () => {
    assert.equal(isMaintainerPermission({ permission: "admin", role_name: "admin" }), true);
    assert.equal(isMaintainerPermission({ permission: "write", role_name: "maintain" }), true);
    assert.equal(isMaintainerPermission({ permission: "write", role_name: "write" }), false);
    assert.equal(isMaintainerPermission({ permission: "write", role_name: "triage" }), false);
    assert.equal(isMaintainerPermission(undefined), false);
  });
});

describe("main", () => {
  function stubFetch(routes, requests) {
    const original = global.fetch;
    global.fetch = async (url, options) => {
      const pathname = new URL(url).pathname;
      requests.push({ path: pathname, ...options });
      if (!(pathname in routes)) return { ok: false, status: 404, json: async () => ({}) };
      const value = routes[pathname];
      if (typeof value === "function") return value(url, options);
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return {
        ok: true,
        status: 200,
        json: async () => (Array.isArray(value) && page > 1 ? [] : value),
      };
    };
    return () => {
      global.fetch = original;
    };
  }

  function run(mode, routes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-screenshot-gate-"));
    const eventPath = path.join(dir, "event.json");
    const summaryPath = path.join(dir, "summary.md");
    fs.writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { number: 7, head: { sha: "c".repeat(40) } } }),
    );
    const requests = [];
    const restore = stubFetch(
      { [CHECK_LIST_PATH]: { check_runs: [] }, [SHOT_PATH]: png, ...routes },
      requests,
    );
    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(line);
    const delays = [];
    return main(
      {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "goat-si/goat",
        GITHUB_TOKEN: "test",
        GITHUB_API_URL: "https://api.example.test",
        GOAT_SCREENSHOT_GATE: mode,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    )
      .then((code) => ({
        code,
        logs,
        delays,
        summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : "",
        requests,
        outcome: logs
          .join("\n")
          .match(/pr-screenshot-gate: (pass|skip|missing|inconclusive):/)?.[1],
      }))
      .finally(() => {
        console.log = originalLog;
        restore();
        fs.rmSync(dir, { recursive: true, force: true });
      });
  }

  const uiPr = (labels = []) => ({
    "/repos/goat-si/goat/pulls/7": {
      draft: false,
      body: "No image.",
      changed_files: 1,
      labels,
      head: { sha: "d".repeat(40) },
    },
    "/repos/goat-si/goat/pulls/7/files": [{ filename: "apps/web/src/App.tsx" }],
  });

  it("defaults to warn mode: annotates and exits 0", async () => {
    assert.equal(resolveMode(undefined), "warn");
    assert.equal(resolveMode("bogus"), "warn");
    const { code, logs } = await run("", uiPr());
    assert.equal(code, 0);
    assert.ok(logs.some((line) => line.startsWith("::warning")));
  });

  it("fails in enforce mode", async () => {
    const { code, logs } = await run("enforce", uiPr());
    assert.equal(code, 1);
    assert.ok(logs.some((line) => line.startsWith("::error")));
  });

  it("fails enforce mode on relative or missing images and names the helper", async () => {
    const routes = uiPr();
    routes["/repos/goat-si/goat/pulls/7"].body =
      "![before light](pr-assets/before-light.png)\n![gone](https://raw.githubusercontent.com/goat-si/goat/" +
      SHA +
      "/7/gone.png)";
    const { code, logs, summary, outcome } = await run("enforce", routes);
    assert.equal(code, 1);
    assert.equal(outcome, "missing");
    assert.match(summary, /pr-assets\/before-light\.png \(relative path/);
    assert.match(summary, /gone\.png \(returns HTTP 404\)/);
    assert.match(summary, /node scripts\/pr-assets\.ts upload/);
    assert.ok(logs.some((line) => line.startsWith("::error") && line.includes("do not load")));
  });

  it("reports an unreachable image host as inconclusive with a neutral check", async () => {
    for (const mode of ["warn", "enforce"]) {
      let calls = 0;
      const pass = uiPr();
      pass["/repos/goat-si/goat/pulls/7"].body = SHOT;
      const result = await run(mode, {
        ...pass,
        [SHOT_PATH]: async () => {
          calls += 1;
          throw new TypeError("fetch failed");
        },
        "/repos/goat-si/goat/check-runs": { id: 123 },
      });
      assert.equal(calls, 3);
      assert.deepEqual(result.delays, [250, 500]);
      assert.equal(result.outcome, "inconclusive");
      assert.equal(result.code, mode === "warn" ? 0 : 1);
      assert.match(result.summary, /could not confirm.*after\.png \(fetch failed\)/);
      const posts = result.requests.filter((request) => request.method === "POST");
      assert.equal(posts.length, 1);
      assert.equal(JSON.parse(posts[0].body).conclusion, "neutral");
    }
  });

  it("does not fetch images for PRs the gate skips", async () => {
    const skip = uiPr();
    skip["/repos/goat-si/goat/pulls/7"].draft = true;
    skip["/repos/goat-si/goat/pulls/7"].body = SHOT;
    const result = await run("enforce", skip);
    assert.equal(result.outcome, "skip");
    assert.equal(
      result.requests.some((request) => request.path === SHOT_PATH),
      false,
    );
  });

  it("judges the images GitHub renders when the API returns body_html", async () => {
    const routes = uiPr();
    const pr = routes["/repos/goat-si/goat/pulls/7"];
    // The source has an image only inside an indented code block, which GitHub renders as text.
    pr.body = "Example:\n\n    " + SHOT + "\n";
    pr.body_html = "<p>Example:</p>\n<pre><code>" + SHOT + "\n</code></pre>";
    const code = await run("enforce", routes);
    assert.equal(code.outcome, "missing");
    assert.equal(
      code.requests.some((request) => request.path === SHOT_PATH),
      false,
    );
    assert.equal(
      code.requests.find((request) => request.path === "/repos/goat-si/goat/pulls/7").headers
        .accept,
      "application/vnd.github.full+json",
    );

    pr.body_html =
      '<p><img src="https://raw.githubusercontent.com' + SHOT_PATH + '" alt="after"></p>';
    const rendered = await run("enforce", routes);
    assert.equal(rendered.outcome, "pass");

    pr.body_html = '<p><img src="pr-assets/after.png" alt="after"></p>';
    const relative = await run("enforce", routes);
    assert.equal(relative.outcome, "missing");
    assert.match(relative.summary, /pr-assets\/after\.png \(relative path/);
  });

  it("honors the waiver label only when a maintainer applied it", async () => {
    const events = [{ event: "labeled", label: { name: WAIVER_LABEL }, actor: { login: "lead" } }];
    const maintainer = await run("enforce", {
      ...uiPr([{ name: WAIVER_LABEL }]),
      "/repos/goat-si/goat/issues/7/events": events,
      "/repos/goat-si/goat/collaborators/lead/permission": {
        permission: "admin",
        role_name: "admin",
      },
    });
    assert.equal(maintainer.code, 0);
    const writer = await run("enforce", {
      ...uiPr([{ name: WAIVER_LABEL }]),
      "/repos/goat-si/goat/issues/7/events": events,
      "/repos/goat-si/goat/collaborators/lead/permission": {
        permission: "write",
        role_name: "write",
      },
    });
    assert.equal(writer.code, 1);
  });

  it("does not break CI when the API is unreachable in warn mode", async () => {
    const { code, logs, summary, outcome, delays } = await run("warn", {});
    assert.equal(code, 0);
    assert.ok(logs.some((line) => line.startsWith("::warning") && line.includes("inconclusive")));
    assert.match(summary, /inconclusive/);
    assert.equal(outcome, "inconclusive");
    assert.deepEqual(delays, []);
  });

  it("recovers from a files HTTP 500 and network failure within three attempts", async () => {
    let calls = 0;
    const { code, outcome, summary, delays } = await run("enforce", {
      ...uiPr(),
      "/repos/goat-si/goat/pulls/7/files": async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 500 };
        if (calls === 2) throw new TypeError("fetch failed");
        return { ok: true, json: async () => [{ filename: "apps/server/src/ws.ts" }] };
      },
    });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [250, 500]);
    assert.equal(code, 0);
    assert.equal(outcome, "skip");
    assert.doesNotMatch(summary, /inconclusive/);
  });

  it("reports exhausted files 5xx errors as inconclusive in advisory mode", async () => {
    let calls = 0;
    const { code, logs, summary, outcome, delays } = await run("warn", {
      ...uiPr(),
      "/repos/goat-si/goat/pulls/7/files": async () => {
        calls += 1;
        return { ok: false, status: 503 };
      },
    });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [250, 500]);
    assert.equal(code, 0);
    assert.equal(outcome, "inconclusive");
    assert.match(summary, /inconclusive.*returned 503/);
    assert.ok(logs.some((line) => line.startsWith("::warning") && line.includes("inconclusive")));
  });

  it("fails enforce mode with an inconclusive outcome after network retries", async () => {
    let calls = 0;
    const { code, logs, summary, outcome, delays } = await run("enforce", {
      ...uiPr(),
      "/repos/goat-si/goat/pulls/7/files": async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
    });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [250, 500]);
    assert.equal(code, 1);
    assert.equal(outcome, "inconclusive");
    assert.match(summary, /inconclusive/);
    assert.ok(logs.some((line) => line.startsWith("::error") && line.includes("inconclusive")));
  });

  it("does not retry files 4xx responses, including rate limits", async () => {
    for (const status of [401, 403, 404, 429]) {
      let calls = 0;
      const { code, outcome, delays } = await run("warn", {
        ...uiPr(),
        "/repos/goat-si/goat/pulls/7/files": async () => {
          calls += 1;
          return { ok: false, status };
        },
      });
      assert.equal(calls, 1, String(status));
      assert.deepEqual(delays, []);
      assert.equal(code, 0);
      assert.equal(outcome, "inconclusive");
    }
  });

  it("does not retry a malformed files response", async () => {
    let calls = 0;
    const { outcome, delays } = await run("warn", {
      ...uiPr(),
      "/repos/goat-si/goat/pulls/7/files": async () => {
        calls += 1;
        return {
          ok: true,
          json: async () => {
            throw new SyntaxError("invalid JSON");
          },
        };
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
    assert.equal(outcome, "inconclusive");
  });

  it("retries only the failed page and keeps files from earlier pages", async () => {
    const pages = [];
    const routes = uiPr();
    routes["/repos/goat-si/goat/pulls/7"].changed_files = 101;
    const { code, outcome, delays } = await run("enforce", {
      ...routes,
      "/repos/goat-si/goat/pulls/7/files": async (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        pages.push(page);
        if (page === 1) {
          return {
            ok: true,
            json: async () =>
              Array.from({ length: 100 }, () => ({ filename: "apps/server/src/ws.ts" })),
          };
        }
        if (pages.length === 2) return { ok: false, status: 502 };
        return { ok: true, json: async () => [{ filename: "apps/web/src/App.tsx" }] };
      },
    });
    assert.deepEqual(pages, [1, 2, 2]);
    assert.deepEqual(delays, [250]);
    assert.equal(code, 1);
    assert.equal(outcome, "missing");
  });

  it("creates a neutral check on the event PR head when inspection is inconclusive", async () => {
    for (const mode of ["warn", "enforce"]) {
      const result = await run(mode, {
        ...uiPr(),
        "/repos/goat-si/goat/pulls/7/files": async () => ({ ok: false, status: 503 }),
        "/repos/goat-si/goat/check-runs": { id: 123 },
      });
      assert.equal(result.code, mode === "warn" ? 0 : 1);
      const posts = result.requests.filter((request) => request.method === "POST");
      assert.equal(posts.length, 1);
      assert.equal(posts[0].path, "/repos/goat-si/goat/check-runs");
      assert.deepEqual(JSON.parse(posts[0].body), {
        name: "goat-screenshot-gate: inconclusive",
        head_sha: "c".repeat(40),
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "Screenshot gate could not inspect this PR",
          summary:
            "could not inspect PR #7: GET /repos/goat-si/goat/pulls/7/files?per_page=100&page=1 returned 503. Please re-run the goat-screenshot-gate job.",
        },
      });
      assert.match(result.summary, /inconclusive.*503/);
    }
  });

  it("keeps annotations, summaries, and exit codes when the neutral check cannot be posted", async () => {
    for (const failure of [403, 503, "network"]) {
      for (const mode of ["warn", "enforce"]) {
        const result = await run(mode, {
          ...uiPr(),
          "/repos/goat-si/goat/pulls/7/files": async () => ({ ok: false, status: 404 }),
          "/repos/goat-si/goat/check-runs": async () => {
            if (failure === "network") throw new TypeError("fetch failed");
            return { ok: false, status: failure };
          },
        });
        assert.equal(result.code, mode === "warn" ? 0 : 1);
        assert.equal(result.requests.filter((request) => request.method === "POST").length, 1);
        assert.deepEqual(result.delays, []);
        assert.match(result.summary, /inconclusive.*404/);
        assert.ok(
          result.logs.some(
            (line) =>
              line.startsWith("::" + (mode === "warn" ? "warning" : "error")) &&
              line.includes("inconclusive"),
          ),
        );
        assert.ok(
          result.logs.some(
            (line) =>
              line.startsWith("::warning") &&
              line.includes("could not synchronize inconclusive check") &&
              line.includes(failure === "network" ? "fetch failed" : String(failure)),
          ),
        );
      }
    }
  });

  it("does not create neutral checks for completed inspections or off mode", async () => {
    const pass = uiPr();
    pass["/repos/goat-si/goat/pulls/7"].body = SHOT;
    const skip = uiPr();
    skip["/repos/goat-si/goat/pulls/7"].draft = true;
    for (const [mode, routes, expected] of [
      ["warn", uiPr(), "missing"],
      ["enforce", pass, "pass"],
      ["warn", skip, "skip"],
      ["off", {}, undefined],
    ]) {
      const result = await run(mode, routes);
      assert.equal(result.outcome, expected);
      assert.equal(
        result.requests.some((request) => request.method === "POST"),
        false,
      );
    }
  });

  const waiverRoutes = () => ({
    ...uiPr([{ name: WAIVER_LABEL }]),
    "/repos/goat-si/goat/issues/7/events": [
      { event: "labeled", label: { name: WAIVER_LABEL }, actor: { login: "lead" } },
    ],
    "/repos/goat-si/goat/collaborators/lead/permission": {
      permission: "admin",
      role_name: "admin",
    },
  });
  const inspectionPaths = [
    "/repos/goat-si/goat/pulls/7",
    "/repos/goat-si/goat/issues/7/events",
    "/repos/goat-si/goat/collaborators/lead/permission",
  ];

  it("reuses the same check on repeated inconclusive runs for the same head", async () => {
    let check;
    const routes = {
      ...uiPr(),
      "/repos/goat-si/goat/pulls/7/files": async () => ({ ok: false, status: 404 }),
      [CHECK_LIST_PATH]: async (url) => {
        const query = new URL(url).searchParams;
        assert.equal(query.get("check_name"), "goat-screenshot-gate: inconclusive");
        assert.equal(query.get("filter"), "latest");
        return { ok: true, json: async () => ({ check_runs: check ? [check] : [] }) };
      },
      "/repos/goat-si/goat/check-runs": async (_url, options) => {
        check = { id: 123, ...JSON.parse(options.body) };
        return { ok: true, json: async () => check };
      },
      "/repos/goat-si/goat/check-runs/123": async (_url, options) => {
        check = { ...check, ...JSON.parse(options.body) };
        return { ok: true, json: async () => check };
      },
    };
    const first = await run("warn", routes);
    assert.equal(first.requests.filter((request) => request.method === "POST").length, 1);
    routes["/repos/goat-si/goat/pulls/7/files"] = async () => ({ ok: false, status: 403 });
    const second = await run("enforce", routes);
    assert.equal(second.code, 1);
    assert.equal(second.outcome, "inconclusive");
    assert.equal(second.requests.filter((request) => request.method === "POST").length, 0);
    const patches = second.requests.filter((request) => request.method === "PATCH");
    assert.equal(patches.length, 1);
    assert.equal(patches[0].path, "/repos/goat-si/goat/check-runs/123");
    assert.equal(check.conclusion, "neutral");
    assert.equal(check.output.title, "Screenshot gate could not inspect this PR");
    assert.match(check.output.summary, /returned 403.*re-run/);
  });

  it("resolves an earlier inconclusive check after pass, skip, missing, or waiver", async () => {
    const pass = uiPr();
    pass["/repos/goat-si/goat/pulls/7"].body = SHOT;
    const skip = uiPr();
    skip["/repos/goat-si/goat/pulls/7"].draft = true;
    for (const [routes, expected] of [
      [pass, "pass"],
      [skip, "skip"],
      [uiPr(), "missing"],
      [waiverRoutes(), "pass"],
    ]) {
      const result = await run("enforce", {
        ...routes,
        [CHECK_LIST_PATH]: { check_runs: [{ id: 123, conclusion: "neutral" }] },
        "/repos/goat-si/goat/check-runs/123": { id: 123 },
      });
      assert.equal(result.code, expected === "missing" ? 1 : 0);
      assert.equal(result.outcome, expected);
      assert.equal(result.requests.filter((request) => request.method === "POST").length, 0);
      const patches = result.requests.filter((request) => request.method === "PATCH");
      assert.equal(patches.length, 1);
      assert.equal(patches[0].path, "/repos/goat-si/goat/check-runs/123");
      const body = JSON.parse(patches[0].body);
      assert.equal(body.status, "completed");
      assert.equal(body.conclusion, "success");
      assert.equal(body.output.title, "Resolved: a later run inspected this PR");
      assert.ok(body.output.summary.includes(expected));
    }
  });

  it("tolerates check-list failures without changing decisions or exit codes", async () => {
    for (const failure of [403, 503, "network"]) {
      for (const mode of ["warn", "enforce"]) {
        for (const inconclusive of [false, true]) {
          const routes = uiPr();
          if (inconclusive) {
            routes["/repos/goat-si/goat/pulls/7/files"] = async () => ({ ok: false, status: 404 });
          } else {
            routes["/repos/goat-si/goat/pulls/7"].body = SHOT;
          }
          const result = await run(mode, {
            ...routes,
            [CHECK_LIST_PATH]: async () => {
              if (failure === "network") throw new TypeError("fetch failed");
              return { ok: false, status: failure };
            },
          });
          assert.equal(result.code, inconclusive && mode === "enforce" ? 1 : 0);
          assert.equal(result.outcome, inconclusive ? "inconclusive" : "pass");
          assert.equal(!result.requests.every(notMutating), false);
          assert.ok(
            result.logs.some(
              (line) =>
                line.startsWith("::warning") &&
                line.includes("inconclusive check") &&
                line.includes(failure === "network" ? "fetch failed" : String(failure)),
            ),
          );
        }
      }
    }
  });

  it("tolerates check-update failures without changing decisions or exit codes", async () => {
    for (const mode of ["warn", "enforce"]) {
      for (const inconclusive of [false, true]) {
        const routes = uiPr();
        if (inconclusive) {
          routes["/repos/goat-si/goat/pulls/7/files"] = async () => ({ ok: false, status: 404 });
        }
        const result = await run(mode, {
          ...routes,
          [CHECK_LIST_PATH]: { check_runs: [{ id: 123 }] },
          "/repos/goat-si/goat/check-runs/123": async () => ({ ok: false, status: 503 }),
        });
        assert.equal(result.code, mode === "enforce" ? 1 : 0);
        assert.equal(result.outcome, inconclusive ? "inconclusive" : "missing");
        assert.equal(result.requests.filter((request) => request.method === "PATCH").length, 1);
        assert.equal(result.requests.filter((request) => request.method === "POST").length, 0);
        assert.ok(result.logs.some((line) => line.startsWith("::warning") && line.includes("503")));
      }
    }
  });

  for (const inspectionPath of inspectionPaths) {
    it("retries HTTP 5xx and network errors for " + inspectionPath, async () => {
      const routes = waiverRoutes();
      const value = routes[inspectionPath];
      let calls = 0;
      routes[inspectionPath] = async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 502 };
        if (calls === 2) throw new TypeError("fetch failed");
        return { ok: true, json: async () => value };
      };
      const result = await run("enforce", routes);
      assert.equal(calls, 3);
      assert.deepEqual(result.delays, [250, 500]);
      assert.equal(result.code, 0);
      assert.equal(result.outcome, "pass");
      assert.equal(
        result.requests.some((request) => request.method === "POST"),
        false,
      );
    });

    it("reports exhausted retries as inconclusive for " + inspectionPath, async () => {
      for (const failure of [503, "network"]) {
        for (const mode of ["warn", "enforce"]) {
          let calls = 0;
          const result = await run(mode, {
            ...waiverRoutes(),
            [inspectionPath]: async () => {
              calls += 1;
              if (failure === "network") throw new TypeError("fetch failed");
              return { ok: false, status: failure };
            },
            "/repos/goat-si/goat/check-runs": { id: 123 },
          });
          assert.equal(calls, 3);
          assert.deepEqual(result.delays, [250, 500]);
          assert.equal(result.code, mode === "warn" ? 0 : 1);
          assert.equal(result.outcome, "inconclusive");
          assert.match(result.summary, /inconclusive/);
          assert.ok(
            result.summary.includes(failure === "network" ? "fetch failed" : inspectionPath),
          );
          if (failure !== "network") assert.match(result.summary, /returned 503/);
          assert.equal(result.requests.filter((request) => request.method === "POST").length, 1);
        }
      }
    });

    it("does not retry 4xx or malformed JSON for " + inspectionPath, async () => {
      for (const failure of [403, "json"]) {
        let calls = 0;
        const result = await run("warn", {
          ...waiverRoutes(),
          [inspectionPath]: async () => {
            calls += 1;
            return {
              ok: failure === "json",
              status: 403,
              json: async () => {
                throw new SyntaxError("invalid JSON");
              },
            };
          },
        });
        assert.equal(calls, 1);
        assert.deepEqual(result.delays, []);
        assert.equal(result.outcome, "inconclusive");
      }
    });
  }
});
