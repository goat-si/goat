// @effect-diagnostics nodeBuiltinImport:off -- Runs the real CLI with a temporary home.
import { it, expect } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

it("reports an unowned fresh home with exit 1 even when runtime directories are absent", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-free-home-"));
  try {
    const helper = NodeURL.pathToFileURL(
      NodeURL.fileURLToPath(new URL("./sshHelper.ts", import.meta.url)),
    ).href;
    const script = `import * as Effect from 'effect/Effect'; import { Command } from 'effect/cli'; import { sshHelperCommand } from ${JSON.stringify(helper)}; await Effect.runPromise(Command.runWith(sshHelperCommand,{version:'test'})(['home-owned',${JSON.stringify(home)},'--deadline-ms','10000']));`;
    for (const createDirectories of [false, true]) {
      if (createDirectories) {
        NodeFS.mkdirSync(NodePath.join(home, "runtime"));
        NodeFS.mkdirSync(NodePath.join(home, "userdata"));
      }
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
    }
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
