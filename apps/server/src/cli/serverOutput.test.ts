// @effect-diagnostics nodeBuiltinImport:off -- The regression drives real process output errors.
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "vite-plus/test";

const runWithError = (stream: "stdout" | "stderr", code: string) =>
  NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { installServerOutputHandlers } from ${JSON.stringify(new URL("./serverOutput.ts", import.meta.url).href)};
    installServerOutputHandlers();
    const error = Object.assign(new Error("write failed"), { code: ${JSON.stringify(code)} });
    process.${stream}.emit("error", error);
    process.stdout.write("still running");
  `,
    ],
    { encoding: "utf8" },
  );

it.each(["stdout", "stderr"] as const)("survives a full-disk write error on %s", (stream) => {
  const result = runWithError(stream, "ENOSPC");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("still running");
  expect(result.stderr + result.stdout).toContain("ENOSPC");
});

it("does not conceal unexpected output errors", () => {
  const result = runWithError("stdout", "EIO");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("write failed");
});
