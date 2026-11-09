/* oxlint-disable goat/no-global-process-runtime -- Packaging must compare the build host with the executable target. */
const { spawn, spawnSync } = require("node:child_process");
const { guardChild } = require("../packages/shared/src/errorGuards.ts");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// afterPack runs before signing and installer creation, against the final ASAR layout.
module.exports = async ({ appOutDir, electronPlatformName, arch, packager }) => {
  if (!["darwin", "win32", "linux"].includes(electronPlatformName)) {
    console.log(`[server-compile-cache] Skipping unsupported target ${electronPlatformName}`);
    return;
  }
  const targetArch = ["ia32", "x64", "armv7l", "arm64", "universal"][arch];
  const runsWithRosetta =
    electronPlatformName === "darwin" &&
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    targetArch === "x64";
  if (
    electronPlatformName !== process.platform ||
    (targetArch !== process.arch && !runsWithRosetta)
  ) {
    console.log(
      `[server-compile-cache] Skipping unexecutable target ${electronPlatformName}/${targetArch}`,
    );
    return;
  }
  // GOAT's Mac Studio release runner has no Rosetta; its x64 builds ship without prepared bytecode.
  if (
    runsWithRosetta &&
    spawnSync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"], { stdio: "ignore" }).status !== 0
  ) {
    console.log("[server-compile-cache] Skipping macOS x64 target: Rosetta is not installed");
    return;
  }
  const product = packager.appInfo.productFilename;
  const resources =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${product}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  const executable =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${product}.app`, "Contents", "MacOS", product)
      : path.join(
          appOutDir,
          electronPlatformName === "win32" ? `${product}.exe` : packager.executableName,
        );
  const helper = path.join(
    resources,
    "app.asar",
    "apps/desktop/dist-electron/serverCompileCache.cjs",
  );
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const name of Object.keys(env)) {
    if (name.startsWith("NODE_") || name.startsWith("GOAT_")) delete env[name];
  }
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "goat-release-cache-"));
  env.GOAT_HOME = state;
  let result;
  try {
    const runner = path.join(state, "prepare-server-compile-cache-runner.cjs");
    fs.writeFileSync(
      runner,
      `require(${JSON.stringify(helper)}).generatePreparedServerCache(${JSON.stringify(resources)}).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})`,
    );
    result = await new Promise((resolve, reject) => {
      const child = guardChild(
        spawn(executable, [runner], { env, stdio: "inherit", timeout: 120000 }),
        reject,
      );
      child.once("close", (status) => resolve(status));
    });
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
  if (result !== 0) throw new Error(`Server compile cache generation failed: exit ${result}`);
  console.log("[server-compile-cache] Prepared server bytecode with packaged Electron");
};
