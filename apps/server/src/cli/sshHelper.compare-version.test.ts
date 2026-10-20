// @effect-diagnostics nodeBuiltinImport:off - CLI subprocess is the boundary under test.
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
const moduleUrl = new URL("./sshHelper.ts", import.meta.url).href;
const effectUrl = import.meta.resolve("effect/Effect");
const cliUrl = import.meta.resolve("effect/cli");
const compare = (live: string, requested: string, commitFlags: ReadonlyArray<string> = []) =>
  new Promise<string>((resolve, reject) => {
    const script = `import * as Effect from ${JSON.stringify(effectUrl)};
import {Command} from ${JSON.stringify(cliUrl)};
import {sshHelperCommand} from ${JSON.stringify(moduleUrl)};
await Effect.runPromise(Command.runWith(sshHelperCommand,{version:'test'})(${JSON.stringify(["compare-version", ...commitFlags, live, requested])}));`;
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
    // Commit time is in the version, so a later dev build sorts above an earlier
    // one even when its sha would sort first and no commit-time flag is passed.
    ["0.1.0-dev.1792000000.gfff881545", "0.1.0-dev.1792000100.g001234567", "older"],
    ["0.1.0-dev.1792000100.g001234567", "0.1.0-dev.1792000000.gfff881545", "newer"],
    ["0.1.1-nightly.20261020.4", "0.1.1-nightly.20261019.9", "newer"],
  ])("compares %s with %s", async (live, requested, result) =>
    expect(await compare(live!, requested!)).toBe(result),
  );
  // The launch script passes commit times ahead of the versions (#128).
  it.each([
    ["0.1.0-dev.e17501807", "0.1.0-dev.84b52e284", ["100", "200"], "older"],
    ["0.1.0-dev.84b52e284", "0.1.0-dev.e17501807", ["200", "100"], "newer"],
    ["0.1.0-nightly.20261012.2", "0.1.0-dev.84b52e284", ["300", "200"], "newer"],
    ["0.1.0-dev.e17501807", "0.1.0-dev.84b52e284", [], "unknown"],
    ["0.1.0-nightly.20261012.2", "0.1.0-dev.84b52e284", [], "unknown"],
  ] as const)("orders %s against %s by commit times %j", async (live, requested, times, result) =>
    expect(
      await compare(
        live,
        requested,
        times.length === 0
          ? []
          : ["--live-commit-time", times[0]!, "--requested-commit-time", times[1]!],
      ),
    ).toBe(result),
  );
  it("refuses malformed version tokens", async () => {
    await expect(compare("../1.2.3", "1.2.3")).rejects.toBeDefined();
  });
});
