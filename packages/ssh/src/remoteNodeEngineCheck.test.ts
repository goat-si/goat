// The engine check runs in a real shell and Node; the Effect spawner adds nothing here.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";

import { assert, describe, it } from "@effect/vitest";
import { satisfiesSemverRange } from "@goat/shared/semver";
import { build } from "vite-plus";

import { REMOTE_NODE_ENGINE_CHECK_SCRIPT } from "./remoteNodeEngineCheck.ts";
import { remoteShell } from "./tunnel.fixture.ts";
import { buildRemoteNodeEnvScript } from "./tunnel.ts";

const NODE_DIR = NodePath.dirname(process.execPath);
const LOCAL_NODE = process.versions.node;

// Runs the shell function the remote runner uses, with this process's Node first on PATH.
function runEngineCheck(envScript: string) {
  return NodeChildProcess.spawnSync(
    remoteShell,
    ["-c", `${envScript}\nremote_node_satisfies_engine`],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${NODE_DIR}:${process.env.PATH ?? ""}` },
    },
  );
}

function assertChecksRange(envScript: (range: string) => string) {
  const accepted = runEngineCheck(envScript(`>=${LOCAL_NODE}`));
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stderr, "");

  const rejected = runEngineCheck(envScript(">=999"));
  assert.equal(rejected.status, 1);
  assert.equal(
    rejected.stderr,
    `Remote node ${LOCAL_NODE} does not satisfy required range >=999.\n`,
  );
}

describe("remote node engine check", () => {
  // Vitest serves tunnel.ts through Vite's SSR transform, which renames imports to
  // __vite_ssr_import_*__. A stringified function body would carry those names to the remote.
  it("runs on real Node after Vite's SSR transform", () => {
    assertChecksRange((range) => buildRemoteNodeEnvScript({ nodeEngineRange: range }));
  });

  it("runs on real Node after a minified production bundle", async () => {
    const packageDir = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
    // Inside the package so the bundle resolves its external dependencies like the source does.
    const cacheDir = NodePath.join(packageDir, "node_modules", ".cache");
    await NodeFSP.mkdir(cacheDir, { recursive: true });
    const outDir = await NodeFSP.mkdtemp(NodePath.join(cacheDir, "engine-check-bundle-"));
    try {
      await build({
        configFile: false,
        logLevel: "silent",
        root: packageDir,
        build: {
          ssr: NodePath.join(packageDir, "src", "tunnel.ts"),
          outDir,
          emptyOutDir: false,
          minify: true,
          rollupOptions: {
            // Bundle @goat/shared so the minifier can rename satisfiesSemverRange.
            external: (id) => /^(node:|effect|@effect\/)/.test(id),
            output: { entryFileNames: "tunnel.mjs", format: "es" },
          },
        },
      });
      const bundled = (await import(NodePath.join(outDir, "tunnel.mjs"))) as {
        buildRemoteNodeEnvScript: typeof buildRemoteNodeEnvScript;
      };
      assertChecksRange((range) => bundled.buildRemoteNodeEnvScript({ nodeEngineRange: range }));
    } finally {
      await NodeFSP.rm(outDir, { recursive: true, force: true });
    }
  });

  it("decides ranges exactly like the shared semver helper", () => {
    const versions = [
      "0.0.3",
      "0.2.5",
      "1.0.0",
      "18.19.1",
      "20.0.0",
      "22.12.0",
      "v24.1.0",
      "24.1.0-rc.1",
      "bogus",
    ];
    const ranges = [
      "",
      ">=20",
      "^22.12.0 || >=24",
      "^0.2.1",
      "^0.0.3",
      "<20 >=18.19",
      "=1",
      ">1.0.0",
      "<=18",
      "~20",
      "22.x",
    ];
    for (const version of versions) {
      for (const range of ranges) {
        let exitCode = 0;
        NodeVM.runInNewContext(REMOTE_NODE_ENGINE_CHECK_SCRIPT, {
          process: {
            argv: ["node", "-", range],
            versions: { node: version },
            version,
            exit: (code: number) => {
              exitCode = code;
            },
            stderr: { write: () => true },
          },
        });
        assert.equal(exitCode === 0, satisfiesSemverRange(version, range), `${version} ${range}`);
      }
    }
  });
});
