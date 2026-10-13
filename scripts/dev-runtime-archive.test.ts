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
import { buildDevRuntimeArchive, resolveRuntimeArchiveHome } from "./dev-runtime-archive.ts";
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
if (args.join(' ') === 'exec node -p process.version') {
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
  if (monitorContents!==(process.env.FAIL_STEP==='legacy-monitor'?'legacy monitor':'new monitor')) throw new Error('wrong monitor selected');
  const entries=['client/index.html','node_modules/node-pty/build/Release/pty.node',
    'resource-monitor/'+platform+'-'+value('--arch')+'/goat-resource-monitor'];
  for (const entry of entries) { const file=path.join(content,entry); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,'fixture'); }
  fs.writeFileSync(path.join(content,'goat'),'#!/bin/sh\nprintf \'goat v'+(process.env.WRONG_EXECUTABLE_VERSION || value('--version'))+'\\n\'\n',{mode:0o755});
  if (process.env.BROKEN_EXECUTABLE) fs.chmodSync(path.join(content, 'goat'), 0o644);
  if (process.env.INVALID_ARCHIVE) fs.unlinkSync(path.join(content, 'client/index.html'));
  cp.execFileSync('tar',['-czf',path.join(output,stem+'.tar.gz'),'-C',path.dirname(content),stem]);
}
`;

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
          assert.equal(records.length, 1);
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
});
