import { vi } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import { makeApplyDesktopShellEnvironmentSnapshot } from "../resourceTelemetry/DesktopShellEnvironmentReceiver.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.effect("reports a missing probe cwd instead of a missing Claude executable", () =>
  Effect.gen(function* () {
    const cwd = "/goat-test-missing-claude-cwd-497";
    const settings = decodeClaudeSettings({ enabled: true, binaryPath: "claude" });
    const snapshot = yield* checkClaudeProviderStatus(settings, undefined, {}, cwd);
    assert.equal(snapshot.installed, true);
    assert.isUndefined(snapshot.cli);
    assert.include(snapshot.message ?? "", cwd);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a deleted process cwd as a working directory failure", () =>
  Effect.gen(function* () {
    using _cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("deleted"), { code: "ENOENT" });
    });
    const spawner = ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          cause: { code: "ENOENT" },
        }),
      ),
    );
    const snapshot = yield* checkClaudeProviderStatus(
      decodeClaudeSettings({ enabled: true, binaryPath: "claude" }),
      undefined,
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    assert.equal(snapshot.installed, true);
    assert.isUndefined(snapshot.cli);
    assert.include(snapshot.message ?? "", "working directory");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a Claude CLI that answers --version is present even when sign-in is unknown", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-claude-present-" });
      const executable = path.join(directory, "claude");
      yield* fs.writeFileString(executable, "#!/bin/sh\necho '2.1.0 (Claude Code)'\n", {
        mode: 0o755,
      });
      const snapshot = yield* checkClaudeProviderStatus(
        decodeClaudeSettings({ enabled: true, binaryPath: executable }),
        undefined,
        {},
      );
      assert.equal(snapshot.cli, "present");
      assert.equal(snapshot.cliCheckedAt, snapshot.checkedAt);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("says the login shell PATH is unread when claude is missing during discovery", () =>
  Effect.gen(function* () {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          cause: { code: "ENOENT" },
        }),
      ),
    );
    const check = (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = "darwin") =>
      checkClaudeProviderStatus(
        decodeClaudeSettings({ enabled: true, binaryPath: "claude" }),
        undefined,
        { PATH: "/goat-test-no-such-folder", ...environment },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcess.Platform, platform),
      );
    const notFound = "Claude Agent CLI (`claude`) was not found on PATH.";
    const read = yield* check({});
    assert.equal(read.installed, false);
    assert.equal(read.message, notFound);
    const unread = yield* check({ GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1" });
    assert.equal(unread.installed, false);
    assert.include(
      unread.message ?? "",
      notFound + " GOAT may not have your login shell's current PATH yet",
    );
    const windows = yield* check({ GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1" }, "win32");
    assert.equal(windows.message, notFound);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps the sentence, in conditional words, while a cached login-shell PATH is in use",
  () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            cause: { code: "ENOENT" },
          }),
        ),
      );
      const environment: NodeJS.ProcessEnv = {
        PATH: "/usr/bin:/bin",
        GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
      };
      const applySnapshot = makeApplyDesktopShellEnvironmentSnapshot(environment, "darwin");
      const snapshot = (discovered: boolean) =>
        ({
          version: 1,
          type: "shellEnvironment",
          platform: "darwin",
          discovered,
          environment: { PATH: "/goat-test-cached-shell/bin:/usr/bin:/bin" },
        }) as const;
      const check = Effect.suspend(() =>
        checkClaudeProviderStatus(
          decodeClaudeSettings({ enabled: true, binaryPath: "claude" }),
          undefined,
          environment,
        ),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      const notFound = "Claude Agent CLI (`claude`) was not found on PATH.";

      // At start the desktop sends last session's login-shell PATH from its cache, not yet confirmed.
      yield* applySnapshot(snapshot(false));
      assert.equal(environment.PATH, "/goat-test-cached-shell/bin:/usr/bin:/bin");
      assert.equal(
        (yield* check).message,
        notFound +
          " GOAT may not have your login shell's current PATH yet, so it may have searched only the folders it already knew and the standard install folders. If the CLI is installed somewhere else, set its full path as that provider's Binary path under Settings → Providers.",
      );

      yield* applySnapshot(snapshot(true));
      assert.equal((yield* check).message, notFound);
    }).pipe(Effect.provide(NodeServices.layer)),
);
