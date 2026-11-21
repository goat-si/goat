// @effect-diagnostics nodeBuiltinImport:off -- Runs the hidden helper in a child process.
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

it("prints the exact script-launcher capability for installed runtimes", () => {
  const helper = NodeURL.pathToFileURL(
    NodeURL.fileURLToPath(new URL("./sshHelper.ts", import.meta.url)),
  ).href;
  const script = `import * as Effect from 'effect/Effect'; import { Command } from 'effect/cli'; import { sshHelperCommand } from ${JSON.stringify(helper)}; await Effect.runPromise(Command.runWith(sshHelperCommand,{version:'test'})(['launcher-capabilities']));`;
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("script-launcher\n");
});
