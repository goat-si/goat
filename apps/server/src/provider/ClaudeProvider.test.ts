import { vi } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@goat/contracts";
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
