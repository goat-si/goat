// @effect-diagnostics nodeBuiltinImport:off -- executes the review script in an isolated real Git repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { parseReviewDiff, reviewDiffScript } from "./channelReviewDiff.ts";

it.live("remote review includes new unstaged files without changing the source index", () =>
  Effect.sync(() => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "channel-review-git-"));
    try {
      const git = (...args: string[]) =>
        NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" });
      git("init", "--quiet");
      NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "original\n");
      git("add", ".");
      git(
        "-c",
        "user.name=Review Fixture",
        "-c",
        "user.email=review@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      );
      const index = NodeFS.readFileSync(NodePath.join(root, ".git/index"));
      NodeFS.writeFileSync(NodePath.join(root, "new file.ts"), "export const defect = true;\n");
      const output = NodeChildProcess.execFileSync("sh", ["-s"], {
        input: reviewDiffScript(root, "HEAD"),
        encoding: "utf8",
      });
      assert.include(output, "new file.ts");
      assert.include(output, "+export const defect = true;");
      assert.deepStrictEqual(NodeFS.readFileSync(NodePath.join(root, ".git/index")), index);
      assert.strictEqual(git("status", "--porcelain"), '?? "new file.ts"\n');
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);

it.live("remote review refuses oversized untracked evidence and transport truncation", () =>
  Effect.sync(() => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "channel-review-bound-"));
    try {
      const git = (...args: string[]) =>
        NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" });
      git("init", "--quiet");
      git(
        "-c",
        "user.name=Review Fixture",
        "-c",
        "user.email=review@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "base",
      );
      NodeFS.writeFileSync(NodePath.join(root, "large.ts"), "x".repeat(2 * 1024 * 1024 + 1));
      const output = NodeChildProcess.execFileSync("sh", ["-s"], {
        input: reviewDiffScript(root, "HEAD"),
        encoding: "utf8",
      });
      assert.strictEqual(output, "GOAT_REVIEW_DIFF_REFUSED\n");
      assert.isUndefined(parseReviewDiff(output));
      assert.isUndefined(parseReviewDiff("GOAT_REVIEW_DIFF_OK 14\n+remote guard\n"));
      assert.isUndefined(
        parseReviewDiff("GOAT_REVIEW_DIFF_OK 15\n+remote guard\n\nGOAT_REVIEW_DIFF_END\n"),
      );
      assert.strictEqual(
        parseReviewDiff("GOAT_REVIEW_DIFF_OK 14\n+remote guard\n\nGOAT_REVIEW_DIFF_END\n"),
        "+remote guard\n",
      );
      assert.strictEqual(git("diff", "--cached"), "");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);
