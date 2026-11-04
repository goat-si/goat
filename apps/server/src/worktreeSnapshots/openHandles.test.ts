// @effect-diagnostics nodeBuiltinImport:off -- bounded lsof execution and its real-process fixture use native APIs.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { findOpenHandles } from "./openHandles.ts";

it.effect("parses holders and fails closed on warnings and unsuccessful commands", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => NodeFSP.realpath(NodeOS.tmpdir()));
    const file = NodePath.join(root, "held-file");
    const result = yield* findOpenHandles(root, async () => ({
      stdout: `p123\nn${file}\nn${root}-other/file\n`,
      stderr: "warning",
      exitCode: 0,
    }));
    assert.deepStrictEqual(result, { complete: false, holders: [{ pid: 123, path: file }] });
    const empty = yield* findOpenHandles(root, async () => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    }));
    assert.isTrue(empty.complete);
    const failed = yield* findOpenHandles(root, async () => {
      throw new Error("spawn failed");
    });
    assert.isFalse(failed.complete);
  }),
);

it.effect("reports a real child holding a file open", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-open-handles-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const realDir = yield* Effect.promise(() => NodeFSP.realpath(dir));
    const file = NodePath.join(realDir, "held");
    yield* Effect.promise(() => NodeFSP.writeFile(file, "test"));
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeChildProcess.spawn(
          process.execPath,
          [
            "-e",
            "require('fs').openSync(process.argv[1], 'r'); console.log('ready'); process.stdin.resume()",
            file,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        ),
      ),
      (process) =>
        Effect.sync(() => {
          process.kill();
        }),
    );
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          child.stdout.once("data", () => resolve());
          child.once("error", reject);
          child.once("exit", () => reject(new Error("child exited before opening file")));
        }),
    );
    const result = yield* findOpenHandles(dir);
    assert.isTrue(result.complete);
    assert.isTrue(
      result.holders.some((holder) => holder.pid === child.pid && holder.path === file),
    );
  }).pipe(Effect.scoped),
);
