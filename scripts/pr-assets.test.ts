// @effect-diagnostics nodeBuiltinImport:off - drives real git against throwaway repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { isolatedGitEnv } from "@goat/shared/testing/gitEnv";

import {
  buildAssetsCommit,
  fetchAssetsTip,
  listAssets,
  markdownFor,
  patchPrBody,
  planBodyFix,
  rawAssetUrl,
  uploadAssets,
  waitForImages,
} from "./pr-assets.ts";

const SHA = "1".repeat(40);
const REPO = "goat-si/goat";
const gate = NodeModule.createRequire(import.meta.url)(
  "../.github/scripts/pr-screenshot-gate.cjs",
) as { extractImageEmbeds(body: string): ReadonlyArray<{ readonly url: string }> };

describe("asset URLs", () => {
  it("pins the commit SHA and encodes each path segment", () => {
    expect(rawAssetUrl(REPO, SHA, "457/after move.png")).toBe(
      "https://raw.githubusercontent.com/goat-si/goat/" + SHA + "/457/after%20move.png",
    );
    expect(markdownFor(REPO, SHA, ["457/before-light.png", "457/after-dark.png"])).toBe(
      "![before-light](https://raw.githubusercontent.com/goat-si/goat/" +
        SHA +
        "/457/before-light.png)\n" +
        "![after-dark](https://raw.githubusercontent.com/goat-si/goat/" +
        SHA +
        "/457/after-dark.png)",
    );
  });

  it("prints markdown the gate reads back as the same URL", () => {
    const url = rawAssetUrl(REPO, SHA, "457/after (1)!.png");
    expect(url).toBe(
      "https://raw.githubusercontent.com/goat-si/goat/" + SHA + "/457/after%20%281%29%21.png",
    );
    expect(gate.extractImageEmbeds(markdownFor(REPO, SHA, ["457/after (1)!.png"]))).toMatchObject([
      { url },
    ]);
  });
});

describe("planBodyFix", () => {
  const assets = new Set(["457/before-light.png", "457/after-dark.png", "457/ready.png"]);
  const good = "https://raw.githubusercontent.com/goat-si/goat/" + "2".repeat(40) + "/457/x.png";

  it("rewrites only the broken URLs and keeps every other byte", () => {
    const body = [
      "## Screenshots\r",
      "![before light](pr-assets/before-light.png)\r",
      '<img width="600" src="./457/after-dark.png">\r',
      "![ready](https://raw.githubusercontent.com/goat-si/goat/pr-assets/457/ready.png)\r",
      "![kept](" + good + ")\r",
      "\x60\x60\x60md",
      "![example](pr-assets/before-light.png)",
      "\x60\x60\x60",
      "![gone](pr-assets/gone.png)",
    ].join("\n");
    const fix = planBodyFix(body, { pr: 457, repo: REPO, sha: SHA, assets });
    const raw = (name: string) =>
      "https://raw.githubusercontent.com/goat-si/goat/" + SHA + "/457/" + name;
    expect(fix.body).toBe(
      body
        .replace("](pr-assets/before-light.png)\r", "](" + raw("before-light.png") + ")\r")
        .replace("./457/after-dark.png", raw("after-dark.png"))
        .replace(
          "https://raw.githubusercontent.com/goat-si/goat/pr-assets/457/ready.png",
          raw("ready.png"),
        ),
    );
    expect(fix.body).toContain("![example](pr-assets/before-light.png)");
    expect(fix.replaced.map(({ from }) => from)).toEqual([
      "pr-assets/before-light.png",
      "./457/after-dark.png",
      "https://raw.githubusercontent.com/goat-si/goat/pr-assets/457/ready.png",
    ]);
    expect(fix.missing.map(({ url }) => url)).toEqual(["pr-assets/gone.png"]);
  });

  it("turns a SHA-pinned blob page into the raw file at the same commit", () => {
    const blob = "https://github.com/goat-si/goat/blob/" + "3".repeat(40) + "/151/a.png";
    const fix = planBodyFix("![a](" + blob + ")", {
      pr: 151,
      repo: REPO,
      sha: SHA,
      assets: new Set(),
    });
    expect(fix.body).toBe(
      "![a](https://raw.githubusercontent.com/goat-si/goat/" + "3".repeat(40) + "/151/a.png)",
    );
  });

  it("leaves a body with working embeds untouched", () => {
    const body = "![kept](" + good + ")\n";
    expect(planBodyFix(body, { pr: 457, repo: REPO, sha: SHA, assets })).toEqual({
      body,
      replaced: [],
      missing: [],
    });
  });

  it("matches GitHub's percent-encoded rendering and reports images it cannot locate", () => {
    const korean = new Set(["457/한글 화면.png"]);
    const body = "![ko](<pr-assets/한글 화면.png>)\n";
    const fix = planBodyFix(body, {
      pr: 457,
      repo: REPO,
      sha: SHA,
      assets: korean,
      rendered: new Set([encodeURI("pr-assets/한글 화면.png"), "pr-assets/elsewhere.png"]),
    });
    expect(fix.body).toBe("![ko](<" + rawAssetUrl(REPO, SHA, "457/한글 화면.png") + ">)\n");
    expect(fix.missing).toEqual([
      {
        url: "pr-assets/elsewhere.png",
        reason: expect.stringContaining("could not locate it"),
      },
    ]);
  });

  it("ignores source embeds GitHub does not render", () => {
    const body = "Example:\n\n    ![ready](pr-assets/ready.png)\n";
    const fix = planBodyFix(body, { pr: 457, repo: REPO, sha: SHA, assets, rendered: new Set() });
    expect(fix).toEqual({ body, replaced: [], missing: [] });
  });
});

