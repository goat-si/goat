// @effect-diagnostics nodeBuiltinImport:off - The child must verify the exact staged WASM file with Node APIs.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";
import type { ScreenRunError } from "@goat/contracts";
import type { SelfInvocation } from "@goat/shared/nodeRuntime";

const require = NodeModule.createRequire(import.meta.url);
const PACKAGE_WASM = "@jitl/quickjs-wasmfile-release-sync/wasm";
const MAX_WASM_BYTES = 4 * 1024 * 1024;

const screenAssetError = (): ScreenRunError => ({
  code: "runtime_unavailable",
  effectStarted: false,
  nextStep: "Install or repair the screen runtime asset.",
});

export async function checkedScreenWasm(path: string, expected?: string) {
  if (!NodePath.isAbsolute(path) || /^\\\\|^\/\//.test(path))
    throw new Error("WASM path is not local and absolute");
  const stat = await NodeFSP.stat(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_WASM_BYTES)
    throw new Error("Invalid WASM size");
  const bytes = await NodeFSP.readFile(path);
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (expected !== undefined && sha256 !== expected) throw new Error("WASM digest mismatch");
  return { path, sha256, bytes };
}

export function screenRuntimeLayout(invocation: SelfInvocation): "dev" | "desktop" | "cli" {
  if (invocation.entrypoint === undefined) return "cli";
  // Desktop's packaged backend entry lives in app.asar (mac/Linux) or server.asar (Windows).
  return /(?:^|[/\\])(?:app|server)\.asar(?:[/\\]|$)/.test(invocation.entrypoint)
    ? "desktop"
    : "dev";
}

export function screenWasmPath(
  layout: "dev" | "desktop" | "cli",
  options: { executable?: string; resourcesPath?: string; devPath?: string } = {},
) {
  if (layout === "dev") return options.devPath ?? require.resolve(PACKAGE_WASM);
  if (layout === "desktop") {
    const root = options.resourcesPath ?? process.resourcesPath;
    if (!root || !NodePath.isAbsolute(root)) throw new Error("Missing desktop resources path");
    return NodePath.join(root, "screen-code", "quickjs.wasm");
  }
  return NodePath.join(
    NodePath.dirname(options.executable ?? process.execPath),
    "screen-code",
    "quickjs.wasm",
  );
}

export const resolveScreenRuntimeAsset = (
  layout: "dev" | "desktop" | "cli",
  options?: Parameters<typeof screenWasmPath>[1],
) =>
  Effect.tryPromise({
    try: async () => {
      const path = screenWasmPath(layout, options);
      const { sha256 } = await checkedScreenWasm(path);
      return { path, sha256 };
    },
    catch: screenAssetError,
  });
