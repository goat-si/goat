// @effect-diagnostics nodeBuiltinImport:off - Archive fixture checks exact copied bytes in a temporary directory.
import { expect, it } from "@effect/vitest";
import * as NodeFsp from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";
import * as NodeChild from "node:child_process";
import { copyScreenWasmAsset, sourceScreenWasmAsset, verifyScreenWasmArchiveMember } from "./screen-wasm-asset.ts";

const root = NodeUrl.fileURLToPath(new URL("../..", import.meta.url));

it("stages the pinned screen WASM with the package digest", async () => {
  const directory = await NodeFsp.mkdtemp(NodePath.join(NodeOs.tmpdir(), "goat-screen-wasm-"));
  try {
    const source = await sourceScreenWasmAsset(root);
    const staged = await copyScreenWasmAsset(root, NodePath.join(directory, "screen-code/quickjs.wasm"));
    expect(staged.sha256).toBe(source.sha256);
    expect((await NodeFsp.stat(staged.path)).size).toBe(source.size);
  } finally {
    await NodeFsp.rm(directory, { recursive: true, force: true });
  }
});

it("rejects a missing screen WASM archive member and verifies the staged member digest", async () => {
  const directory = await NodeFsp.mkdtemp(NodePath.join(NodeOs.tmpdir(), "goat-screen-archive-"));
  try {
    const stem = "goat-test";
    const content = NodePath.join(directory, stem);
    await NodeFsp.mkdir(content);
    const archive = NodePath.join(directory, "goat-test.tar.gz");
    const pack = () => {
      const result = NodeChild.spawnSync("tar", ["-czf", archive, "-C", directory, stem]);
      if (result.status !== 0) throw new Error(String(result.stderr));
    };
    pack();
    await expect(verifyScreenWasmArchiveMember(archive, "screen-code/quickjs.wasm", root))
      .rejects.toThrow("exactly one");
    await copyScreenWasmAsset(root, NodePath.join(content, "screen-code/quickjs.wasm"));
    pack();
    const member = await verifyScreenWasmArchiveMember(archive, "screen-code/quickjs.wasm", root);
    expect(member.member).toBe(`${stem}/screen-code/quickjs.wasm`);
  } finally {
    await NodeFsp.rm(directory, { recursive: true, force: true });
  }
});
