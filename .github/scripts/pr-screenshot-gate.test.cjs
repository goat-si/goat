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
  isMaintainerPermission,
  latestLabelActor,
  decideGate,
  main,
} = require("./pr-screenshot-gate.cjs");

const SHOT = "![after](https://raw.githubusercontent.com/goat-si/goat/abc123/120/after.png)";
const FENCE = "\x60\x60\x60";

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
  function stubFetch(routes) {
    const original = global.fetch;
    global.fetch = async (url) => {
      const pathname = new URL(url).pathname;
      if (!(pathname in routes)) return { ok: false, status: 404, json: async () => ({}) };
      const value = routes[pathname];
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
    fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
    const restore = stubFetch(routes);
    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(line);
    return main({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "goat-si/goat",
      GITHUB_TOKEN: "test",
      GITHUB_API_URL: "https://api.example.test",
      GOAT_SCREENSHOT_GATE: mode,
    })
      .finally(() => {
        console.log = originalLog;
        restore();
        fs.rmSync(dir, { recursive: true, force: true });
      })
      .then((code) => ({ code, logs }));
  }

  const uiPr = (labels = []) => ({
    "/repos/goat-si/goat/pulls/7": { draft: false, body: "No image.", changed_files: 1, labels },
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
    const { code } = await run("warn", {});
    assert.equal(code, 0);
  });
});
