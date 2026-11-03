// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { makeCli } from "../binCli.ts";

const home = process.env.HOME;
if (!home) throw new Error("Fixture HOME is required");
const cwd = NodePath.join(home, "deleted");
const scenario = process.argv[3] ?? "deleted";
const base = NodePath.join(home, "not-a-directory");
NodeFS.writeFileSync(base, "fixture");
NodeFS.mkdirSync(cwd);
if (scenario.startsWith("relative-"))
  NodeFS.writeFileSync(NodePath.join(cwd, "relative"), "fixture");
process.chdir(cwd);
if (scenario === "deleted") NodeFS.rmdirSync(cwd);
else if (scenario !== "accessible" && process.getuid?.() !== 0) NodeFS.chmodSync(cwd, 0o000);
if (scenario !== "deleted" && scenario !== "accessible") {
  const mutableFs = NodeModule.createRequire(import.meta.url)("node:fs") as typeof NodeFS;
  const access = mutableFs.accessSync;
  mutableFs.accessSync = (path, mode) => {
    if (
      (process.getuid?.() === 0 && String(path) === cwd) ||
      ((scenario === "fallback" || scenario === "both-fail") && String(path) === home) ||
      (scenario === "both-fail" && String(path) === "/")
    ) {
      const error = new Error("fixture access denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return access(path, mode);
  };
  NodeModule.syncBuiltinESMExports();
}
const mode = process.argv[2];
if (!mode) throw new Error("Fixture command is required");
const configEnv: Record<string, string> = {};
let args = mode === "default" ? ["unknown-command"] : [mode, "--base-dir", base, "--port", "43001"];
if (scenario === "relative-cwd") args = ["./relative", "--base-dir", base, "--port", "43001"];
if (scenario === "relative-flag") args = ["start", "--base-dir", "relative", "--port", "43001"];
if (scenario === "relative-env") {
  args = ["start", "--port", "43001"];
  configEnv.GOAT_HOME = "relative";
}
if (scenario === "relative-bootstrap") {
  const bootstrap = NodePath.join(home, "bootstrap.json");
  NodeFS.writeFileSync(
    bootstrap,
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port: 43001,
      goatHome: "relative",
      host: "127.0.0.1",
      desktopBootstrapToken: "fixture",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }) + "\n",
  );
  configEnv.GOAT_BOOTSTRAP_FD = String(NodeFS.openSync(bootstrap, "r"));
  args = ["start", "--port", "43001"];
}
const program = Command.runWith(makeCli(), { version: "0.0.0" })(args).pipe(
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      NetService.layer,
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: configEnv })),
    ),
  ),
  Effect.match({ onFailure: (error) => String(error), onSuccess: () => "unexpected success" }),
);
process.stdout.write(`RESULT ${await Effect.runPromise(program)}\n`);
try {
  process.stdout.write(`CWD ${process.cwd()}\n`);
} catch {
  process.stdout.write("CWD unavailable\n");
}
if (scenario !== "deleted" && scenario !== "accessible" && process.getuid?.() !== 0)
  NodeFS.chmodSync(cwd, 0o700);
