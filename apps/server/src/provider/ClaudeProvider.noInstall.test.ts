import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

it.live("reports a missing Claude mise shim without installing or reporting mise's version", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-claude-mise-" });
      const executable = path.join(directory, "claude");
      const marker = path.join(directory, "installed");
      yield* fs.writeFileString(
        executable,
        `#!/bin/sh\nif [ "$MISE_OFFLINE" = 1 ]; then echo 'mise ERROR tool not installed; mise Version: 2026.11.5' >&2; exit 1; fi\n: > '${marker}'\necho '2.1.0 (Claude Code)'\n`,
        { mode: 0o755 },
      );
      const settings = yield* decodeClaudeSettings({
        enabled: true,
        binaryPath: executable,
      });
      const status = yield* checkClaudeProviderStatus(
        settings,
        () => Effect.die("unexpected capabilities probe"),
        {},
      );
      assert.isFalse(yield* fs.exists(marker));
      assert.isFalse(status.installed);
      assert.equal(status.cli, "missing");
      assert.isNull(status.version);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
