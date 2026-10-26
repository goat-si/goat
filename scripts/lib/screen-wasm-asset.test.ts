// @effect-diagnostics nodeBuiltinImport:off - Archive fixture checks exact copied bytes in a temporary directory.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import {
  copyScreenWasmAsset,
  sourceScreenWasmAsset,
  verifyScreenWasmArchiveMember,
  windowsScreenWasmProblem,
} from "./screen-wasm-asset.ts";

const root = NodeURL.fileURLToPath(new URL("../..", import.meta.url));

it.effect("reports malformed Windows screen WASM as a sidecar validation problem", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-screen-wasm-")),
    );
    try {
      const wasm = NodePath.join(directory, "screen-code/quickjs.wasm");
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(wasm), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(wasm, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])));
      const result = yield* windowsScreenWasmProblem(directory);
      expect(result).toEqual({
        reason: "sidecar-invalid",
        missingFiles: ["screen-code/quickjs.wasm"],
      });
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }),
);

it("stages the pinned screen WASM with the package digest", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-screen-wasm-"));
  try {
    const source = await sourceScreenWasmAsset(root);
    const staged = await copyScreenWasmAsset(
      root,
      NodePath.join(directory, "screen-code/quickjs.wasm"),
    );
    expect(staged.sha256).toBe(source.sha256);
    expect((await NodeFSP.stat(staged.path)).size).toBe(source.size);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("rejects a missing screen WASM archive member and verifies the staged member digest", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-screen-archive-"));
  try {
    const stem = "goat-test";
    const content = NodePath.join(directory, stem);
    await NodeFSP.mkdir(content);
    const archive = NodePath.join(directory, "goat-test.tar.gz");
    const pack = () => {
      const result = NodeChildProcess.spawnSync("tar", ["-czf", archive, "-C", directory, stem]);
      if (result.status !== 0) throw new Error(String(result.stderr));
    };
    pack();
    await expect(
      verifyScreenWasmArchiveMember(archive, "screen-code/quickjs.wasm", root),
    ).rejects.toThrow("exactly one");
    await copyScreenWasmAsset(root, NodePath.join(content, "screen-code/quickjs.wasm"));
    pack();
    const member = await verifyScreenWasmArchiveMember(archive, "screen-code/quickjs.wasm", root);
    expect(member.member).toBe(`${stem}/screen-code/quickjs.wasm`);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
