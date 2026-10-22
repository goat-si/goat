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
  killGroupWithTestOwner,
  TEST_OWNER_FILE,
} from "./testParentLifetime.fixture.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import { ChildProcess } from "effect/process";

// The same shape as a fixture seed: a listening server that would otherwise run forever.
const seed = (condition: string) => `
${exitWithTestParent(condition)}
require("node:http").createServer().listen(0, "127.0.0.1", () => console.log("listening"));
`;

describe("fixture seed lifetime", () => {
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "a fixture shell parked on a FIFO read dies with the worker that owns it",
    async () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-owner-"));
      const gate = NodePath.join(dir, "gate");
      NodeChildProcess.execFileSync("mkfifo", [gate]);
      // Stands in for the test worker: alive until this test ends it.
      const owner = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1 << 30)"],
        {
          stdio: "ignore",
        },
      );
      const guarded = killGroupWithTestOwner(
        ChildProcess.make("sh", ["-c", `echo parked; read -r release < '${gate}'`]),
        owner.pid,
      );
      if (guarded._tag !== "StandardCommand") throw new Error("expected a standard command");
      // Detached like the Effect spawner, so the shell leads its own process group.
      const shell = NodeChildProcess.spawn(guarded.command, [...guarded.args], {
        detached: true,
        stdio: ["ignore", "pipe", "inherit"],
      });
      try {
        await NodeEvents.EventEmitter.once(shell.stdout, "data");
        const exited = NodeEvents.EventEmitter.once(shell, "exit");
        owner.kill("SIGKILL");
        const [, signal] = await exited;
        expect(signal).toBe("SIGKILL");
      } finally {
        for (const child of [shell, owner])
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
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
