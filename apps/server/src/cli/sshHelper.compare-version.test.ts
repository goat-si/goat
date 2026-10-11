// @effect-diagnostics nodeBuiltinImport:off - CLI subprocess is the boundary under test.
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
const moduleUrl = new URL("./sshHelper.ts", import.meta.url).href;
const effectUrl = import.meta.resolve("effect/Effect");
const cliUrl = import.meta.resolve("effect/cli");
const compare = (live: string, requested: string) =>
  new Promise<string>((resolve, reject) => {
    const script = `import * as Effect from ${JSON.stringify(effectUrl)};
import {Command} from ${JSON.stringify(cliUrl)};
import {sshHelperCommand} from ${JSON.stringify(moduleUrl)};
await Effect.runPromise(Command.runWith(sshHelperCommand,{version:'test'})(['compare-version',${JSON.stringify(live)},${JSON.stringify(requested)}]));`;
    NodeChildProcess.execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 10000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
describe("SSH helper version ordering", () => {
  it.each([
    ["1.2.3-nightly.20261012.2", "1.2.3-nightly.20261012.10", "older"],
    ["1.2.3-preview.20261012.10", "1.2.3-preview.20261012.2", "newer"],
    ["1.2.3", "1.2.3+build", "equal"],
  ])("compares %s with %s", async (live, requested, result) =>
    expect(await compare(live!, requested!)).toBe(result),
  );
  it("refuses malformed version tokens", async () => {
    await expect(compare("../1.2.3", "1.2.3")).rejects.toBeDefined();
  });
});
