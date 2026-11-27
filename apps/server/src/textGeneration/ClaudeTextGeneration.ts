import { CLAUDE_SETTINGS_TEMP_PREFIX } from "../storage/storagePaths.ts";
import { makeClaudePrivateSettingsSweep } from "./ClaudePrivateSettings.ts";
import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import type { RouteClaudeModelCatalog } from "../provider/ClaudeCodeModelRoutes.ts";
import { collectStreamAsString } from "@goat/provider-core/server/snapshotProbe";
import { ProviderDriverKind } from "@goat/contracts";
import {
  MemoryGenerationRunnerError,
  memoryRunnerCapabilities,
  withMemoryExecution,
  type MemoryGenerationRunnerContext,
  type MemoryOperationName,
} from "@goat/provider-core/server/memoryGenerationRunner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@goat/shared/HostProcess";
import { verifyClaudeMemoryHooks } from "./ClaudeMemoryIsolation.ts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type ClaudeSettings, TextGenerationError } from "@goat/contracts";
import { resolveSpawnCommand } from "@goat/shared/shell";
import { deepMerge } from "@goat/shared/Struct";

import * as TextGenerationOperations from "@goat/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toStrictJsonSchemaObject,
} from "@goat/provider-core/server/textGenerationUtils";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@goat/shared/model";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  getClaudeCatalogModelCapabilities,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import {
  hasClaudeManagedMcpConfig,
  makeClaudeEnvironment,
} from "../provider/Drivers/ClaudeHome.ts";
import { readClaudeUserSettings } from "../provider/Drivers/ClaudeSkills.ts";
import { claudeHomeFlagSettings } from "../provider/ClaudeHomeSettings.ts";

import { readClaudeLaunchArgSettings } from "../orchestration-v2/Adapters/ClaudeLaunchArgs.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

const CLAUDE_TIMEOUT_MS = 180_000;
/** `--tools` takes bare names; patterns go in the allow list. */
const CLAUDE_INVESTIGATION_TOOLS = "Read,Grep,Glob,Bash";
/** In dontAsk mode every call outside this list, Bash included, is refused; investigationSettings keeps settings from adding to it. */
const CLAUDE_INVESTIGATION_ALLOWED = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
].join(",");
// Denies override allows; block git --output/-o because allowed trailing args can otherwise write anywhere.
const CLAUDE_INVESTIGATION_DENIED = ["Bash(git * --output*)", "Bash(git * -o *)"].join(",");

/**
 * Settings for an investigation, which runs with `--setting-sources ""`: the user's settings file
 * and the launch argument's settings as Claude Code would merge them, keeping from `permissions`
 * only the deny rules. Allow rules, extra directories and a default mode would approve calls
 * beyond the investigation's own list.
 */
function investigationSettings(
  userSettings: Record<string, unknown> | undefined,
  launchArgSettings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const { permissions: _, ...settings } = deepMerge(userSettings ?? {}, launchArgSettings ?? {});
  const deny = [userSettings, launchArgSettings].flatMap((source) => {
    const permissions = source?.permissions;
    return Predicate.isObject(permissions) && Array.isArray(permissions.deny)
      ? permissions.deny
      : [];
  });
  return deny.length > 0 ? { ...settings, permissions: { deny: [...new Set(deny)] } } : settings;
}

const claudeOutputDiagnostics = {
  permission_denials: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  subtype: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  message: Schema.optionalKey(
    Schema.Struct({
      content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    }),
  ),
};
const NO_SESSION_PERSISTENCE = "--no-session-persistence";
// Claude Code before 2.0.63 exits with this on stderr; those runs retry without the flag.
const NO_SESSION_PERSISTENCE_REJECTED = `error: unknown option '${NO_SESSION_PERSISTENCE}'`;

const ClaudeOutputEnvelope = Schema.Struct({
  ...claudeOutputDiagnostics,
  type: Schema.optionalKey(Schema.String),
  structured_output: Schema.Unknown,
});
const ClaudeOutputMessage = Schema.Struct({
  ...claudeOutputDiagnostics,
  type: Schema.String,
  structured_output: Schema.optionalKey(Schema.Unknown),
});

