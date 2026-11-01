// @effect-diagnostics-next-line nodeBuiltinImport:off -- independent synthetic filesystem permission oracle.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Config from "./config.ts";

// oxlint-disable-next-line goat/no-global-process-runtime -- actual filesystem semantics, independent of app overrides.
const posixPermissions = NodeOS.platform() !== "win32";

it.effect(
  "prepares private state before children under umask 002 without changing existing state files",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-config-mode-" });
      if (posixPermissions)
        yield* Effect.acquireRelease(
          Effect.sync(() => process.umask(0o002)),
          (previous) => Effect.sync(() => process.umask(previous)),
        );
      const paths = yield* Config.deriveServerPaths(`${root}/new-install`, undefined);
      yield* Config.ensureServerDirectories(paths);
      const stat = NodeFS.lstatSync(paths.stateDir);
      assert.isTrue(stat.isDirectory());
      assert.isFalse(stat.isSymbolicLink());
      if (posixPermissions) assert.equal(stat.mode & 0o777, 0o700);
      const files = [paths.dbPath, paths.settingsPath, paths.keybindingsConfigPath];
      for (const file of files)
        NodeFS.writeFileSync(file, "synthetic existing state", { mode: 0o640 });
      const before = files.map((file) => NodeFS.lstatSync(file));
      if (posixPermissions) NodeFS.chmodSync(paths.stateDir, 0o775);
      yield* Config.ensureServerDirectories(paths);
      if (posixPermissions) assert.equal(NodeFS.lstatSync(paths.stateDir).mode & 0o777, 0o775);
      for (const [index, file] of files.entries()) {
        assert.equal(NodeFS.readFileSync(file, "utf8"), "synthetic existing state");
        const after = NodeFS.lstatSync(file);
        assert.equal(after.mode, before[index]!.mode);
        assert.equal(after.mtimeMs, before[index]!.mtimeMs);
        assert.equal(after.ino, before[index]!.ino);
      }
      // Only the state parent becomes private; existing child creation retains the umask.
      if (posixPermissions) assert.equal(NodeFS.lstatSync(paths.logsDir).mode & 0o777, 0o775);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
