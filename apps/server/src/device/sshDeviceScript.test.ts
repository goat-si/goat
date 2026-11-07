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

// Runs the stop-agent script against a fake agent-device whose behaviour is given as module source.
const stopAgentWith = async (fakeAgentDevice: string) => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-ssh-agent-stop-"));
  try {
    const state = NodePath.join(home, ".t3/device/hosts/owner-1");
    await NodeFSP.mkdir(state, { recursive: true });
    const calls = NodePath.join(home, "calls.log");
    const entry = NodePath.join(home, "agent-device.mjs");
    await NodeFSP.writeFile(
      entry,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
const clean = process.argv.includes("--clean");
${fakeAgentDevice}`,
    );
    await NodeFSP.writeFile(
      NodePath.join(state, "agent.json"),
      JSON.stringify({ entryPath: entry }),
    );
    const child = NodeChildProcess.spawn(process.execPath, ["-"], {
      env: { HOME: home, PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(remoteDeviceScript("owner-1", "stop-agent"));
    const exitCode = await new Promise((resolve) => child.once("close", resolve));
    const stops = (await NodeFSP.readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.replace(` --state-dir ${state}`, ""));
    return { exitCode, stderr, stops, result: stdout.trim() === "" ? null : JSON.parse(stdout) };
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
};

it.effect(
  "stopping remote agent tools ends retained runners, and reports how a failed cleanup ended",
  () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      yield* Effect.promise(async () => {
        expect(await stopAgentWith("process.exit(0);")).toEqual({
          exitCode: 0,
          stderr: "",
          stops: ["daemon stop --clean"],
          result: null,
        });
        // agent-device refuses cleanup for a daemon it cannot prove is its own.
        expect(await stopAgentWith("process.exit(clean ? 1 : 0);")).toEqual({
          exitCode: 0,
          stderr: "",
          stops: ["daemon stop --clean", "daemon stop"],
          result: { cleanupWarning: "exit 1: " },
        });
        // A cleanup that ends without an exit status, as a timed-out one does, still falls back.
        expect(
          await stopAgentWith(
            'if (clean) process.kill(process.pid, "SIGKILL"); else process.exit(0);',
          ),
        ).toEqual({
          exitCode: 0,
          stderr: "",
          stops: ["daemon stop --clean", "daemon stop"],
          result: { cleanupWarning: "exit SIGKILL: " },
        });
        expect(await stopAgentWith("process.exit(1);")).toEqual({
          exitCode: 0,
          stderr: "",
          stops: ["daemon stop --clean", "daemon stop"],
          result: { cleanupWarning: "exit 1: ", stopError: "exit 1: " },
        });
      });
    }),
);
