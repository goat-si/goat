import { LEGACY_RESOURCE_MONITOR_BINARY_NAME } from "@goat/contracts/legacyT3Names";
// @effect-diagnostics nodeBuiltinImport:off - This test executes isolated build-tool stand-ins and inspects the published tar.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { cliArchiveFileName, cliArchivePlatformKey } from "@goat/shared/cliRelease";
import {
  buildDevRuntimeArchive,
  parseDevRuntimeArchiveArgs,
  pinSelectedNodeOnPath,
  resolveDevRuntimeArchiveTarget,
  resolveRuntimeArchiveHome,
} from "./dev-runtime-archive.ts";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import { vi } from "vite-plus/test";
import * as HostProcess from "@goat/shared/HostProcess";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const standIn = String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
fs.appendFileSync(process.env.TOOL_LOG, JSON.stringify({tool,args,node:process.env.VP_NODE_VERSION})+'\n');
if (args.join(' ') === 'env which node') {
  console.log(process.env.WHICH_NODE || ''); process.exit(0);
}
if (args.join(' ') === 'exec node -p process.version' || args.join(' ') === 'env exec node -p process.version') {
  console.log(process.env.PROBE_VERSION || 'v'+process.env.VP_NODE_VERSION); process.exit(0);
}
if (process.env.FAIL_STEP && (tool === process.env.FAIL_STEP || args.includes(process.env.FAIL_STEP))) process.exit(43);
if (tool === 'cargo') {
  const dir=path.join(process.cwd(),'native/resource-monitor/target/release');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir, process.env.LEGACY_MONITOR_NAME), 'legacy monitor');
  if (process.env.FAIL_STEP !== 'legacy-monitor') fs.writeFileSync(path.join(dir,'goat-resource-monitor'),'new monitor');
}
if (args.includes('scripts/build-cli-archive.ts')) {
  const value = flag => args[args.indexOf(flag)+1];
  const platform=value('--platform')==='mac'?'darwin':value('--platform');
  const stem='goat-'+value('--version')+'-'+platform+'-'+value('--arch');
  const output=value('--output-dir'); const content=path.join(output,'fixture',stem);
  const stagedMonitor=path.join(value('--resource-monitor-dir'),platform+'-'+value('--arch'));
  const monitorEntries=fs.readdirSync(stagedMonitor);
  if (JSON.stringify(monitorEntries)!==JSON.stringify(['goat-resource-monitor'])) throw new Error('unexpected monitor filenames');
  const monitorContents=fs.readFileSync(path.join(stagedMonitor,'goat-resource-monitor'),'utf8');
  const expectedMonitor=process.env.EXPECTED_MONITOR_CONTENTS||(process.env.FAIL_STEP==='legacy-monitor'?'legacy monitor':'new monitor');
  if (monitorContents!==expectedMonitor) throw new Error('wrong monitor selected: '+monitorContents);
  const entries=['client/index.html','node_modules/node-pty/build/Release/pty.node'];
  for (const entry of entries) { const file=path.join(content,entry); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,'fixture'); }
  const monitorDest=path.join(content,'resource-monitor',platform+'-'+value('--arch'),'goat-resource-monitor');
  fs.mkdirSync(path.dirname(monitorDest),{recursive:true});
  fs.writeFileSync(monitorDest,monitorContents,{mode:0o755});
  fs.writeFileSync(path.join(content,'goat'),'#!/bin/sh\nprintf \'goat v'+(process.env.WRONG_EXECUTABLE_VERSION || value('--version'))+'\\n\'\n',{mode:0o755});
  if (process.env.BROKEN_EXECUTABLE) fs.chmodSync(path.join(content, 'goat'), 0o644);
  if (process.env.INVALID_ARCHIVE) fs.unlinkSync(path.join(content, 'client/index.html'));
  cp.execFileSync('tar',['-czf',path.join(output,stem+'.tar.gz'),'-C',path.dirname(content),stem]);
}
`;

describe("selected Node pinning", () => {
  it("pins PATH from vp env which node and probes that binary", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", VP_NODE_VERSION: "26.8.2" };
    const calls: Array<string> = [];
    const pinned = await pinSelectedNodeOnPath(env, async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "/opt/node-26/bin/node\n" };
    });
    assert.equal(env.PATH, "/opt/node-26/bin" + NodePath.delimiter + "/usr/bin");
    assert.deepEqual(pinned, {
      command: "/opt/node-26/bin/node",
      args: ["-p", "process.version"],
    });
    assert.deepEqual(calls, ["vp env which node"]);
  });

  it("probes with vp env exec when which node is empty or fails", async () => {
    const empty: NodeJS.ProcessEnv = { PATH: "/tools:/usr/bin" };
    const emptyPath = empty.PATH;
    const fromEmpty = await pinSelectedNodeOnPath(empty, async () => ({ stdout: "\n" }));
    assert.equal(empty.PATH, emptyPath);
    assert.deepEqual(fromEmpty, {
      command: "vp",
      args: ["env", "exec", "node", "-p", "process.version"],
    });
    const failed: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const fromFailure = await pinSelectedNodeOnPath(failed, async () => {
      throw new Error("missing");
    });
    assert.equal(failed.PATH, "/usr/bin");
    assert.equal(fromFailure.command, "vp");
  });
});

describe("development runtime archive publication", () => {
  it("generated build tools parse as JavaScript", () => {
    assert.doesNotThrow(() => new Function(standIn.replace(/^#![^\n]*\n/, "")));
  });
  it.live.each([
    "success",
    "legacy-monitor",
    "build",
    "build-exe",
    "cargo",
    "scripts/build-cli-archive.ts",
    "old-node",
    "malformed-selector",
    "old-selector",
    "probe-disagreement",
    "env-selector",
    "current-node",
    "invalid-archive",
    "wrong-executable-version",
    "broken-executable",
    "rename-failure",
    "publication-locked",
  ] as const)("%s preserves cache or publishes a verified executable tree", (mode) =>
    Effect.tryPromise(async () => {
      const platform = HostProcess.Platform.defaultValue();
      if (platform === "win32") return;
      const key = cliArchivePlatformKey(platform, HostProcess.Architecture.defaultValue());
      if (key === undefined) return;
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-dev-archive-"));
      try {
        const fakeRepo = NodePath.join(root, "repo");
        const tools = NodePath.join(root, "tools");
        const home = NodePath.join(root, "home with spaces");
        await NodeFSP.mkdir(fakeRepo, { recursive: true });
        await NodeFSP.mkdir(tools, { recursive: true });
        for (const name of ["vp", "cargo"])
          await NodeFSP.writeFile(NodePath.join(tools, name), standIn, { mode: 0o755 });
        const archives = NodePath.join(home, "runtime", "archives");
        await NodeFSP.mkdir(archives, { recursive: true });
        const name = cliArchiveFileName(serverPackageJson.version, key);
        const old = Buffer.from("previous archive bytes");
        await NodeFSP.writeFile(NodePath.join(archives, name), old);
        const oldSidecar = "previous checksum";
        await NodeFSP.writeFile(NodePath.join(archives, name + ".sha256"), oldSidecar);
        const lock = NodePath.join(archives, `.goat-dev-${serverPackageJson.version}-${key}.lock`);
        if (mode === "publication-locked") await NodeFSP.mkdir(lock);
        const rename = NodeFSP.rename;
        const renameSpy =
          mode === "rename-failure"
            ? vi.spyOn(NodeFSP, "rename").mockImplementation(async (from, to) => {
                if (String(to) === NodePath.join(archives, name))
                  throw new Error("fixture archive rename failure");
                return rename(from, to);
              })
            : undefined;
        const success =
          mode === "success" ||
          mode === "legacy-monitor" ||
          mode === "env-selector" ||
          mode === "current-node";
        const selected = "26.8.2";
        let failure: unknown;
        const versionDescriptor = Object.getOwnPropertyDescriptor(process, "version");
        if (mode === "current-node")
          Object.defineProperty(process, "version", { value: "v26.8.2", configurable: true });
        try {
          await buildDevRuntimeArchive({
            homeDir: home,
            repoRoot: fakeRepo,
            ...(mode === "env-selector" || mode === "current-node"
              ? {}
              : {
                  nodeVersion:
                    mode === "malformed-selector"
                      ? "26.x"
                      : mode === "old-selector"
                        ? "24.13.1"
                        : selected,
                }),
            env: {
              ...process.env,
              HOME: home,
              PATH: tools + NodePath.delimiter + (process.env.PATH ?? ""),
              TOOL_LOG: NodePath.join(root, "tools.jsonl"),
              VP_NODE_VERSION: mode === "current-node" ? "" : selected,
              FAIL_STEP: mode,
              LEGACY_MONITOR_NAME: LEGACY_RESOURCE_MONITOR_BINARY_NAME,
              INVALID_ARCHIVE: mode === "invalid-archive" ? "1" : "",
              WRONG_EXECUTABLE_VERSION: mode === "wrong-executable-version" ? "9.9.9" : "",
              BROKEN_EXECUTABLE: mode === "broken-executable" ? "1" : "",
              PROBE_VERSION:
                mode === "old-node"
                  ? "v24.13.1"
                  : mode === "probe-disagreement"
                    ? "v26.9.0"
                    : `v${selected}`,
            },
          });
        } catch (cause) {
          failure = cause;
        } finally {
          renameSpy?.mockRestore();
          if (mode === "current-node" && versionDescriptor)
            Object.defineProperty(process, "version", versionDescriptor);
        }
        if (!success) {
          assert.isDefined(failure);
          if (mode === "wrong-executable-version") {
            assert.include(String(failure), "goat v9.9.9");
            assert.include(String(failure), "expected goat v" + serverPackageJson.version);
          }
          assert.deepEqual(await NodeFSP.readFile(NodePath.join(archives, name)), old);
          assert.equal(
            await NodeFSP.readFile(NodePath.join(archives, name + ".sha256"), "utf8"),
            oldSidecar,
          );
        } else {
          assert.isUndefined(failure);
          const bytes = await NodeFSP.readFile(NodePath.join(archives, name));
          const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
          assert.equal(
            await NodeFSP.readFile(NodePath.join(archives, name + ".sha256"), "utf8"),
            hash + "  " + name + "\n",
          );
          const extracted = NodePath.join(root, "extracted");
          await NodeFSP.mkdir(extracted);
          NodeChildProcess.execFileSync("tar", [
            "-xzf",
            NodePath.join(archives, name),
            "-C",
            extracted,
          ]);
          const binary = NodePath.join(extracted, name.slice(0, -7), "goat");
          assert.equal(
            NodeChildProcess.execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
            "goat v" + serverPackageJson.version,
          );
        }
        if (mode === "publication-locked") {
          assert.include(String(failure), "Another dev runtime publication");
          assert.deepEqual(await NodeFSP.readdir(lock), []);
          await NodeFSP.rmdir(lock);
        }
        const logPath = NodePath.join(root, "tools.jsonl");
        const records = (await NodeFSP.readFile(logPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { args: string[]; node: string });
        if (mode === "malformed-selector" || mode === "old-selector") assert.deepEqual(records, []);
        else if (mode === "old-node" || mode === "probe-disagreement")
          assert.equal(records.length, 2);
        if (success) assert.isTrue(records.every((record) => record.node === selected));
        assert.deepEqual(
          (await NodeFSP.readdir(archives)).filter((entry) => entry.startsWith(".goat-dev-")),
          [],
        );
        assert.equal((await NodeFSP.readdir(home)).includes("userdata"), false);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }),
  );
  it.effect("worktree home outranks ambient home; explicit home outranks both", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(root + "/.git", "gitdir: /example/.git/worktrees/fixture\n");
      assert.equal(
        yield* resolveRuntimeArchiveHome({ cwd: root, ambientHome: "/ambient" }),
        root + "/.goat",
      );
      assert.equal(
        yield* resolveRuntimeArchiveHome({
          cwd: root,
          homeDir: root + "/explicit",
          ambientHome: "/ambient",
        }),
        root + "/explicit",
      );
      yield* fs.remove(root + "/.git");
      assert.equal(
        yield* resolveRuntimeArchiveHome({ cwd: root, ambientHome: root + "/ambient" }),
        root + "/ambient",
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("parses CLI flags and resolves host and cross targets", () => {
    assert.deepEqual(
      parseDevRuntimeArchiveArgs([
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--resource-monitor-from",
        "/tmp/goat-0.1.0-linux-x64.tar.gz",
        "--home-dir",
        "/tmp/home",
        "--node-version",
        "26.8.2",
        "--version",
        "0.1.0-dev.1",
      ]),
      {
        platform: "linux",
        arch: "x64",
        resourceMonitorFrom: "/tmp/goat-0.1.0-linux-x64.tar.gz",
        homeDir: "/tmp/home",
        nodeVersion: "26.8.2",
        version: "0.1.0-dev.1",
      },
    );

    assert.deepEqual(
      resolveDevRuntimeArchiveTarget({
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
      {
        platform: "darwin",
        arch: "arm64",
        key: "darwin-arm64",
        cliPlatform: "mac",
        exeTarget: "host",
        isHostTarget: true,
        hostPlatform: "darwin",
        hostArch: "arm64",
        monitorName: "goat-resource-monitor",
        legacyMonitorName: LEGACY_RESOURCE_MONITOR_BINARY_NAME,
      },
    );
    assert.deepEqual(
      resolveDevRuntimeArchiveTarget({
        platform: "linux",
        arch: "x64",
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
      {
        platform: "linux",
        arch: "x64",
        key: "linux-x64",
        cliPlatform: "linux",
        exeTarget: "linux-x64",
        isHostTarget: false,
        hostPlatform: "darwin",
        hostArch: "arm64",
        monitorName: "goat-resource-monitor",
        legacyMonitorName: LEGACY_RESOURCE_MONITOR_BINARY_NAME,
      },
    );
    assert.deepEqual(
      resolveDevRuntimeArchiveTarget({
        platform: "win",
        arch: "x64",
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
      {
        platform: "win32",
        arch: "x64",
        key: "win32-x64",
        cliPlatform: "win",
        exeTarget: "win-x64",
        isHostTarget: false,
        hostPlatform: "darwin",
        hostArch: "arm64",
        monitorName: "goat-resource-monitor.exe",
        legacyMonitorName: LEGACY_RESOURCE_MONITOR_BINARY_NAME + ".exe",
      },
    );
    assert.throws(
      () =>
        resolveDevRuntimeArchiveTarget({
          platform: "darwin",
          arch: "x64",
          hostPlatform: "darwin",
          hostArch: "arm64",
        }),
      /No supported CLI archive for darwin-x64/,
    );
  });

  it.live.each([
    "from-archive",
    "from-legacy-archive",
    "from-binary",
    "from-existing-cache-archive",
    "missing-monitor-source",
    "wrong-target-archive",
  ] as const)("cross-target linux-x64 %s reuses resource monitor or fails clearly", (mode) =>
    Effect.tryPromise(async () => {
      if (HostProcess.Platform.defaultValue() === "win32") return;
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-dev-cross-"));
      try {
        const fakeRepo = NodePath.join(root, "repo");
        const tools = NodePath.join(root, "tools");
        const home = NodePath.join(root, "home");
        await NodeFSP.mkdir(fakeRepo, { recursive: true });
        await NodeFSP.mkdir(tools, { recursive: true });
        for (const name of ["vp", "cargo"])
          await NodeFSP.writeFile(NodePath.join(tools, name), standIn, { mode: 0o755 });
        const archives = NodePath.join(home, "runtime", "archives");
        await NodeFSP.mkdir(archives, { recursive: true });
        const targetKey = "linux-x64" as const;
        const name = cliArchiveFileName(serverPackageJson.version, targetKey);
        const old = Buffer.from("previous linux archive bytes");
        await NodeFSP.writeFile(NodePath.join(archives, name), old);
        const oldSidecar = "previous linux checksum";
        await NodeFSP.writeFile(NodePath.join(archives, name + ".sha256"), oldSidecar);

        const expectedMonitor = "reused linux-x64 monitor (" + mode + ")";
        let resourceMonitorFrom: string | undefined;

        const makeMonitorArchive = async (
          archiveFilePath: string,
          archiveKey: string,
          binaryFileName: string,
        ) => {
          const srcRoot = await NodeFSP.mkdtemp(NodePath.join(root, "src-archive-"));
          const stem = "goat-0.0.1-" + archiveKey;
          const monitorFile = NodePath.join(
            srcRoot,
            stem,
            "resource-monitor",
            archiveKey,
            binaryFileName,
          );
          await NodeFSP.mkdir(NodePath.dirname(monitorFile), { recursive: true });
          await NodeFSP.writeFile(monitorFile, expectedMonitor, { mode: 0o755 });
          NodeChildProcess.execFileSync("tar", ["-czf", archiveFilePath, "-C", srcRoot, stem]);
        };

        if (
          mode === "from-archive" ||
          mode === "from-legacy-archive" ||
          mode === "wrong-target-archive"
        ) {
          resourceMonitorFrom = NodePath.join(root, "donor.tar.gz");
          await makeMonitorArchive(
            resourceMonitorFrom,
            mode === "wrong-target-archive" ? "darwin-arm64" : targetKey,
            mode === "from-legacy-archive"
              ? LEGACY_RESOURCE_MONITOR_BINARY_NAME
              : "goat-resource-monitor",
          );
        } else if (mode === "from-binary") {
          resourceMonitorFrom = NodePath.join(root, "goat-resource-monitor-linux-x64");
          await NodeFSP.writeFile(resourceMonitorFrom, expectedMonitor, { mode: 0o755 });
        } else if (mode === "from-existing-cache-archive") {
          await makeMonitorArchive(
            NodePath.join(archives, "goat-0.0.0-" + targetKey + ".tar.gz"),
            targetKey,
            "goat-resource-monitor",
          );
        }

        const selected = "26.8.2";
        const success =
          mode === "from-archive" ||
          mode === "from-legacy-archive" ||
          mode === "from-binary" ||
          mode === "from-existing-cache-archive";
        let failure: unknown;
        try {
          await buildDevRuntimeArchive({
            homeDir: home,
            repoRoot: fakeRepo,
            platform: "linux",
            arch: "x64",
            hostPlatform: "darwin",
            hostArch: "arm64",
            resourceMonitorFrom,
            nodeVersion: selected,
            env: {
              ...process.env,
              HOME: home,
              PATH: tools + NodePath.delimiter + (process.env.PATH ?? ""),
              TOOL_LOG: NodePath.join(root, "tools.jsonl"),
              VP_NODE_VERSION: selected,
              PROBE_VERSION: "v" + selected,
              LEGACY_MONITOR_NAME: LEGACY_RESOURCE_MONITOR_BINARY_NAME,
              EXPECTED_MONITOR_CONTENTS: expectedMonitor,
            },
          });
        } catch (cause) {
          failure = cause;
        }

        const logPath = NodePath.join(root, "tools.jsonl");
        const records = (await NodeFSP.readFile(logPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { tool: string; args: string[]; node: string });

        if (!success) {
          assert.isDefined(failure);
          assert.include(String(failure), "--resource-monitor-from");
          assert.include(String(failure), targetKey);
          assert.deepEqual(await NodeFSP.readFile(NodePath.join(archives, name)), old);
          assert.equal(
            await NodeFSP.readFile(NodePath.join(archives, name + ".sha256"), "utf8"),
            oldSidecar,
          );
          assert.equal(
            records.some((record) => record.tool === "cargo" || record.args.includes("build-exe")),
            false,
          );
        } else {
          assert.isUndefined(failure);
          assert.equal(
            records.some((record) => record.tool === "cargo"),
            false,
          );
          assert.equal(
            records.some(
              (record) =>
                record.args.includes("build-exe") &&
                record.args[record.args.indexOf("--target") + 1] === "linux-x64",
            ),
            true,
          );
          const extracted = NodePath.join(root, "extracted");
          await NodeFSP.mkdir(extracted);
          NodeChildProcess.execFileSync("tar", [
            "-xzf",
            NodePath.join(archives, name),
            "-C",
            extracted,
          ]);
          const monitorInArchive = NodePath.join(
            extracted,
            name.slice(0, -7),
            "resource-monitor",
            targetKey,
            "goat-resource-monitor",
          );
          assert.equal(await NodeFSP.readFile(monitorInArchive, "utf8"), expectedMonitor);
        }
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }),
  );
});
