// @effect-diagnostics nodeBuiltinImport:off - Tests run the helper against a real loopback descriptor.
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import packageJson from "../../package.json" with { type: "json" };
import { sshHelperCommand } from "./sshHelper.ts";

// What a runtime whose helper lacks `capabilities` prints; the probe caches only this exact answer.
const OLD_HELPER_STDERR = '\nERROR\n  Unknown subcommand "capabilities" for "goat __ssh-helper"\n';

const runModule = (body: string) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const script = `import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
import {Command} from ${JSON.stringify(import.meta.resolve("effect/cli"))};
import * as NodeRuntime from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeRuntime"))};
import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
${body}`;
    const child = NodeChildProcess.execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 20000 },
      (_error, stdout, stderr) => resolve({ status: child.exitCode, stdout, stderr }),
    );
  });

const helperModule = JSON.stringify(new URL("./sshHelper.ts", import.meta.url).href);
const probesModule = JSON.stringify(new URL("./sshRuntimeProbes.ts", import.meta.url).href);

describe("SSH helper capabilities", () => {
  it("a helper without the subcommand answers with the exact signature the probe caches", async () => {
    const result = await runModule(`const {protocol} = await import(${probesModule});
const root = Command.make("goat").pipe(Command.withSubcommands([Command.make("__ssh-helper").pipe(Command.withSubcommands([protocol]))]));
Command.runWith(root, {version: "test"})(["__ssh-helper", "capabilities"]).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);`);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(OLD_HELPER_STDERR);
  });

  it("a supporting helper prints one caps line, exits 0 and writes nothing to stderr", async () => {
    const result = await runModule(`const {sshHelperCommand} = await import(${helperModule});
const root = Command.make("goat").pipe(Command.withSubcommands([sshHelperCommand]));
Command.runWith(root, {version: "test"})(["__ssh-helper", "capabilities"]).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);`);
    expect(result).toEqual({ status: 0, stdout: "caps v1 facts\n", stderr: "" });
  });
});

const startDescriptor = async (instanceIds: ReadonlyArray<string | undefined>) => {
  let requests = 0;
  const server = NodeHttp.createServer((request, response) => {
    if (request.url !== "/.well-known/goat/environment") {
      response.writeHead(404);
      response.end();
      return;
    }
    const instanceId = instanceIds[Math.min(requests++, instanceIds.length - 1)];
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        environmentId: "facts-fixture",
        label: "Fixture",
        platform: { os: "linux", arch: "x64" },
        capabilities: { drainRestart: true },
        serverVersion: packageJson.version,
        sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        ...(instanceId === undefined ? {} : { instanceId }),
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No loopback port");
  return {
    port: address.port,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
};

// A runtime record naming this process, whose descriptor answers the given instance ids in turn.
const liveRecord = (instanceIds: ReadonlyArray<string | undefined>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-helper-facts-"));
      const server = await startDescriptor(instanceIds);
      const runtimeFile = NodePath.join(home, "server-runtime.json");
      NodeFS.writeFileSync(
        runtimeFile,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: server.port,
          origin: `http://127.0.0.1:${server.port}`,
          startedAt: "2026-11-10T00:00:00.000Z",
          serverVersion: packageJson.version,
          sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        }),
      );
      const files = [
        "--runtime-file",
        runtimeFile,
        "--port-file",
        NodePath.join(home, "port"),
        "--pid-file",
        NodePath.join(home, "pid"),
      ];
      return { home, server, files, port: server.port };
    }),
    ({ home, server }) =>
      Effect.promise(async () => {
        await server.close();
        NodeFS.rmSync(home, { recursive: true, force: true });
      }),
  );

const root = Command.make("goat").pipe(Command.withSubcommands([sshHelperCommand]));
// Runs one helper subcommand in this process and returns what it printed and whether it failed.
const helper = Effect.fn("sshRuntimeFactsCommands.test.helper")(function* (
  args: ReadonlyArray<string>,
) {
  const exitCode = process.exitCode;
  using write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    yield* Command.runWith(root, { version: "test" })(["__ssh-helper", ...args]).pipe(
      Effect.provide(NodeServices.layer),
    );
    return {
      stdout: write.mock.calls.map(([value]) => String(value)).join(""),
      failed: process.exitCode === 1,
    };
  } finally {
    process.exitCode = exitCode;
  }
});

const frameOf = (stdout: string) => {
  const lines = stdout.split("\n");
  expect(lines.at(-1)).toBe("");
  expect(lines[0]).toBe("begin v1 facts");
  const questions = lines.slice(1, -2);
  expect(lines.at(-2)).toBe(`end ${questions.length}`);
  return new Map(questions.map((line) => [line.split(" ")[0], line.slice(line.indexOf(" ") + 1)]));
};

describe("SSH helper facts frame", () => {
  it.effect(
    "answers each question exactly as its separate subcommand does on the same inputs",
    () =>
      Effect.gen(function* () {
        const { files, port } = yield* liveRecord(["start-1"]);
        const frame = frameOf((yield* helper(["facts", ...files])).stdout);
        const manifest = yield* helper(["runtime-manifest", "--shell"]);
        const commit = yield* helper(["commit-time"]);
        const live = yield* helper(["protocol", ...files, "--shell"]);
        const compat = yield* helper(["compat", "--port", String(port)]);
        expect([...frame.keys()]).toEqual(["manifest", "commit", "live", "compat"]);
        expect(frame.get("manifest")).toBe("ok " + manifest.stdout.trim());
        expect(frame.get("commit")).toBe(
          commit.failed ? "fail unavailable" : "ok " + commit.stdout.trim(),
        );
        expect(live.stdout).toBe(
          `live ${packageJson.version} ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} ${process.pid} ${port}\n`,
        );
        expect(frame.get("live")).toBe("ok " + live.stdout.trim());
        expect(compat.stdout).toBe("compatible 1 start-1\n");
        expect(frame.get("compat")).toBe("ok " + compat.stdout.trim());
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { reads: ["start-1", "start-2"], compat: "fail changed" },
    { reads: [undefined], compat: "fail unavailable" },
  ])("refuses compat unless live and compat read one instance id: $compat", ({ reads, compat }) =>
    Effect.gen(function* () {
      const { files } = yield* liveRecord(reads);
      const frame = frameOf((yield* helper(["facts", ...files])).stdout);
      expect(frame.get("live")).toMatch(/^ok live /u);
      expect(frame.get("compat")).toBe(compat);
    }).pipe(Effect.scoped),
  );

  it.effect("asks no compat question when no server runs", () =>
    Effect.gen(function* () {
      const home = NodeOS.tmpdir();
      const frame = frameOf(
        (yield* helper([
          "facts",
          "--runtime-file",
          NodePath.join(home, "goat-facts-absent-record"),
          "--port-file",
          NodePath.join(home, "goat-facts-absent-port"),
          "--pid-file",
          NodePath.join(home, "goat-facts-absent-pid"),
        ])).stdout,
      );
      expect([...frame.keys()]).toEqual(["manifest", "commit", "live"]);
      expect(frame.get("live")).toBe("ok none unknown unknown unknown 0 0");
    }),
  );
});