describe("waitForImages", () => {
  it("polls until an image loads and reports one that never does", async () => {
    let calls = 0;
    const results = await waitForImages(["https://x.test/a.png", "https://x.test/b.png"], {
      intervalMs: 1,
      deadlineMs: 200,
      verify: async (url) => {
        if (url.endsWith("b.png")) return { status: "broken", reason: "returns HTTP 404" };
        calls += 1;
        return calls < 3 ? { status: "unverified", reason: "HTTP 404" } : { status: "ok" };
      },
    });
    expect(calls).toBe(3);
    expect(results.map(({ check }) => check.status)).toEqual(["ok", "broken"]);
  });
});

describe("pr-assets plumbing", () => {
  let root: string;
  let remote: string;
  let work: string;
  let other: string;
  const run = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      env: isolatedGitEnv(),
      encoding: "utf8",
    }).trim();
  const file = (name: string, content: string) => {
    const path = NodePath.join(root, "shots", name);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
    return path;
  };
  const show = (sha: string, path: string) => run(work, "show", sha + ":" + path);

  beforeAll(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pr-assets-test-"));
    remote = NodePath.join(root, "remote.git");
    work = NodePath.join(root, "work");
    other = NodePath.join(root, "other");
    run(root, "init", "--quiet", "--bare", remote);
    for (const clone of [work, other]) {
      run(root, "init", "--quiet", "-b", "main", clone);
      run(clone, "remote", "add", "origin", remote);
      for (const [key, value] of [
        ["user.name", "Test"],
        ["user.email", "test@example.com"],
        ["commit.gpgsign", "false"],
        ["core.hooksPath", "/dev/null"],
      ] as const) {
        run(clone, "config", key, value);
      }
    }
    NodeFS.writeFileSync(NodePath.join(work, "app.ts"), "export {};\n");
    run(work, "add", "app.ts");
    run(work, "commit", "--quiet", "-m", "init");
  });

  afterAll(() => {
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("creates the orphan branch without touching HEAD, the index, or the worktree", () => {
    NodeFS.writeFileSync(NodePath.join(work, "app.ts"), "export const staged = 1;\n");
    run(work, "add", "app.ts");
    NodeFS.writeFileSync(NodePath.join(work, "scratch.txt"), "untracked\n");
    const head = run(work, "rev-parse", "HEAD");
    const status = run(work, "status", "--porcelain");

    expect(fetchAssetsTip(work, "origin")).toBeNull();
    const { sha, paths } = uploadAssets({
      cwd: work,
      remote: "origin",
      pr: 7,
      files: [file("before.png", "before"), file("after.png", "after")],
    });

    expect(paths).toEqual(["7/before.png", "7/after.png"]);
    expect(run(remote, "rev-parse", "refs/heads/pr-assets")).toBe(sha);
    expect(run(work, "rev-list", "--parents", "-n", "1", sha)).toBe(sha);
    expect(run(work, "ls-tree", "-r", "--name-only", sha).split("\n")).toEqual([
      "7/after.png",
      "7/before.png",
    ]);
    expect(show(sha, "7/after.png")).toBe("after");
    expect(run(work, "rev-parse", "HEAD")).toBe(head);
    expect(run(work, "status", "--porcelain")).toBe(status);
    expect(run(work, "for-each-ref", "refs/pr-assets-helper")).toBe("");
  });

  it("adds to the existing tip and skips a commit when nothing changed", () => {
    const first = run(remote, "rev-parse", "refs/heads/pr-assets");
    const { sha } = uploadAssets({
      cwd: work,
      remote: "origin",
      pr: 8,
      files: [file("8/after.png", "eight")],
    });
    expect(run(work, "rev-parse", sha + "^")).toBe(first);
    expect(listAssets(work, sha, 7)).toEqual(new Set(["7/before.png", "7/after.png"]));
    expect(listAssets(work, sha, 8)).toEqual(new Set(["8/after.png"]));

    const again = uploadAssets({
      cwd: work,
      remote: "origin",
      pr: 8,
      files: [file("8/after.png", "eight")],
    });
    expect(again.sha).toBe(sha);
    expect(buildAssetsCommit(work, sha, [], "noop")).toBe(sha);
  });

  it("rebuilds on the new tip when another upload wins the race", () => {
    let raced = false;
    const { sha } = uploadAssets({
      cwd: work,
      remote: "origin",
      pr: 9,
      files: [file("mine.png", "mine")],
      beforePush: (attempt) => {
        if (attempt !== 1) return;
        raced = true;
        const tip = fetchAssetsTip(other, "origin");
        const theirs = buildAssetsCommit(
          other,
          tip,
          [{ path: "10/theirs.png", file: file("theirs.png", "theirs") }],
          "theirs",
        );
        run(other, "push", "--quiet", "origin", theirs + ":refs/heads/pr-assets");
      },
    });
    expect(raced).toBe(true);
    expect(run(remote, "rev-parse", "refs/heads/pr-assets")).toBe(sha);
    expect(show(sha, "9/mine.png")).toBe("mine");
    expect(show(sha, "10/theirs.png")).toBe("theirs");
    expect(show(sha, "7/before.png")).toBe("before");
  });

  it("lists non-ASCII asset names as written", () => {
    const { sha } = uploadAssets({
      cwd: work,
      remote: "origin",
      pr: 11,
      files: [file("한글 화면.png", "ko")],
    });
    expect(listAssets(work, sha, 11)).toEqual(new Set(["11/한글 화면.png"]));
  });

  it("rewrites the description, and stops if it changed during the image check", async () => {
    const sha = run(remote, "rev-parse", "refs/heads/pr-assets");
    // GitHub renders the indented example as code, so it stays as written even though 7/after.png exists.
    const original =
      "Before\n![before](pr-assets/before.png)\n\n    ![after](pr-assets/after.png)\n";
    let body = original;
    const writes: string[] = [];
    const store = {
      read: () => ({ body, rendered: new Set(["pr-assets/before.png"]) }),
      write: (bodyFile: string) => {
        body = NodeFS.readFileSync(bodyFile, "utf8");
        writes.push(body);
      },
    };
    const options = {
      cwd: work,
      repo: REPO,
      pr: 7,
      sha,
      dryRun: false,
      backupDir: NodePath.join(root, "backup"),
      store,
    };
    await expect(
      patchPrBody({
        ...options,
        verify: async () => {
          body = original + "A reviewer's note.\n";
          return { status: "ok" };
        },
      }),
    ).rejects.toThrow("changed while images were checked");
    expect(writes).toEqual([]);

    body = original;
    expect(await patchPrBody({ ...options, verify: async () => ({ status: "ok" }) })).toBe(true);
    expect(writes).toEqual([
      original.replace("pr-assets/before.png", rawAssetUrl(REPO, sha, "7/before.png")),
    ]);
    expect(NodeFS.readFileSync(NodePath.join(root, "backup", "before.md"), "utf8")).toBe(original);
  });

  it("refuses two files that would land on the same path", () => {
    expect(() =>
      uploadAssets({
        cwd: work,
        remote: "origin",
        pr: 7,
        files: [file("a/same.png", "1"), file("b/same.png", "2")],
      }),
    ).toThrow("7/same.png");
  });
});
