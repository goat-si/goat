import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId, type TextGenerationError } from "@goat/contracts";
import { writeFakeCli } from "@goat/provider-testing/fakeCli";
import { createModelSelection } from "@goat/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Config from "../config.ts";
import * as HomeRoute from "../provider/OpenCodexRoute.ts";
import { fixture } from "../provider/OpenCodexRoute.testkit.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";

const decode = Schema.decodeSync(CodexSettings);
const decodeLaunches = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      config: Schema.Record(Schema.String, Schema.Unknown),
      home: Schema.optional(Schema.String),
    }),
  ),
);
const cases = [
  { opencodexAuth: "openai", version: "0.156.1", validConfig: true, reception: false },
  { opencodexAuth: "none", version: "0.156.1", validConfig: true, reception: false },
  { opencodexAuth: "none", version: "0.999.0", validConfig: true, reception: false },
  { opencodexAuth: "openai", version: "0.156.1", validConfig: false, reception: false },
  { opencodexAuth: "none", version: "0.156.1", validConfig: false, reception: false },
  { opencodexAuth: "none", version: "0.156.1", validConfig: true, reception: true },
] as const;
it.live.each(cases)(
  "runs Home $opencodexAuth text generation only after verifying the effective config (version $version, valid $validConfig, reception $reception)",
  ({ opencodexAuth, version, validConfig, reception }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const route = yield* fixture();
      const home = route.input.execution.home;
      const log = home + "/launches.jsonl";
      const output = reception
        ? {
            replyText: "On it.",
            action: "create_task",
            title: "Fixture task",
            instruction: "Run the fixture",
            projectId: "project-1",
            host: "",
            taskId: "",
            questionId: "",
            answer: "",
            question: "",
            options: [],
            reads: [],
            remember: "",
            rememberQuote: "",
            notesChangeRequested: "",
            additionalTasks: [],
            clarifyAbout: "other",
          }
        : { title: "Home title" };
      // The fake Codex applies GOAT's -c overrides; an invalid case reports another provider.
      const binary = writeFakeCli({
        directory: home + "/bin",
        name: "codex",
        source: [
          'import fs from "node:fs";',
          'import readline from "node:readline";',
          `import { parse } from ${JSON.stringify(import.meta.resolve("smol-toml"))};`,
          "const args = process.argv.slice(2);",
          "const config = {};",
          'args.forEach((arg, index) => { if ((args[index - 1] === "-c" || args[index - 1] === "--config") && /^(model_provider|openai_base_url|model_providers\\.opencodex|model_catalog_json)=/.test(arg)) Object.assign(config, parse(arg)); });',
          'const kind = args.includes("app-server") ? "app-server" : args.includes("mcp") ? "mcp" : args[0];',
          `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind, config, home: process.env.CODEX_HOME }) + "\\n");`,
          'if (kind === "app-server") {',
          '  readline.createInterface({ input: process.stdin }).on("line", (line) => {',
          "    const { id, method } = JSON.parse(line);",
          "    if (id === undefined) return;",
          `    const result = method === "initialize" ? { userAgent: ${JSON.stringify(`codex/${version}`)}, codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" } : { config: ${validConfig ? "config" : '{ ...config, model_provider: "hostile" }'}, origins: {} };`,
          '    process.stdout.write(JSON.stringify({ id, result }) + "\\n");',
          "  });",
          '} else if (kind === "mcp") process.stdout.write("[]");',
          'else if (kind === "exec") {',
          "  for await (const _ of process.stdin) {}",
          `  fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], ${JSON.stringify(JSON.stringify(output))});`,
          "}",
        ].join("\n"),
      });
      const guardedFs = {
        ...fs,
        exists: (filename: string) =>
          filename.endsWith("auth.json")
            ? Effect.die("Authless reception must not inspect local credentials")
            : fs.exists(filename),
      };
      const generation = yield* makeCodexTextGeneration(
        decode({ ...route.input.settings, binaryPath: binary, opencodexAuth }),
        { PATH: process.env.PATH },
      ).pipe(
        Effect.provideService(HomeRoute.OpenCodexRoute, route.service),
        Effect.provideService(FileSystem.FileSystem, reception ? guardedFs : fs),
      );
      const modelSelection = createModelSelection(ProviderInstanceId.make("codex"), "home-model");
      const generateReception = generation.generateChannelReception;
      if (generateReception === undefined) throw new Error("Codex reception unavailable");
      const request: Effect.Effect<unknown, TextGenerationError> = reception
        ? generateReception({
            cwd: route.input.execution.cwd,
            modelSelection,
            input: {
              mode: "input",
              conversationId: "fixture-conversation" as never,
              originKind: "slack",
              inputText: "Run the fixture",
              tail: [],
              tasks: [],
              allowedTargets: [{ projectId: "project-1" as never, label: "Fixture" }],
              requester: {
                ownerId: "owner",
                principalId: "owner",
                displayName: "Fixture",
                originKind: "slack",
                runtimeModeCeiling: "full-access",
                grantedScopes: ["orchestration:operate"],
              },
            },
          })
        : generation.generateThreadTitle({
            cwd: route.input.execution.cwd,
            message: "Name the work",
            modelSelection,
          });
      const result = yield* Effect.result(request);
      const launches = (yield* fs.exists(log))
        ? decodeLaunches(
            (yield* fs.readFileString(log))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          )
        : [];
      const execs = launches.filter((launch) => launch.kind === "exec");
      if (!validConfig) {
        assert.equal(result._tag, "Failure");
        assert.deepStrictEqual(execs, []);
        return;
      }
      assert.equal(result._tag, "Success", result._tag === "Failure" ? result.failure.message : "");
      assert.equal(execs.length, 1);
      const exec = execs[0]!;
      assert.equal(exec.config.model_provider, opencodexAuth === "none" ? "opencodex" : "openai");
      if (opencodexAuth === "none")
        assert.deepStrictEqual(exec.config.model_providers, {
          opencodex: {
            name: "OpenCodex",
            base_url: route.input.settings.opencodexBaseUrl,
            wire_api: "responses",
            requires_openai_auth: false,
          },
        });
      else assert.equal(exec.config.openai_base_url, route.input.settings.opencodexBaseUrl);
      assert.equal(exec.config.model_catalog_json, route.catalog);
      if (reception) assert.notEqual(exec.home, home);
    }).pipe(
      Effect.provide(
        Config.layerTest(process.cwd(), { prefix: "codex-home-generation-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
