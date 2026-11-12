import { vi } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.effect("reports a missing probe cwd instead of a missing Claude executable", () =>
  Effect.gen(function* () {
    const cwd = "/goat-test-missing-claude-cwd-497";
    const settings = decodeClaudeSettings({ enabled: true, binaryPath: "claude" });
    const snapshot = yield* checkClaudeProviderStatus(settings, undefined, {}, cwd);
    assert.equal(snapshot.installed, true);
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
    assert.include(snapshot.message ?? "", "working directory");
  }).pipe(Effect.provide(NodeServices.layer)),
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
      notFound + " GOAT has not been able to read the PATH from your login shell",
    );
    const windows = yield* check({ GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1" }, "win32");
    assert.equal(windows.message, notFound);
  }).pipe(Effect.provide(NodeServices.layer)),
);
