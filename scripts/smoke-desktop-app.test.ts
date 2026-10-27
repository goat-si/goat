// @effect-diagnostics nodeBuiltinImport:off - invokes the release command with an invalid packaged executable.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("fails publication and removes its temp home when the packaged app cannot launch", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-test-launch-failure-"));
  try {
    const temporary = NodePath.join(root, "temp");
    const artifacts = NodePath.join(root, "artifacts");
    NodeFS.mkdirSync(temporary);
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(import.meta.dirname, "smoke-desktop-app.ts"),
        "--executable",
        NodePath.join(root, "missing-app"),
        "--artifacts-dir",
        artifacts,
      ],
      {
        env: { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary },
        encoding: "utf8",
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Desktop launch check failed while launching the app");
    expect(NodeFS.existsSync(artifacts)).toBe(true);
    expect(NodeFS.readdirSync(temporary)).toEqual([]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
