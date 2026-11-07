// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - verifies generated remote scripts using real shell and Node processes.
import * as Effect from "effect/Effect";
import * as HostProcess from "@goat/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { quoteRemoteArg, remoteDeviceEnvironment, remoteDeviceScript } from "./sshDeviceScript.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

it.effect("finds Android Studio Java for a non-interactive SSH session", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* Effect.promise(async () => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-ssh-java-"));
      try {
        const javaHome = NodePath.join(home, ".local/opt/android-studio/jbr");
        await NodeFSP.mkdir(NodePath.join(javaHome, "bin"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(javaHome, "bin/java"),
          "#!/bin/sh\necho test-java\n",
          { mode: 0o755 },
        );
        const result = await exec("/bin/sh", ["-c", `${remoteDeviceEnvironment}\njava`], {
          env: { HOME: home, PATH: "/nonexistent", JAVA_HOME: "" },
        });
        expect(result.stdout.trim()).toBe("test-java");
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    });
  }),
);

it.effect("preserves shell metacharacters and newlines in remote arguments", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* Effect.promise(async () => {
      const value = "quotes ' \" ; $(echo expanded) $HOME\nnext line";
      const result = await exec("sh", ["-c", `printf %s ${quoteRemoteArg(value)}`]);
      expect(result.stdout).toBe(value);
    });
  }),
);

it.effect(
  "stopping remote agent tools ends retained runners, and still stops when cleanup is refused",
  () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      yield* Effect.promise(async () => {
        const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-ssh-agent-stop-"));
        try {
          const state = NodePath.join(home, ".t3/device/hosts/owner-1");
          await NodeFSP.mkdir(state, { recursive: true });
          const calls = NodePath.join(home, "calls.log");
          // A fake agent-device that records each call and refuses runner cleanup.
          const entry = NodePath.join(home, "agent-device.mjs");
          await NodeFSP.writeFile(
            entry,
            `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
process.exit(process.argv.includes("--clean") ? 1 : 0);
`,
          );
          await NodeFSP.writeFile(
            NodePath.join(state, "agent.json"),
            JSON.stringify({ entryPath: entry }),
          );
          const child = NodeChildProcess.spawn(process.execPath, ["-"], {
            env: { HOME: home, PATH: process.env.PATH ?? "" },
            stdio: ["pipe", "ignore", "ignore"],
          });
          child.stdin.end(remoteDeviceScript("owner-1", "stop-agent"));
          await new Promise((resolve) => child.once("exit", resolve));
          expect((await NodeFSP.readFile(calls, "utf8")).trim().split("\n")).toEqual([
            `daemon stop --clean --state-dir ${state}`,
            `daemon stop --state-dir ${state}`,
          ]);
        } finally {
          await NodeFSP.rm(home, { recursive: true, force: true });
        }
      });
    }),
);
