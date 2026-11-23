// @effect-diagnostics nodeBuiltinImport:off -- Exercise the CLI with isolated executable fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";
import { expect, vi } from "vite-plus/test";
import { makeCli } from "../binCli.ts";
import { buildTriageLaunchPrompt } from "./triagePrompt.ts";

import packageJson from "../../package.json" with { type: "json" };
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { describeServerProcess } from "./triage.ts";

it.effect("reports the version the running server recorded, not the CLI's", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "goat-triage-" }),
      "server-runtime.json",
    );
    const state = yield* makePersistedServerRuntimeState({
      config: { host: undefined, devUrl: undefined },
      port: 3773,
    });
    yield* persistServerRuntimeState({ path: statePath, state });

    assert.equal(
      yield* describeServerProcess(statePath),
      `running (pid ${String(process.pid)}, http://127.0.0.1:3773, version ${packageJson.version})`,
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const cliPath = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));

async function fixture(commands: ReadonlyArray<string>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-triage-"));
  const bin = NodePath.join(root, "bin");
  const record = NodePath.join(root, "launch.json");
  await NodeFSP.mkdir(bin);
  const script = NodePath.join(root, "agent.cjs");
  await NodeFSP.writeFile(
    script,
    `require("node:fs").writeFileSync(process.env.TRIAGE_TEST_RECORD, JSON.stringify({ command: process.argv[2], args: process.argv.slice(3), cwd: process.cwd() }));`,
  );
  for (const command of commands) {
    const windows = HostProcess.Platform.defaultValue() === "win32";
    const executable = NodePath.join(bin, windows ? `${command}.cmd` : command);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await NodeFSP.writeFile(
      executable,
      windows
        ? `@"${process.execPath}" "${script}" ${command} %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${quote(command)} "$@"\n`,
      { mode: 0o755 },
    );
  }
  return {
    root,
    record,
    run: (args: ReadonlyArray<string>) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [cliPath, "triage", "--base-dir", NodePath.join(root, "home with spaces"), ...args],
          {
            env: {
              ...process.env,
              PATH: bin,
              TRIAGE_TEST_RECORD: record,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => (stdout += String(data)));
        child.stderr.on("data", (data) => (stderr += String(data)));
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      }),
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it.live.each([
  { commands: ["agy", "codex"], agent: "antigravity", command: "agy", model: "test-model" },
  { commands: ["agy"], agent: undefined, command: "agy", model: undefined },
  { commands: ["agy", "codex"], agent: "codex", command: "codex", model: "test-model" },
  { commands: ["agy", "codex", "claude"], agent: "claude", command: "claude", model: undefined },
])(
  "launches $command with the triage prompt (agent=$agent, model=$model)",
  ({ commands, agent, command, model }) =>
    Effect.promise(async () => {
      await using setup = await fixture(commands);
      const result = await setup.run([
        ...(agent === undefined ? [] : ["--agent", agent]),
        ...(model === undefined ? [] : ["--model", model]),
      ]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const launch = JSON.parse(await NodeFSP.readFile(setup.record, "utf8")) as {
        command: string;
        args: string[];
        cwd: string;
      };
      expect(launch.command).toBe(command);
      expect(launch.args.slice(0, -1)).toEqual([
        ...(model === undefined ? [] : ["--model", model]),
        ...(command === "agy" ? ["--prompt-interactive"] : []),
      ]);
      expect(launch.args.at(-1)).toContain(NodePath.join(launch.cwd, "prompt.md"));
      expect(await NodeFSP.readFile(NodePath.join(launch.cwd, "prompt.md"), "utf8")).toContain(
        "context.md",
      );
    }),
);

it.live(
  "requires an explicit choice when Codex and Antigravity are installed without a terminal",
  () =>
    Effect.promise(async () => {
      await using setup = await fixture(["agy", "codex"]);
      const result = await setup.run([]);
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).toContain("--agent antigravity");
      expect(result.stdout + result.stderr).toContain("--agent codex");
      expect(result.stdout + result.stderr).not.toContain("Starting");
      await expect(NodeFSP.stat(setup.record)).rejects.toMatchObject({ code: "ENOENT" });
    }),
);

it.live("reports the missing agy executable when Antigravity is explicitly requested", () =>
  Effect.promise(async () => {
    await using setup = await fixture(["codex"]);
    const result = await setup.run(["--agent", "antigravity"]);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "`agy` is not installed or was not found on PATH.",
    );
    await expect(NodeFSP.stat(setup.record)).rejects.toMatchObject({ code: "ENOENT" });
  }),
);

const FAILING_AGENT_POSIX = `#!/bin/sh
echo "Error: There is not enough space on the disk. (os error 112)" >&2
exit 1
`;
const FAILING_AGENT_WINDOWS = `@echo Error: There is not enough space on the disk. (os error 112) 1>&2
@exit /b 1
`;

it.live("a failed agent launch points at the prompt it could not run", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-triage-cli-" });
    const binDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-triage-bin-" });
    const claudeHome = NodePath.join(baseDir, "claude-home");
    NodeFS.writeFileSync(NodePath.join(binDir, "claude"), FAILING_AGENT_POSIX, { mode: 0o755 });
    NodeFS.writeFileSync(NodePath.join(binDir, "claude.cmd"), FAILING_AGENT_WINDOWS);
    yield* Effect.acquireRelease(
      // PATH holds only the fake agent, so a broken fixture can never fall through to a real codex.
      Effect.sync(() => {
        vi.stubEnv("PATH", binDir);
        vi.stubEnv("CLAUDE_CONFIG_DIR", claudeHome);
      }),
      () => Effect.sync(() => vi.unstubAllEnvs()),
    );
    const previousExitCode = process.exitCode;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.exitCode = previousExitCode;
      }),
    );

    yield* Command.runWith(makeCli(), { version: "0.0.0" })([
      "triage",
      "--agent",
      "claude",
      "--base-dir",
      baseDir,
    ]);
    const output = (yield* TestConsole.logLines).join("\n");

    assert.equal(process.exitCode, 1);
    const promptFilePath = NodeFS.readdirSync(baseDir, { recursive: true, encoding: "utf8" })
      .filter((entry) => NodePath.basename(entry) === "prompt.md")
      .map((entry) => NodePath.join(baseDir, entry))[0];
    assert.isDefined(promptFilePath);
    assert.include(output, promptFilePath);
    assert.include(output, buildTriageLaunchPrompt(promptFilePath));
    assert.include(output, NodePath.join(NodePath.dirname(promptFilePath), "context.md"));
    assert.include(output, `Claude Code keeps its state in ${claudeHome}.`);
    assert.include(output, "set CLAUDE_CONFIG_DIR to a folder on another drive");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer, TestConsole.layer),
    ),
  ),
);
