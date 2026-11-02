// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
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
NodeFS.mkdirSync(cwd);
process.chdir(cwd);
NodeFS.rmdirSync(cwd);
const base = NodePath.join(home, "not-a-directory");
NodeFS.writeFileSync(base, "fixture");
const mode = process.argv[2];
if (!mode) throw new Error("Fixture command is required");
const args =
  mode === "default" ? ["unknown-command"] : [mode, "--base-dir", base, "--port", "43001"];
const program = Command.runWith(makeCli(), { version: "0.0.0" })(args).pipe(
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      NetService.layer,
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
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