const hasClaudeToolAttempt = (
  messages: ReadonlyArray<typeof ClaudeOutputMessage.Type | typeof ClaudeOutputEnvelope.Type>,
) => {
  const structuredCalls = new Set<string>();
  for (const message of messages) {
    if (
      (message.permission_denials?.length ?? 0) > 0 ||
      message.type === "tool_use" ||
      message.type === "tool_result" ||
      message.type === "permission_request" ||
      message.subtype === "permission_denied" ||
      message.subtype === "permission_denial"
    )
      return true;
    for (const block of [...(message.content ?? []), ...(message.message?.content ?? [])]) {
      if (block === null || typeof block !== "object" || !("type" in block)) continue;
      if (block.type === "tool_use") {
        // Claude delivers --json-schema results through this built-in, non-executable tool.
        if (
          message.type !== "assistant" ||
          !("name" in block) ||
          block.name !== "StructuredOutput" ||
          !("id" in block) ||
          typeof block.id !== "string" ||
          block.id.length === 0 ||
          structuredCalls.has(block.id)
        )
          return true;
        structuredCalls.add(block.id);
      } else if (block.type === "tool_result") {
        if (
          message.type !== "user" ||
          !("tool_use_id" in block) ||
          typeof block.tool_use_id !== "string" ||
          ("is_error" in block && block.is_error !== false) ||
          !structuredCalls.delete(block.tool_use_id)
        )
          return true;
      }
    }
  }
  return structuredCalls.size > 0;
};
const isClaudeOutputEnvelope = Schema.is(ClaudeOutputEnvelope);

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeOutput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([ClaudeOutputEnvelope, Schema.Array(ClaudeOutputMessage)])),
);

// Only `success` results carry `result`; error subtypes such as
// error_max_structured_output_retries report through `errors` instead.
const ClaudeErrorResult = Schema.Struct({
  is_error: Schema.Literal(true),
  result: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
});
const isClaudeErrorResult = Schema.is(ClaudeErrorResult);
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

