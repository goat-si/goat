import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { checkCodexProviderStatus } from "./CodexProvider.ts";
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

it.live("reports a missing Codex shim as not installed without triggering its install", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-codex-mise-probe-" });
      const executable = path.join(directory, "codex");
      const marker = path.join(directory, "installed");
      yield* fs.writeFileString(
        executable,
        `#!/bin/sh\nif [ "$MISE_OFFLINE" = 1 ]; then echo 'mise ERROR tool not installed; mise Version: 2026.11.5' >&2; exit 1; fi\n: > '${marker}'\necho 'codex-cli 0.164.0'\n`,
        { mode: 0o755 },
      );
      const settings = yield* decodeCodexSettings({
        enabled: true,
        binaryPath: executable,
        homePath: directory,
      });
      const status = yield* checkCodexProviderStatus(settings, undefined, {});
      assert.isFalse(yield* fs.exists(marker));
      assert.isFalse(status.installed);
      assert.isNull(status.version);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.live("regression F10-1: a build-tagged --version answer proves Codex is present", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-codex-build-probe-" });
      const executable = path.join(directory, "codex");
      // The app-server fails, so the status falls back to `codex --version`.
      yield* fs.writeFileString(
        executable,
        `#!/bin/sh\nif [ "$1" = --version ]; then echo 'codex-cli 1.2.3+build.7'; exit 0; fi\nexit 1\n`,
        { mode: 0o755 },
      );
      const settings = yield* decodeCodexSettings({
        enabled: true,
        binaryPath: executable,
        homePath: directory,
      });
      const status = yield* checkCodexProviderStatus(settings, undefined, {});
      assert.strictEqual(status.cli, "present");
      assert.strictEqual(status.version, "1.2.3+build.7");
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
