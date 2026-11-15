import { processProbeSource } from "../testUtils/processProbe.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@goat/shared/model";
import { CodexSettings, ProviderInstanceId, ProviderSetupError } from "@goat/contracts";
import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { writeFakeCli } from "@goat/provider-testing/fakeCli";

export const decodeCodexSettings = Schema.decodeSync(CodexSettings);
export const isSetupError = Schema.is(ProviderSetupError);

export const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

export const layerCodexTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

export interface FakeCodexInput {
  lifecycle?: { port: number; command: "exec" | "mcp list" };
  isolated?: boolean;
  output: string;
  exitCode?: number;
  stderr?: string;
  requireImage?: boolean;
  requireServiceTier?: string;
  requireReasoningEffort?: string;
  forbidReasoningEffort?: boolean;
  requireArg?: string;
  forbidArg?: string;
  stdinMustContain?: string;
  stdinMustNotContain?: string;
  /** Fail if `CODEX_HOME` holds an AGENTS.md, then rotate its auth.json as a token refresh would. */
  refreshAuth?: "in-place" | "replace";
  mcpServers?: ReadonlyArray<{ name: string; enabled: boolean }> | number;
  requireMcpServersOff?: ReadonlyArray<string>;
  /** Copies the `--output-schema` file here so a test can check what the CLI received. */
  schemaCopyPath?: string;
}