// Claude reports JSON errors on stdout; stderr may contain only wrapper notices.
function claudeErrorResult(stdout: string): string | undefined {
  const output = Option.getOrUndefined(decodeJsonOption(stdout));
  const messages: ReadonlyArray<unknown> = Array.isArray(output) ? output : [output];
  return messages
    .filter(isClaudeErrorResult)
    .map((message) =>
      (
        message.result ??
        // error_during_execution mixes CLI telemetry into the list.
        message.errors?.filter((error) => !error.startsWith("[ede_diagnostic]")).join("\n") ??
        ""
      ).trim(),
    )
    .findLast((result) => result.length > 0);
}

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  /** An Effect is read at each generation, so a later host PATH reaches it. */
  environment?: NodeJS.ProcessEnv | Effect.Effect<NodeJS.ProcessEnv>,
  modelCatalog: Effect.Effect<ClaudeModelCatalog> = Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
  memoryRunnerContext?: MemoryGenerationRunnerContext,
  routeModelCatalog: RouteClaudeModelCatalog = Effect.succeed,
) {
  const textOnlyModels = new Set<string>();
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const sweepSettings = yield* makeClaudePrivateSettingsSweep(path, yield* HostProcess.UserId);
  const runnerScope = yield* Effect.scope;
  let sweepRunning = false;
  const scheduleSettingsSweep = Effect.fn("ClaudeTextGeneration.scheduleSettingsSweep")(function* (
    root: string,
  ) {
    if (sweepRunning) return;
    sweepRunning = true;
    yield* sweepSettings(root).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          sweepRunning = false;
        }),
      ),
      Effect.forkIn(runnerScope, { uninterruptible: false }),
    );
  }, Effect.uninterruptible);
  const resolveClaudeEnvironment = (
    Effect.isEffect(environment) ? environment : Effect.succeed(environment)
  ).pipe(
    Effect.flatMap((base) => makeClaudeEnvironment(claudeSettings, base)),
    Effect.provideService(Path.Path, path),
  );
  const requireClaudeMemory = Effect.fn("ClaudeTextGeneration.requireMemory")(function* (
    operation: MemoryOperationName,
    claudeEnvironment: NodeJS.ProcessEnv,
  ) {
    if (!claudeSettings.enabled)
      return yield* new TextGenerationError({
        operation,
        detail: "Claude is disabled in GOAT settings.",
      });
    yield* verifyClaudeMemoryHooks(operation, claudeEnvironment).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.HomeDirectory, home),
    );
  });
  const serverConfig = yield* ServerConfig.ServerConfig;
  const scopedModelCatalog = modelCatalog.pipe(
    Effect.map((catalog) => scopeClaudeModelCatalog(catalog, claudeSettings.customModels)),
  );

  const readStreamAsString = Effect.fn("ClaudeTextGeneration.readOutput")(
    <E>(operation: string, stream: Stream.Stream<Uint8Array, E>) =>
      collectStreamAsString(stream, { maxBytes: 8 * 1024 * 1024 }).pipe(
        Effect.mapError((cause) =>
          normalizeCliError("claude", operation, cause, "Failed to collect process output"),
        ),
      ),
  );

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation,
    value: unknown,
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  const readImageBlocks = Effect.fn("readImageBlocks")(function* (
    attachments: TextGenerationOperations.Request<Schema.Top>["attachments"],
    operation: TextGenerationOperations.Request<Schema.Top>["operation"],
  ) {
    const blocks: Array<{
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }> = [];
    for (const attachment of attachments ?? []) {
      if (attachment.type !== "image") continue;
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new TextGenerationError({
          operation,
          detail: "Invalid image attachment path.",
        });
      }
      const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read image attachment.",
              cause,
            }),
        ),
      );
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: Buffer.from(bytes).toString("base64"),
        },
      });
    }
    return blocks;
  });

  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    investigate,
    attachments,
  }: TextGenerationOperations.Request<S, string | Effect.Effect<string>>): Effect.fn.Return<
    { readonly result: S["Type"]; readonly effectiveModel: string },
    TextGenerationError,
    S["DecodingServices"]
  > {
    const claudeEnvironment = yield* resolveClaudeEnvironment;
    const operationIsMemory = TextGenerationOperations.isMemoryOperation(operation);
    const launchSettings = operationIsMemory
      ? undefined
      : yield* readClaudeLaunchArgSettings({
          settings: claudeSettings,
          // The investigated checkout holds the change under review, not the user's files.
          cwd: investigate?.projectCwd ?? cwd,
          fileSystem,
          path,
        }).pipe(
          Effect.mapError(
            (cause) => new TextGenerationError({ operation, detail: cause.message, cause }),
          ),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
    const baseCatalog = yield* scopedModelCatalog;
    const catalog = operationIsMemory
      ? baseCatalog
      : yield* routeModelCatalog(
          baseCatalog,
          operation === "generateThreadTitle" || operation === "generateChannelReception"
            ? null
            : (investigate?.projectCwd ?? cwd),
          launchSettings,
          claudeEnvironment,
        );
    const resolvedModelSelection = {
      ...modelSelection,
      model: resolveClaudeModelSlug(catalog, modelSelection.model),
    };
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      yield* toStrictJsonSchemaObject(operation, outputSchemaJson),
      "Failed to encode structured output schema.",
    );
    const effectiveModel = resolveClaudeCatalogApiModelId(catalog, resolvedModelSelection);
    const caps = getClaudeCatalogModelCapabilities(catalog, resolvedModelSelection.model);
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: resolvedModelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(resolvedModelSelection, "effort");
    const resolvedEffort = resolveClaudeCatalogEffort(
      catalog,
      resolvedModelSelection.model,
      rawEffortSelection,
    );
    const cliEffort = normalizeClaudeCatalogEffort(
      catalog,
      resolvedEffort,
      resolvedModelSelection.model,
    );
    const ultracode = findDescriptor("ultracode")?.currentValue;
    const fastModeDescriptor = findDescriptor("fastMode");
    // Only a chosen value; otherwise Claude Code's own default applies, as in chat turns.
    const thinking = compileClaudeModelSelection(resolvedModelSelection, catalog).settings
      .alwaysThinkingEnabled;
    const fastMode =
      fastModeDescriptor?.type === "boolean"
        ? (getModelSelectionBooleanOptionValue(resolvedModelSelection, "fastMode") ??
          (launchSettings?.fastMode === undefined && fastModeDescriptor.currentValue === true
            ? true
            : undefined))
        : undefined;
    const baseSettings: Record<string, unknown> = investigate
      ? investigationSettings(
          yield* readClaudeUserSettings(claudeSettings, cwd, claudeEnvironment).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(HostProcess.HomeDirectory, home),
          ),
          launchSettings,
        )
      : { ...launchSettings };
    const { env: homePinnedEnv } = claudeHomeFlagSettings(claudeEnvironment);
    const settings: Record<string, unknown> = {
      ...baseSettings,
      ...(homePinnedEnv === undefined
        ? {}
        : {
            env: {
              ...(Predicate.isObject(baseSettings.env) ? baseSettings.env : {}),
              ...homePinnedEnv,
            },
          }),
      disableAllHooks: true,
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(typeof fastMode === "boolean" ? { fastMode } : {}),
      ...(typeof ultracode === "boolean" ? { ultracode } : {}),
    };
    const settingsJson = yield* encodeJsonForOperation(
      operation,
      settings,
      "Failed to encode Claude CLI settings.",
    );

    // `claude -p` accepts images only as content blocks of a stream-json user message.
    const imageBlocks = textOnlyModels.has(effectiveModel)
      ? []
      : yield* readImageBlocks(attachments, operation);
    const imageStdin =
      imageBlocks.length > 0 && typeof prompt === "string"
        ? `${yield* encodeJsonForOperation(
            operation,
            {
              type: "user",
              message: { role: "user", content: [{ type: "text", text: prompt }, ...imageBlocks] },
            },
            "Failed to encode Claude CLI input.",
          )}\n`
        : undefined;

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* (
      noSessionPersistence: boolean,
      withImages: boolean,
    ) {
      const streamJson = withImages && imageStdin !== undefined;
      const stdin = streamJson ? imageStdin : prompt;
      if (TextGenerationOperations.isMemoryOperation(operation))
        yield* requireClaudeMemory(operation, claudeEnvironment);
      const workingDirectory =
        operation === "generateThreadTitle" ||
        operation === "generateChannelReception" ||
        TextGenerationOperations.isMemoryOperation(operation)
          ? yield* fileSystem
              .makeTempDirectoryScoped({ prefix: "goat-claude-title-" })
              .pipe(
                Effect.mapError((cause) =>
                  normalizeCliError("claude", operation, cause, "Failed to create title directory"),
                ),
              )
          : cwd;
      const settingsPath = yield* Effect.gen(function* () {
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: `${CLAUDE_SETTINGS_TEMP_PREFIX}p${process.pid}-`,
        });
        yield* scheduleSettingsSweep(path.dirname(directory));
        const file = path.join(directory, "settings.json");
        yield* fileSystem.writeFileString(file, settingsJson, { flag: "wx", mode: 0o600 });
        yield* fileSystem.chmod(file, 0o600);
        return file;
      }).pipe(
        Effect.mapError((cause) =>
          normalizeCliError(
            "claude",
            operation,
            cause,
            "Failed to prepare private Claude settings",
          ),
        ),
      );
      const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
      const spawnCommand = yield* resolveSpawnCommand(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          ...(streamJson
            ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
            : ["--output-format", "json"]),
          ...(TextGenerationOperations.isMemoryOperation(operation)
            ? ["--verbose", "--setting-sources", ""]
            : []),
          "--json-schema",
          jsonSchemaStr,
          "--model",
          effectiveModel,
          ...(cliEffort ? ["--effort", cliEffort] : []),
          "--settings",
          settingsPath,
          ...(investigate
            ? [
                "--tools",
                CLAUDE_INVESTIGATION_TOOLS,
                "--allowedTools",
                CLAUDE_INVESTIGATION_ALLOWED,
                "--disallowedTools",
                CLAUDE_INVESTIGATION_DENIED,
              ]
            : ["--tools", ""]),
          ...(investigate ? ["--setting-sources", ""] : []),
          "--disable-slash-commands",
          ...(noSessionPersistence ? [NO_SESSION_PERSISTENCE] : []),
          // managed-mcp.json already isolates servers and makes Claude reject this flag.
          ...(managedMcpConfig ? [] : ["--strict-mcp-config"]),
          "--permission-mode",
          "dontAsk",
        ],
        { env: claudeEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: claudeEnvironment,
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(
            typeof stdin === "string" ? Stream.make(stdin) : Stream.fromEffect(stdin),
          ),
        },
        forceKillAfter: "1 second",
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      // stream-json prints one message per line and ends with the result message.
      return {
        stdout: streamJson ? (stdout.trim().split("\n").at(-1) ?? "") : stdout,
        stderr,
        exitCode,
      };
    });

    const runClaudeAttempt = (withImages: boolean) =>
      runClaudeCommand(true, withImages).pipe(
        Effect.filterOrElse(
          (result) =>
            result.exitCode === 0 ||
            !result.stderr.split(/\r?\n/).some((line) => line === NO_SESSION_PERSISTENCE_REJECTED),
          () => runClaudeCommand(false, withImages),
        ),
      );
    const rawStdout = yield* runClaudeAttempt(true).pipe(
      Effect.filterOrElse(
        (result) =>
          result.exitCode === 0 ||
          imageStdin === undefined ||
          !/\bimages?\b[^\n]{0,80}\b(?:not support(?:ed)?|unsupported)\b|\b(?:not support(?:ed)?|unsupported)\b[^\n]{0,80}\bimages?\b/i.test(
            `${result.stderr}\n${claudeErrorResult(result.stdout) ?? ""}`,
          ),
        () =>
          runClaudeAttempt(false).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if (result.exitCode === 0) {
                  if (textOnlyModels.size >= 128)
                    textOnlyModels.delete(textOnlyModels.values().next().value ?? "");
                  textOnlyModels.add(effectiveModel);
                }
              }),
            ),
          ),
      ),
      Effect.flatMap(({ stdout, stderr, exitCode }) => {
        if (exitCode === 0) return Effect.succeed(stdout);
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail =
          claudeErrorResult(stdoutDetail) ??
          (stderrDetail.length > 0 ? stderrDetail : stdoutDetail);
        return Effect.fail(
          new TextGenerationError({
            operation,
            detail:
              detail.length > 0
                ? `Claude CLI command failed: ${detail}`
                : `Claude CLI command failed with code ${exitCode}.`,
          }),
        );
      }),
      Effect.scoped,
      Effect.timeoutOption(investigate?.timeoutMs ?? CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const output = yield* decodeClaudeOutput(rawStdout).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude CLI returned unexpected output format.",
              cause,
            }),
          ),
      }),
    );
    const messages = isClaudeOutputEnvelope(output) ? [output] : output;
    if (TextGenerationOperations.isMemoryOperation(operation) && hasClaudeToolAttempt(messages))
      return yield* new TextGenerationError({
        operation,
        detail: "Claude attempted a tool or permission request during memory generation.",
        cause: new MemoryGenerationRunnerError({ code: "invalid_output" }),
      });
    const envelope = isClaudeOutputEnvelope(output)
      ? output
      : output.findLast((message) => message.type === "result");

    const result = yield* Schema.decodeEffect(outputSchemaJson)(
      envelope?.structured_output,
      TextGenerationOperations.outputDecodeOptions(operation),
    ).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
    return { result, effectiveModel };
  });

  const run: TextGenerationOperations.Runner<string | Effect.Effect<string>> = (request) =>
    runClaudeJson(request).pipe(Effect.map((selected) => selected.result));
  return TextGenerationOperations.fromRunner("ClaudeTextGeneration", run, {
    memory: {
      capabilities: memoryRunnerCapabilities("claudeAgent", memoryRunnerContext, {
        available: resolveClaudeEnvironment.pipe(
          Effect.flatMap((environment) =>
            requireClaudeMemory("generateMemorySummary", environment),
          ),
          Effect.isSuccess,
        ),
      }),
      run: withMemoryExecution(
        memoryRunnerContext,
        ProviderDriverKind.make("claudeAgent"),
        runClaudeJson,
      ),
    },
    channelReception: run,
  });
});
