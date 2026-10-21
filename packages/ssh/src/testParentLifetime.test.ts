// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  exitWithTestOwner,
  exitWithTestParent,
  TEST_OWNER_FILE,
} from "./testParentLifetime.fixture.ts";

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

  it.each(["owner exits", "fixture directory removed"] as const)(
    "a launched server with no stdin exits when its %s",
    async (cause) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-owner-"));
      // Stands in for the test worker: alive until this test ends it.
      const owner = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1 << 30)"],
        {
          stdio: "ignore",
        },
      );
      NodeFS.writeFileSync(NodePath.join(dir, TEST_OWNER_FILE), String(owner.pid));
      const server = NodeChildProcess.spawn(
        process.execPath,
        [
          "-e",
          `${exitWithTestOwner(JSON.stringify(dir))}
require("node:http").createServer().listen(0, "127.0.0.1", () => console.log("listening"));`,
        ],
        // The launch script starts servers with </dev/null, so the stdin watch cannot fire.
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      try {
        await NodeEvents.EventEmitter.once(server.stdout, "data");
        const exited = NodeEvents.EventEmitter.once(server, "exit");
        if (cause === "owner exits") {
          const ownerExited = NodeEvents.EventEmitter.once(owner, "exit");
          owner.kill("SIGKILL");
          await ownerExited;
        } else NodeFS.rmSync(dir, { recursive: true, force: true });
        const [code] = await exited;
        expect(code).toBe(0);
      } finally {
        for (const child of [server, owner])
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