export function makeFakeCodexBinary(dir: string, input: FakeCodexInput) {
  const check = JSON.stringify({
    isolated: input.isolated ?? false,
    requireImage: input.requireImage ?? false,
    requireServiceTier: input.requireServiceTier ?? null,
    requireReasoningEffort: input.requireReasoningEffort ?? null,
    forbidReasoningEffort: input.forbidReasoningEffort ?? false,
    requireArg: input.requireArg ?? null,
    forbidArg: input.forbidArg ?? null,
    stdinMustContain: input.stdinMustContain ?? null,
    stdinMustNotContain: input.stdinMustNotContain ?? null,
    refreshAuth: input.refreshAuth ?? null,
    mcpServers: input.mcpServers ?? [],
    requireMcpServersOff: input.requireMcpServersOff ?? [],
    schemaCopyPath: input.schemaCopyPath ?? null,
    stderr: input.stderr ?? null,
    output: input.output,
    exitCode: input.exitCode ?? 0,
  });
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return writeFakeCli({
      directory: path.join(dir, "bin"),
      name: "codex",
      source: [
        'import * as NodeFS from "node:fs";',
        `const check = ${check};`,
        "const args = process.argv.slice(2);",
        ...(input.lifecycle === undefined
          ? []
          : [
              `if ((args.includes("mcp") && args.includes("list")) === ${input.lifecycle.command === "mcp list"}) {`,
              'process.on("SIGTERM", () => {});',
              processProbeSource(input.lifecycle.port),
              "await new Promise(() => {});",
              "}",
            ]),
        "if (check.isolated) {",
        "  const home = process.env.CODEX_HOME;",
        '  if (!home || home.includes(".codex")) process.exit(31);',
        "  if (NodeFS.readdirSync(process.cwd()).length !== 0) process.exit(32);",
        '  if (NodeFS.readdirSync(home).some((name) => name !== "auth.json")) process.exit(33);',
        "}",

        'if (args.includes("mcp") && args.includes("list")) {',
        '  if (typeof check.mcpServers === "number") process.exit(check.mcpServers);',
        "  process.stdout.write(JSON.stringify(check.mcpServers));",
        "  process.exit(0);",
        "}",
        'const originalArgs = ` ${args.join(" ")} `;',
        "let outputPath = null;",
        "let schemaPath = null;",
        "let seenImage = false;",
        'let seenServiceTier = "";',
        'let seenReasoningEffort = "";',
        "for (let index = 0; index < args.length; index += 1) {",
        '  if (args[index] === "--image") {',
        "    index += 1;",
        "    if (args[index]) seenImage = true;",
        '  } else if (args[index] === "--config") {',
        "    index += 1;",
        '    const value = args[index] ?? "";',
        '    if (value.startsWith("service_tier=")) seenServiceTier = value;',
        '    if (value.startsWith("model_reasoning_effort=")) seenReasoningEffort = value;',
        '  } else if (args[index] === "--output-last-message") {',
        "    index += 1;",
        "    outputPath = args[index] ?? null;",
        '  } else if (args[index] === "--output-schema") {',
        "    index += 1;",
        "    schemaPath = args[index] ?? null;",
        "  }",
        "}",
        "const chunks = [];",
        "for await (const chunk of process.stdin) chunks.push(chunk);",
        'const stdinContent = Buffer.concat(chunks).toString("utf8");',
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "// Like Codex: a later mcp_servers={...} override replaces servers earlier -c flags defined.",
        "const servers = new Map();",
        "const offServers = new Set();",
        "for (let index = 0; index < args.length; index += 1) {",
        '  if (args[index] !== "-c" && args[index] !== "--config") continue;',
        '  const value = args[index + 1] ?? "";',
        '  if (value.startsWith("mcp_servers={")) {',
        '    const named = [...value.matchAll(/"([^"]+)"=\\{enabled=false\\}/g)].map((match) => match[1]);',
        "    for (const name of named) offServers.add(name);",
        "    for (const name of [...servers.keys()]) {",
        "      if (named.includes(name)) servers.set(name, false);",
        "      else servers.delete(name);",
        "    }",
        '  } else if (value.startsWith("mcp_servers.")) {',
        '    const [name, key] = value.slice("mcp_servers.".length).split(/[.=]/);',
        "    if (value === `mcp_servers.${name}.enabled=false`) offServers.add(name);",
        "    // An enabled flag alone toggles a server another layer (config.toml) defines.",
        '    if (key === "enabled" && !servers.has(name)) continue;',
        '    servers.set(name, servers.get(name) === true || key === "url" || key === "command");',
        "  }",
        "}",
        "for (const [name, hasTransport] of servers) {",
        '  if (!hasTransport) fail("Error loading config.toml: invalid transport in `mcp_servers." + name + "`", 12);',
        "}",
        "for (const name of check.requireMcpServersOff) {",
        '  if (!offServers.has(name)) fail("MCP server left on: " + name, 13);',
        "}",
        // Codex CLI 0.163.0 forwards the schema to the API, which rejects a non-object root.
        "if (schemaPath !== null) {",
        '  const schema = JSON.parse(NodeFS.readFileSync(schemaPath, "utf8"));',
        "  if (check.schemaCopyPath !== null) NodeFS.copyFileSync(schemaPath, check.schemaCopyPath);",
        '  if (schema.type !== "object")',
        "    fail(",
        "      `Invalid schema for response_format 'codex_output_schema': schema must be a JSON Schema of 'type: \"object\"', got 'type: \"${schema.type ?? \"None\"}\"'.`,",
        "      1,",
        "    );",
        "}",
        "if (check.requireArg !== null && !originalArgs.includes(` ${check.requireArg} `)) {",
        '  fail("missing arg: " + check.requireArg, 8);',
        "}",
        "if (check.forbidArg !== null && originalArgs.includes(` ${check.forbidArg} `)) {",
        '  fail("forbidden arg: " + check.forbidArg, 9);',
        "}",
        'if (check.requireImage && !seenImage) fail("missing --image input", 2);',
        "if (",
        "  check.requireServiceTier !== null &&",
        '  seenServiceTier !== `service_tier="${check.requireServiceTier}"`',
        ") {",
        '  fail("unexpected service tier config: " + seenServiceTier, 5);',
        "}",
        "if (",
        "  check.requireReasoningEffort !== null &&",
        '  seenReasoningEffort !== `model_reasoning_effort="${check.requireReasoningEffort}"`',
        ") {",
        '  fail("unexpected reasoning effort config: " + seenReasoningEffort, 6);',
        "}",
        "if (check.forbidReasoningEffort && seenReasoningEffort.length > 0) {",
        '  fail("reasoning effort config should be omitted: " + seenReasoningEffort, 7);',
        "}",
        "if (check.stdinMustContain !== null && !stdinContent.includes(check.stdinMustContain)) {",
        '  fail("stdin missing expected content", 3);',
        "}",
        "if (check.stdinMustNotContain !== null && stdinContent.includes(check.stdinMustNotContain)) {",
        '  fail("stdin contained forbidden content", 4);',
        "}",
        "if (check.refreshAuth !== null) {",
        "  const home = process.env.CODEX_HOME;",
        '  if (NodeFS.existsSync(home + "/AGENTS.md")) fail("user AGENTS.md is visible", 10);',
        '  const auth = NodeFS.readFileSync(home + "/auth.json", "utf8");',
        '  const rotated = auth.replace("refresh-1", "refresh-2");',
        '  if (check.refreshAuth === "in-place") NodeFS.writeFileSync(home + "/auth.json", rotated);',
        "  else {",
        '    NodeFS.writeFileSync(home + "/auth.json.tmp", rotated);',
        '    NodeFS.renameSync(home + "/auth.json.tmp", home + "/auth.json");',
        "  }",
        "}",
        'if (check.stderr !== null) process.stderr.write(check.stderr + "\\n");',
        'if (outputPath !== null) NodeFS.writeFileSync(outputPath, check.output + "\\n");',
        "process.exitCode = check.exitCode;",
        "",
      ].join("\n"),
    });
  });
}

export function withFakeCodexEnv<A, E, R>(
  input: FakeCodexInput & {
    launchArgs?: string;
    environment?: NodeJS.ProcessEnv;
    models?: ReadonlyArray<string>;
    defaultModel?: string;
    customModels?: ReadonlyArray<string>;
    managedRuntime?: boolean | ProviderSetupError;
    memoryRunnerContext?: import("@goat/provider-core/server/memoryGenerationRunner").MemoryGenerationRunnerContext;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const config = decodeCodexSettings({
      binaryPath: codexPath,
      launchArgs: input.launchArgs,
      customModels: input.customModels,
    });
    const textGeneration = yield* makeCodexTextGeneration(
      config,
      input.memoryRunnerContext
        ? { ...process.env, CODEX_HOME: tempDir, ...input.environment }
        : input.environment === undefined
          ? undefined
          : { ...process.env, ...input.environment },
      Effect.succeed(
        (input.models ?? []).map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          ...(slug === input.defaultModel ? { isDefault: true } : {}),
          capabilities: null,
        })),
      ),
      isSetupError(input.managedRuntime)
        ? Effect.fail(input.managedRuntime)
        : input.managedRuntime
          ? Effect.succeed({
              config,
              environment: input.environment ?? process.env,
              revision: "test",
            })
          : undefined,
      input.memoryRunnerContext,
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}
