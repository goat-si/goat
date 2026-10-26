// @effect-diagnostics nodeBuiltinImport:off - runs setup's directory step in a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";

import { selectWorktreeInstall } from "./setup-worktree.ts";

describe("selectWorktreeInstall", () => {
  it("prefers vp, then pnpm, then npx vite-plus, without the --yes pnpm 12 can reject (#1001)", () => {
    assert.deepEqual(selectWorktreeInstall({ vp: true, pnpm: true }), {
      command: "vp i --frozen-lockfile",
      tool: "vp",
    });
    assert.deepEqual(selectWorktreeInstall({ vp: false, pnpm: true }), {
      command: "pnpm install --frozen-lockfile",
      tool: "pnpm",
    });
    assert.deepEqual(selectWorktreeInstall({ vp: false, pnpm: false }), {
      command: "npx --yes vite-plus i --frozen-lockfile",
      tool: "npx vite-plus",
    });
  });
});

describe("createMarkerDirectory", () => {
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "creates the worktree .goat without group or other access under umask 002 (#1648)",
    () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-setup-"));
      try {
        const markerDir = NodePath.join(root, "worktree", ".goat");
        const setupModule = NodeURL.pathToFileURL(
          NodePath.join(import.meta.dirname, "setup-worktree.ts"),
        );
        // The umask is set in the child, so the result never depends on the host's umask.
        const script = [
          "process.umask(0o002);",
          `const { createMarkerDirectory } = await import(${JSON.stringify(setupModule.href)});`,
          `createMarkerDirectory(${JSON.stringify(markerDir)});`,
        ].join("\n");
        const child = NodeChildProcess.spawnSync(
          process.execPath,
          ["--input-type=module", "--eval", script],
          { encoding: "utf8" },
        );
        assert.equal(child.status, 0, child.stderr);
        for (const directory of [NodePath.dirname(markerDir), markerDir]) {
          assert.equal(NodeFS.statSync(directory).mode & 0o777, 0o700, directory);
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
