// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { vitePlusCommand } from "./check-changed-command.ts";
import { changedVitestBatches } from "./lib/split-tests.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const reporters = ["--reporter=default"];
if (process.env.GITHUB_ACTIONS === "true") reporters.push("--reporter=github-actions");

for (const { cwd, files } of changedVitestBatches(process.argv.slice(2))) {
  process.stdout.write(
    `\nVitest: ${files.length} files in ${cwd === "." ? "the workspace" : cwd}\n`,
  );
  const [command, args] = vitePlusCommand(["test", "run", ...reporters, ...files]);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: NodePath.resolve(root, cwd),
    stdio: "inherit",
  });
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  if (result.signal !== null) break;
}
