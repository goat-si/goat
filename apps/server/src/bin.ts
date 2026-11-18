// @effect-diagnostics nodeBuiltinImport:off -- The launcher starts before the CLI runtime.
import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";
import { adoptLegacyEnv } from "@goat/contracts/legacyT3Names";
import { isEntrypoint } from "./entrypoint.ts";

async function loadCliMain(): Promise<typeof import("./binMain.ts")> {
  if (!NodeSea.isSea()) return import("./binMain.ts");
  const require = NodeModule.createRequire(import.meta.url);
  const cliUrl = NodeURL.pathToFileURL(require.resolve(process.execPath)).href;
  const hook = NodeModule.registerHooks({
    load(url, context, next) {
      if (url !== cliUrl) return next(url, context);
      return {
        format: "module",
        source: new Uint8Array(NodeSea.getRawAsset("binMain.mjs")),
        shortCircuit: true,
      };
    },
  });
  try {
    return require(process.execPath) as typeof import("./binMain.ts");
  } finally {
    hook.deregister();
  }
}

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  adoptLegacyEnv(process.env);
  if (process.argv[2] === "__service-launcher" && process.argv.length === 3) {
    const { installServerOutputHandlers } = await import("./cli/serverOutput.ts");
    installServerOutputHandlers();
    const { runServiceLauncherCli } = await import("./cli/serviceLauncher.ts");
    await runServiceLauncherCli();
  } else {
    const { runCliCommand } = await loadCliMain();
    await runCliCommand();
  }
}
