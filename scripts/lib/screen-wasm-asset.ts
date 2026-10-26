// @effect-diagnostics nodeBuiltinImport:off - Archive staging verifies a Node package export and tar member on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";

const PACKAGE_WASM = "@jitl/quickjs-wasmfile-release-sync/wasm";
const MAX_BYTES = 4 * 1024 * 1024;

export async function sourceScreenWasmAsset(repoRoot: string) {
  const require = NodeModule.createRequire(NodePath.join(repoRoot, "apps/server/package.json"));
  const source = require.resolve(PACKAGE_WASM);
  const manifest = require("@jitl/quickjs-wasmfile-release-sync/package.json") as {
    version: string;
    exports: Record<string, string>;
  };
  if (
    manifest.version !== "0.32.0" ||
    manifest.exports["./wasm"] !== "./dist/emscripten-module.wasm"
  )
    throw new Error("Unexpected screen WASM package export");
  const stats = await NodeFSP.stat(source);
  if (!stats.isFile() || stats.size < 1 || stats.size > MAX_BYTES)
    throw new Error("Invalid screen WASM size");
  const bytes = await NodeFSP.readFile(source);
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  return { source, sha256, size: bytes.byteLength };
}

export async function copyScreenWasmAsset(repoRoot: string, destination: string) {
  const source = await sourceScreenWasmAsset(repoRoot);
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.copyFile(source.source, destination);
  const bytes = await NodeFSP.readFile(destination);
  if (
    bytes.byteLength !== source.size ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== source.sha256
  )
    throw new Error("Staged screen WASM digest mismatch");
  return { path: destination, sha256: source.sha256 };
}

export async function verifyScreenWasmFile(path: string) {
  const stats = await NodeFSP.stat(path);
  if (!stats.isFile() || stats.size < 8 || stats.size > MAX_BYTES)
    throw new Error("Invalid screen WASM file");
  const bytes = await NodeFSP.readFile(path);
  if (!bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])))
    throw new Error("Invalid screen WASM header");
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

export const stageScreenWasmAsset = (input: { repoRoot: string; destination: string }) =>
  Effect.promise(() => copyScreenWasmAsset(input.repoRoot, input.destination));

/** Why a Windows payload's screen WASM is unusable, or undefined when it verifies. */
export const windowsScreenWasmProblem = (resourcesDir: string) =>
  Effect.promise(() =>
    verifyScreenWasmFile(NodePath.join(resourcesDir, "screen-code", "quickjs.wasm")),
  ).pipe(
    Effect.map(() => undefined),
    Effect.orElseSucceed(() => ({
      reason: "sidecar-invalid" as const,
      missingFiles: ["screen-code/quickjs.wasm"],
    })),
  );

export async function verifyScreenWasmArchiveMember(
  archivePath: string,
  memberSuffix = "screen-code/quickjs.wasm",
  repoRoot?: string,
) {
  const list = NodeChildProcess.spawnSync("tar", ["-tf", archivePath], { encoding: "utf8" });
  if (list.status !== 0) throw new Error(`Cannot list screen archive: ${list.stderr}`);
  const members = list.stdout
    .split(/\r?\n/)
    .filter((member) => member.endsWith(`/${memberSuffix}`));
  if (members.length !== 1) throw new Error("Archive must contain exactly one screen WASM");
  const extract = NodeChildProcess.spawnSync("tar", ["-xOf", archivePath, members[0] ?? ""], {
    maxBuffer: MAX_BYTES + 1,
  });
  if (
    extract.status !== 0 ||
    !extract.stdout ||
    extract.stdout.byteLength < 1 ||
    extract.stdout.byteLength > MAX_BYTES
  )
    throw new Error("Invalid archive screen WASM");
  const actual = NodeCrypto.createHash("sha256").update(extract.stdout).digest("hex");
  if (repoRoot) {
    const expected = await sourceScreenWasmAsset(repoRoot);
    if (actual !== expected.sha256) throw new Error("Archive screen WASM digest mismatch");
  }
  return { member: members[0], sha256: actual };
}
