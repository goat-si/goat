// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";

import { describe, expect, it } from "@effect/vitest";
import { exitWithTestParent } from "./testParentLifetime.fixture.ts";

// The same shape as a fixture seed: a listening server that would otherwise run forever.
const seed = (condition: string) => `
${exitWithTestParent(condition)}
require("node:http").createServer().listen(0, "127.0.0.1", () => console.log("listening"));
`;

describe("fixture seed lifetime", () => {
  it("a seed server exits when the test that spawned it goes away", async () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", seed("true")], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    try {
      await NodeEvents.EventEmitter.once(child.stdout, "data");
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      // A dead test worker closes its end of the pipe the same way.
      child.stdin.end();
      const [code] = await exited;
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
