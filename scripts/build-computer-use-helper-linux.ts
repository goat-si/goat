#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- A local build script: files, hashes and tar, nothing long-lived.
// Builds "goat-computer-use" for Linux, the helper GOAT spawns for computer use (WS10 #1138):
// a bundled Node program, the pinned Cua Driver payload it runs as its child, a launcher and a
// manifest of every file's hash. Local builds only; CI signing and release are a proposal.
//
//   node scripts/build-computer-use-helper-linux.ts [--out <dir>] [--arch x64|arm64] [--driver-archive <file>]
//
// The launcher runs the bundle with GOAT_COMPUTER_USE_NODE, else node on PATH. Electron's
// binary works as that Node only with ELECTRON_RUN_AS_NODE=1, which its launcher sets.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { parseArgs } from "node:util";

import { COMPUTER_USE_PROTOCOL_VERSION } from "@goat/contracts";
import { cuaDriverRelease } from "@goat/shared/cuaDriverRelease";
import { build } from "vite-plus/pack";

import serverPackage from "../apps/server/package.json" with { type: "json" };

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    out: {
      type: "string",
      default: NodePath.join(repoRoot, "apps/server/.computer-use-helper-linux"),
    },
    arch: { type: "string", default: process.arch },
    "driver-archive": { type: "string" },
  },
});
const out = NodePath.resolve(values.out);
const release = cuaDriverRelease("linux", values.arch);
if (!release) throw new Error("Cua Driver has no Linux build for " + values.arch + ".");

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

async function driverArchive(): Promise<Uint8Array> {
  if (values["driver-archive"]) return NodeFS.readFile(values["driver-archive"]);
  const response = await fetch(release.url);
  if (!response.ok)
    throw new Error("Downloading " + release.url + " failed: " + response.status + ".");
  return new Uint8Array(await response.arrayBuffer());
}

await NodeFS.rm(out, { recursive: true, force: true });
await NodeFS.mkdir(NodePath.join(out, "cua-driver"), { recursive: true });

const archive = await driverArchive();
if (archive.byteLength !== release.bytes || sha256(archive) !== release.sha256)
  throw new Error(release.archiveName + " does not match the pinned size and sha256.");
const archivePath = NodePath.join(out, release.archiveName);
await NodeFS.writeFile(archivePath, archive);
NodeChildProcess.execFileSync("tar", ["-xzf", archivePath, "-C", NodePath.join(out, "cua-driver")]);
await NodeFS.rm(archivePath);
for (const file of release.requiredFiles)
  await NodeFS.access(NodePath.join(out, "cua-driver", file));

await build({
  config: false,
  entry: {
    "goat-computer-use": NodePath.join(repoRoot, "apps/server/src/cua/linuxHelper/main.ts"),
  },
  outDir: out,
  format: "esm",
  platform: "node",
  target: "node22",
  clean: false,
  dts: false,
  sourcemap: false,
  logLevel: "warn",
  // One self-contained file: the helper must not resolve packages from wherever it is installed.
  deps: { alwaysBundle: () => true, onlyBundle: false },
  outExtensions: () => ({ js: ".mjs" }),
});

const launcher = NodePath.join(out, "goat-computer-use");
await NodeFS.writeFile(
  launcher,
  [
    "#!/bin/sh",
    "# GOAT Computer Use for Linux. Runs the bundled helper with GOAT's Node, else node on PATH.",
    'here=$(cd "$(dirname "$0")" && pwd -P)',
    'GOAT_COMPUTER_USE_EXECUTABLE="$here/goat-computer-use" exec "${GOAT_COMPUTER_USE_NODE:-node}" "$here/goat-computer-use.mjs" "$@"',
    "",
  ].join("\n"),
  { mode: 0o755 },
);

const files: Record<string, string> = {};
const walk = async (directory: string) => {
  for (const entry of await NodeFS.readdir(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else files[NodePath.relative(out, path)] = sha256(await NodeFS.readFile(path));
  }
};
await walk(out);
await NodeFS.writeFile(
  NodePath.join(out, "manifest.json"),
  JSON.stringify(
    {
      name: "goat-computer-use",
      platform: "linux",
      arch: values.arch,
      helperVersion: serverPackage.version,
      protocol: COMPUTER_USE_PROTOCOL_VERSION,
      driver: {
        name: "Cua Driver",
        license: "MIT",
        version: release.version,
        archive: release.archiveName,
        sha256: release.sha256,
        source: release.url,
      },
      files: Object.fromEntries(Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b))),
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write("Built " + launcher + " with Cua Driver " + release.version + ".\n");
