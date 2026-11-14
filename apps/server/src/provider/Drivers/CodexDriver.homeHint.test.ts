// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { writeFakeCli } from "@goat/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CodexInstallation from "../CodexInstallation.ts";
import { CodexDriver } from "./CodexDriver.ts";
import { layerTest } from "./CodexDriver.testkit.ts";

it.live("a signed-out home the host names is the one the sign-in hint shows", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "codex-home-hint-" }),
    );
    const home = path.join(root, "account");
    yield* fs.makeDirectory(home);
    // A Codex app-server whose home has no sign-in.
    const bin = path.join(root, "bin");
    writeFakeCli({
      directory: bin,
      name: "codex",
      source: [
        'import readline from "node:readline";',
        'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
        "  const { id, method } = JSON.parse(line);",
        "  if (id === undefined) return;",
        "  const result =",
        '    method === "initialize" ? { userAgent: "codex/0.156.1", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" }',
        '    : method === "config/read" ? { config: {}, origins: {} }',
        '    : method === "account/read" ? { account: null, requiresOpenaiAuth: true }',
        '    : method === "model/list" ? { data: [], nextCursor: null }',
        '    : method === "skills/list" ? { data: [] } : undefined;',
        '  process.stdout.write(JSON.stringify(result === undefined ? { id, error: { code: -32601, message: "unsupported" } } : { id, result }) + "\\n");',
        "});",
      ].join("\n"),
    });
    const instance = yield* CodexDriver.create({
      instanceId: ProviderInstanceId.make("codex-home-hint"),
      displayName: "Hint",
      enabled: true,
      environment: [],
      config: CodexDriver.defaultConfig(),
    }).pipe(
      Effect.provide(
        Layer.mock(CodexInstallation.CodexInstallation)({
          managedDirectory: "unused",
          compatibility: () => Effect.sync(() => undefined),
        }),
      ),
      Effect.provideService(HostProcess.Environment, {
        PATH: [bin, ...(process.env.PATH ?? "").split(NodePath.delimiter)].join(NodePath.delimiter),
        HOME: root,
        CODEX_HOME: home,
      }),
      Effect.provideService(HostProcess.HomeDirectory, root),
    );
    const snapshot = yield* instance.snapshot.refresh;
    assert.equal(snapshot.auth.status, "unauthenticated", snapshot.message);
    assert.include(snapshot.message ?? "", `CODEX_HOME set to ${JSON.stringify(home)}`);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
