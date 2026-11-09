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
    expect(result).toEqual({ status: 0, stdout: "caps v1 facts wait-ready-report\n", stderr: "" });
  });
});

const startDescriptor = async (instanceIds: ReadonlyArray<string | undefined>) => {
  let requests = 0;
  const server = NodeHttp.createServer((request, response) => {
    // The root answers as a ready server's does, for wait-ready.
    if (request.url === "/") {
      response.end("ok");
      return;
    }
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
      exitCode: process.exitCode ?? 0,
    };
  } finally {
    process.exitCode = exitCode;
  }
});

const frameOf = (stdout: string, call = "facts") => {
  const lines = stdout.split("\n");
  expect(lines.at(-1)).toBe("");
  expect(lines[0]).toBe(`begin v1 ${call}`);
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

  // Clients before --with-caps accept only answer tags between the begin and end lines.
  it.effect("without --with-caps the frame is byte for byte the one earlier clients parse", () =>
    Effect.gen(function* () {
      const { files, port } = yield* liveRecord(["start-1"]);
      const plain = (yield* helper(["facts", ...files])).stdout;
      const manifest = (yield* helper(["runtime-manifest", "--shell"])).stdout.trim();
      const commit = yield* helper(["commit-time"]);
      const live = (yield* helper(["protocol", ...files, "--shell"])).stdout.trim();
      const compat = (yield* helper(["compat", "--port", String(port)])).stdout.trim();
      const answers = [
        "manifest ok " + manifest,
        commit.failed ? "commit fail unavailable" : "commit ok " + commit.stdout.trim(),
        "live ok " + live,
        "compat ok " + compat,
      ];
      expect(plain).toBe(["begin v1 facts", ...answers, "end 4"].join("\n") + "\n");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "--with-caps adds the capabilities line after begin and leaves it out of the count",
    () =>
      Effect.gen(function* () {
        const { files } = yield* liveRecord(["start-1"]);
        const plain = (yield* helper(["facts", ...files])).stdout;
        const caps = (yield* helper(["capabilities"])).stdout;
        const withCaps = (yield* helper(["facts", "--with-caps", ...files])).stdout;
        // Without the flag the frame is what earlier clients parse: answer tags only.
        expect(plain).not.toContain("caps v1");
        const [begin, ...rest] = plain.split("\n");
        expect(withCaps).toBe([begin, caps.trimEnd(), ...rest].join("\n"));
        expect(withCaps.split("\n")[1]).toBe(caps.trimEnd());
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
const helperMainModule = JSON.stringify(new URL("./helperMain.ts", import.meta.url).href);
const absentFiles = (name: string) => {
  const home = NodeOS.tmpdir();
  return [
    "--runtime-file",
    NodePath.join(home, `goat-${name}-absent-record`),
    "--port-file",
    NodePath.join(home, `goat-${name}-absent-port`),
    "--pid-file",
    NodePath.join(home, `goat-${name}-absent-pid`),
  ];
};

// Contract: a launch asks its own build's freshly pinned runner these three questions in one start
// and records the answers as if it had run the separate commands, so they must not drift.
describe("SSH helper launch facts", () => {
  it.effect(
    "facts --version --own --live answer byte for byte as --version, protocol --shell and protocol --runtime-file --shell",
    () =>
      Effect.gen(function* () {
        const version = yield* Effect.promise(() =>
          runModule(
            `const {runVersionMain} = await import(${helperMainModule}); runVersionMain();`,
          ),
        );
        expect(version.status).toBe(0);
        expect(version.stdout).toBe(`goat v${packageJson.version}\n`);
        const own = yield* helper(["protocol", "--shell"]);
        const { files } = yield* liveRecord(["start-1"]);
        for (const input of [files, absentFiles("launch-facts")]) {
          const frame = frameOf(
            (yield* helper(["facts", "--version", "--own", "--live", ...input])).stdout,
          );
          const live = yield* helper(["protocol", ...input, "--shell"]);
          expect(frame.get("version")).toBe("ok " + version.stdout.trimEnd());
          expect(frame.get("own")).toBe("ok " + own.stdout.trimEnd());
          expect(frame.get("live")).toBe("ok " + live.stdout.trimEnd());
        }
      }).pipe(Effect.scoped),
  );

  it.effect("holds only the asked answers, in order, after the capabilities line", () =>
    Effect.gen(function* () {
      const caps = (yield* helper(["capabilities"])).stdout.trimEnd();
      const absent = absentFiles("launch-facts-order");
      const ownLive = (yield* helper(["facts", "--with-caps", "--own", "--live", ...absent]))
        .stdout;
      const own = (yield* helper(["protocol", "--shell"])).stdout.trimEnd();
      expect(ownLive).toBe(
        [
          "begin v1 facts",
          caps,
          "own ok " + own,
          "live ok none unknown unknown unknown 0 0",
          "end 2",
        ].join("\n") + "\n",
      );
      const versionOnly = frameOf((yield* helper(["facts", "--version", ...absent])).stdout);
      expect([...versionOnly.keys()]).toEqual(["version"]);
    }),
  );
});

describe("SSH helper wait-ready report", () => {
  it.effect("a ready server's report answers live and compat as the separate subcommands do", () =>
    Effect.gen(function* () {
      const { files, port } = yield* liveRecord(["start-1"]);
      const report = yield* helper([
        "wait-ready",
        String(port),
        "2000",
        "1000",
        "--report",
        ...files,
      ]);
      const live = yield* helper(["protocol", ...files, "--shell"]);
      const compat = yield* helper(["compat", "--port", String(port)]);
      expect(report.exitCode).toBe(0);
      const frame = frameOf(report.stdout, "wait-ready");
      expect([...frame.keys()]).toEqual(["ready", "live", "compat"]);
      expect(frame.get("ready")).toBe(`ok ${port}`);
      expect(frame.get("live")).toBe("ok " + live.stdout.trim());
      expect(frame.get("compat")).toBe("ok " + compat.stdout.trim());
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { reads: ["start-1", "start-2"], compat: "fail changed" },
    { reads: [undefined], compat: "fail unavailable" },
  ])("refuses compat unless live and compat read one instance id: $compat", ({ reads, compat }) =>
    Effect.gen(function* () {
      const { files, port } = yield* liveRecord(reads);
      const report = yield* helper([
        "wait-ready",
        String(port),
        "2000",
        "1000",
        "--report",
        ...files,
      ]);
      const frame = frameOf(report.stdout, "wait-ready");
      expect(frame.get("live")).toMatch(/^ok live /u);
      expect(frame.get("compat")).toBe(compat);
    }).pipe(Effect.scoped),
  );

  it.effect("a server that is not ready by the deadline is reported, with nothing else asked", () =>
    Effect.gen(function* () {
      const { files, port, server } = yield* liveRecord(["start-1"]);
      // A zero timeout ends the wait before its first request.
      const report = yield* helper(["wait-ready", String(port), "0", "1000", "--report", ...files]);
      expect(report.exitCode).toBe(0);
      const frame = frameOf(report.stdout, "wait-ready");
      expect([...frame.entries()]).toEqual([
        ["ready", "fail timeout"],
        ["live", "fail unavailable"],
      ]);
      expect(server.requests()).toBe(0);
      const plain = yield* helper(["wait-ready", String(port), "0", "1000"]);
      expect(plain).toEqual({ stdout: "", failed: true, exitCode: 1 });
    }).pipe(Effect.scoped),
  );

  it.effect("a report without its three files prints nothing and fails", () =>
    Effect.gen(function* () {
      const report = yield* helper(["wait-ready", "1", "0", "1000", "--report"]);
      expect(report.stdout).toBe("");
      expect(report.exitCode).toBe(2);
    }),
  );
});
