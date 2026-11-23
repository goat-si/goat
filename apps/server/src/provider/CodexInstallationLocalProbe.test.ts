import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { makeHarness } from "./CodexInstallation.testkit.ts";

it.effect.each([
  { layout: "npm bin symlink", persists: true },
  { layout: "npm shim", persists: true },
  { layout: "wrapper script", persists: false },
])(
  "re-probes a $layout Codex after a restart only when its payload can change",
  ({ layout, persists }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-codex-install-test-" });
      const packageDirectory =
        layout === "npm shim"
          ? `${baseDir}/local/node_modules/@openai/codex`
          : `${baseDir}/npm/lib/node_modules/@openai/codex`;
      const payload =
        layout === "wrapper script" ? `${baseDir}/payload` : `${packageDirectory}/bin/codex.js`;
      const install = Effect.fn("test.installPayload")(function* (version: string) {
        yield* fs.makeDirectory(`${packageDirectory}/bin`, { recursive: true });
        if (layout !== "wrapper script")
          yield* fs.writeFileString(
            `${packageDirectory}/package.json`,
            JSON.stringify({ name: "@openai/codex", version }),
          );
        yield* fs.writeFileString(
          payload,
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${baseDir}/local-probes.txt'\ncase "$1" in --version) printf 'codex-cli ${version}\\n';; esac\n`,
          { mode: 0o755 },
        );
      });
      yield* install("0.156.1");
      yield* fs.makeDirectory(`${baseDir}/local`, { recursive: true });
      if (layout === "npm bin symlink") yield* fs.symlink(payload, `${baseDir}/local/codex`);
      else
        yield* fs.writeFileString(`${baseDir}/local/codex`, `#!/bin/sh\nexec '${payload}' "$@"\n`, {
          mode: 0o755,
        });
      const first = yield* makeHarness({
        baseDir,
        local: { version: "0.156.1" },
        preserveLocal: true,
      });
      expect((yield* first.installation.resolve()).source).toBe("local");
      const restarted = yield* makeHarness({
        baseDir,
        local: { version: "0.156.1" },
        preserveLocal: true,
      });
      expect((yield* restarted.installation.resolve()).source).toBe("local");
      expect((yield* fs.readFileString(first.probeLog)).trim().split("\n")).toHaveLength(
        persists ? 2 : 4,
      );
      yield* install("0.128.9");
      const upgraded = yield* makeHarness({
        baseDir,
        local: { version: "0.156.1" },
        preserveLocal: true,
      });
      expect((yield* upgraded.installation.state).installedVersion).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
