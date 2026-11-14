// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - verifies generated remote scripts using real shell and Node processes.
import * as Effect from "effect/Effect";
import * as HostProcess from "@goat/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";
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

it.effect("rejects Node below the agent-device 22.12 floor", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const probe = NodeChildProcess.spawnSync(process.execPath, [], {
      input:
        `{ const os = require("node:os"); os.homedir = () => ${JSON.stringify(NodeOS.tmpdir())}; }\n` +
        `Object.defineProperty(process.versions, "node", { value: "22.11.0" });\n` +
        remoteDeviceScript("owner", "probe"),
      env: { PATH: NodePath.dirname(process.execPath) },
      encoding: "utf8",
    });
    expect(probe.status).not.toBe(0);
    expect(probe.stderr).toContain("Node 22.12 or newer");
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

const stopFakeHub = async (state: string, hubEntry: string) => {
  try {
    const hub = JSON.parse(await NodeFSP.readFile(NodePath.join(state, "hub.json"), "utf8"));
    if (hub.owner === "owner-1" && hub.entryPath === hubEntry) process.kill(hub.pid, "SIGTERM");
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes((error as { code?: string }).code ?? "")) throw error;
  }
};

const startWith = async (
  fakeAgentDevice: string,
  entryKind: "recorded" | "default" | "missing" = "recorded",
  withOtherOwner = false,
) => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-ssh-agent-start-"));
  const root = NodePath.join(home, ".t3/device");
  const state = NodePath.join(root, "hosts/owner-1");
  const hubEntry = NodePath.join(
    root,
    `tools/expo-device-hub@${DEVICE_HUB_VERSION}/node_modules/expo-device-hub/dist/server/cli.mjs`,
  );
  try {
    await NodeFSP.mkdir(state, { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(hubEntry), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(NodePath.dirname(hubEntry), "../../../../.install-complete"),
      DEVICE_HUB_VERSION,
    );
    await NodeFSP.writeFile(
      hubEntry,
      `import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = http.createServer((request, response) => {
  response.writeHead(request.url === "/readyz" ? 200 : 404);
  response.end();
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`,
    );
    const bin = NodePath.join(home, "bin");
    await NodeFSP.mkdir(bin);
    await NodeFSP.writeFile(
      NodePath.join(bin, "adb"),
      "#!/bin/sh\necho Android Debug Bridge fake\n",
      { mode: 0o755 },
    );

    const calls = NodePath.join(home, "calls.log");
    await NodeFSP.writeFile(calls, "");
    const defaultEntry = NodePath.join(
      root,
      `tools/agent-device@${AGENT_DEVICE_VERSION}/node_modules/agent-device/bin/agent-device.mjs`,
    );
    const entry = entryKind === "default" ? defaultEntry : NodePath.join(home, "agent-device.mjs");
    if (entryKind !== "missing") {
      await NodeFSP.mkdir(NodePath.dirname(entry), { recursive: true });
      await NodeFSP.writeFile(
        entry,
        `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
const clean = process.argv.includes("--clean");
${fakeAgentDevice}`,
      );
    }
    if (entryKind !== "default") {
      await NodeFSP.writeFile(
        NodePath.join(state, "agent.json"),
        JSON.stringify({ entryPath: entry }),
      );
    }
    const daemonFile = NodePath.join(state, "daemon.json");
    await NodeFSP.writeFile(daemonFile, JSON.stringify({ httpPort: 65534, token: "retained" }));

    const otherState = NodePath.join(root, "hosts/owner-2");
    const otherCalls = NodePath.join(home, "other-calls.log");
    if (withOtherOwner) {
      await NodeFSP.mkdir(otherState, { recursive: true });
      const otherEntry = NodePath.join(home, "other-agent-device.mjs");
      await NodeFSP.writeFile(
        otherEntry,
        `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(otherCalls)}, process.argv.slice(2).join(" ") + "\\n");
process.exit(0);
`,
      );
      await NodeFSP.writeFile(
        NodePath.join(otherState, "agent.json"),
        JSON.stringify({ entryPath: otherEntry }),
      );
      await NodeFSP.writeFile(
        NodePath.join(otherState, "daemon.json"),
        JSON.stringify({ httpPort: 65533, token: "other" }),
      );
      await NodeFSP.writeFile(otherCalls, "");
    }

    const child = NodeChildProcess.spawn(process.execPath, ["-"], {
      env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(remoteDeviceScript("owner-1", "start"));
    const exitCode = await new Promise((resolve) => child.once("close", resolve));
    const stops = (await NodeFSP.readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(` --state-dir ${state}`, ""));
    return {
      exitCode,
      stderr,
      stops,
      result: JSON.parse(stdout),
      daemonExists: await NodeFSP.access(daemonFile).then(
        () => true,
        () => false,
      ),
      otherDaemonExists: withOtherOwner
        ? await NodeFSP.access(NodePath.join(otherState, "daemon.json")).then(
            () => true,
            () => false,
          )
        : undefined,
      otherStops: withOtherOwner ? await NodeFSP.readFile(otherCalls, "utf8") : undefined,
      missingEntry: entry,
    };
  } finally {
    await stopFakeHub(state, hubEntry).finally(() =>
      NodeFSP.rm(home, { recursive: true, force: true }),
    );
  }
};

it.effect(
  "start cleans only its owner's retained agent and reports failures without dropping daemon state",
  () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      yield* Effect.promise(async () => {
        const clean = await startWith("process.exit(0);", "recorded", true);
        expect(clean).toMatchObject({
          exitCode: 0,
          stderr: "",
          stops: ["daemon stop --clean"],
          daemonExists: false,
          otherDaemonExists: true,
          otherStops: "",
        });
        expect(clean.result.cleanupWarning).toBeUndefined();
        expect(clean.result.stopError).toBeUndefined();

        const fallback = await startWith("process.exit(clean ? 1 : 0);", "default");
        expect(fallback).toMatchObject({
          exitCode: 0,
          stderr: "",
          stops: ["daemon stop --clean", "daemon stop"],
          daemonExists: false,
        });
        expect(fallback.result.cleanupWarning).toBe("exit 1: ");
        expect(fallback.result.stopError).toBeUndefined();

        const failed = await startWith("process.exit(1);");
        expect(failed).toMatchObject({
          exitCode: 0,
          stderr: "",
          stops: ["daemon stop --clean", "daemon stop"],
          daemonExists: true,
        });
        expect(failed.result.cleanupWarning).toBe("exit 1: ");
        expect(failed.result.stopError).toBe("exit 1: ");

        const missing = await startWith("process.exit(0);", "missing");
        expect(missing).toMatchObject({
          exitCode: 0,
          stderr: "",
          stops: [],
          daemonExists: true,
        });
        expect(missing.result.cleanupWarning).toContain(missing.missingEntry);
        expect(missing.result.stopError).toContain(missing.missingEntry);
      });
    }),
);
