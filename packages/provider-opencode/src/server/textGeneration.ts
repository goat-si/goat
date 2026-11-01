import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProviderDriverKind, TextGenerationError } from "@goat/contracts";
import {
  MemoryGenerationRunnerError,
  withMemoryExecution,
  type MemoryGenerationRunnerContext,
  type MemoryOperationName,
} from "@goat/provider-core/server/memoryGenerationRunner";
import type { OpenCodeSettings } from "../settings.ts";
import { getModelSelectionStringOptionValue } from "@goat/shared/model";

import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as TextGenerationOperations from "@goat/provider-core/server/textGenerationOperations";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import { prepareMemoryServer } from "./memoryIsolation.ts";

/** External servers are not controlled by the instance owner. */
export const requireOpenCodeMemoryIsolation = (operation: MemoryOperationName) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "OpenCode memory generation cannot isolate configuration on a user-specified external server.",
      cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
    }),
  );

const isTextGenerationError = Schema.is(TextGenerationError);

const OpenCodeTextGenerationOperation = Schema.Literals([
  "resolveMemoryConflict",
  "generateMemorySummary",
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
  "generateChannelReception",
  "generateReviewGuide",
]);

const openCodeTextGenerationErrorContext = {
  operation: OpenCodeTextGenerationOperation,
  cwd: Schema.String,
};

export class OpenCodeTextGenerationSessionRequestError extends Schema.TaggedError<OpenCodeTextGenerationSessionRequestError>()(
  "OpenCodeTextGenerationSessionRequestError",
  {
    ...openCodeTextGenerationErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode session creation request failed for ${this.operation} in ${this.cwd}.`;
  }
}

export class OpenCodeTextGenerationSessionPayloadError extends Schema.TaggedError<OpenCodeTextGenerationSessionPayloadError>()(
  "OpenCodeTextGenerationSessionPayloadError",
  openCodeTextGenerationErrorContext,
) {
  override get message(): string {
    return `OpenCode session.create returned no session payload for ${this.operation} in ${this.cwd}.`;
  }
}

const openCodePromptErrorContext = {
  ...openCodeTextGenerationErrorContext,
  sessionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
};

export class OpenCodeTextGenerationPromptRequestError extends Schema.TaggedError<OpenCodeTextGenerationPromptRequestError>()(
  "OpenCodeTextGenerationPromptRequestError",
  {
    ...openCodePromptErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode prompt request failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}).`;
  }
}

export class OpenCodeTextGenerationPromptResponseError extends Schema.TaggedError<OpenCodeTextGenerationPromptResponseError>()(
  "OpenCodeTextGenerationPromptResponseError",
  {
    ...openCodePromptErrorContext,
    providerErrorName: Schema.optional(Schema.String),
    providerMessage: Schema.String,
  },
) {
  override get message(): string {
    const providerError = this.providerErrorName ? ` ${this.providerErrorName}` : "";
    return `OpenCode prompt${providerError} failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}): ${this.providerMessage}`;
  }
}

export class OpenCodeTextGenerationEmptyOutputError extends Schema.TaggedError<OpenCodeTextGenerationEmptyOutputError>()(
  "OpenCodeTextGenerationEmptyOutputError",
  {
    ...openCodePromptErrorContext,
    responsePartCount: NonNegativeInt,
    textPartCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `OpenCode returned empty output for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}, ${this.responsePartCount} response parts, ${this.textPartCount} text parts).`;
  }
}

interface OpenCodePromptFailure {
  readonly name?: string;
  readonly message: string;
}

interface OpenCodeTextPart {
  readonly type: "text";
  readonly text: string;
}

function getOpenCodePromptFailure(error: unknown): OpenCodePromptFailure | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const name =
    "name" in error && typeof error.name === "string" && error.name.trim().length > 0
      ? error.name.trim()
      : undefined;
  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return {
      ...(name ? { name } : {}),
      message,
    };
  }

  if (name) {
    return { name, message: name };
  }

  return null;
}

function isOpenCodeTextPart(part: unknown): part is OpenCodeTextPart {
  return (
    part !== null &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .filter(isOpenCodeTextPart)
    .map((part) => part.text)
    .join("")
    .trim();
}

export const makeOpenCodeTextGeneration = Effect.fn("makeOpenCodeTextGeneration")(function* (
  openCodeSettings: OpenCodeSettings,
  options: {
    readonly memoryRunnerContext?: MemoryGenerationRunnerContext;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const host = yield* ProviderHost.ProviderHost;
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const serverOwner = yield* OpenCodeServerOwner.OpenCodeServerOwner;

  const runOpenCodeSelected = Effect.fn("runOpenCodeSelected")(
    function* <S extends Schema.Top>(input: TextGenerationOperations.Request<S>) {
      const memory = TextGenerationOperations.isMemoryOperation(input.operation);
      if (memory && openCodeSettings.serverUrl.trim().length > 0)
        return yield* requireOpenCodeMemoryIsolation(input.operation);

      const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
      if (!parsedModel) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "OpenCode model selection must use the 'provider/model' format.",
          ...(memory ? { cause: new MemoryGenerationRunnerError({ code: "unavailable" }) } : {}),
        });
      }

      const isolated = memory
        ? yield* prepareMemoryServer(
            input.operation,
            parsedModel.providerID,
            options.environment ?? process.env,
            1,
          )
        : undefined;
      const cwd = isolated?.directory ?? input.cwd;

      const fileParts = OpenCodeRuntime.toOpenCodeFileParts({
        attachments: input.attachments?.filter((attachment) => attachment.type === "image"),
        resolveAttachmentPath: host.resolveAttachmentPath,
      });

      const runAgainstServer = Effect.fn("runOpenCodeJson.runAgainstServer")(
        function* (
          server: Pick<
            OpenCodeRuntime.OpenCodeServerConnection,
            "url" | "serverPassword" | "version"
          >,
        ) {
          const client = openCodeRuntime.createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: cwd,
            ...(server.serverPassword !== undefined
              ? { serverPassword: server.serverPassword }
              : {}),
          });
          const failure = (detail: string, unavailable = false) =>
            new TextGenerationError({
              operation: input.operation,
              detail,
              ...(unavailable
                ? { cause: new MemoryGenerationRunnerError({ code: "unavailable" }) }
                : {}),
            });
          const rejected = yield* Deferred.make<never, TextGenerationError>();
          const reject = () =>
            Deferred.fail(
              rejected,
              failure("OpenCode attempted a tool or permission request during memory generation."),
            ).pipe(Effect.asVoid);
          let attemptedTool = false;
          let sessionId: string | undefined;
          let tools: Record<string, boolean> | undefined;
          if (memory) {
            const config = yield* Effect.tryPromise({
              try: (signal) => client.config.get({}, { signal, throwOnError: true }),
              catch: () => failure("OpenCode memory configuration could not be verified.", true),
            });
            if (
              !config.data ||
              (config.data.plugin?.length ?? 0) > 0 ||
              Object.values(config.data.mcp ?? {}).some(
                (entry) => !("enabled" in entry) || entry.enabled !== false,
              )
            ) {
              return yield* new TextGenerationError({
                operation: input.operation,
                detail:
                  "OpenCode memory generation requires no active MCP servers in its helper location.",
                cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
              });
            }
            const mcp = yield* Effect.tryPromise({
              try: (signal) => client.mcp.status({}, { signal, throwOnError: true }),
              catch: () => failure("OpenCode MCP isolation could not be verified.", true),
            });
            if (!mcp.data || Object.values(mcp.data).some((server) => server.status !== "disabled"))
              return yield* failure("OpenCode memory helper has active MCP connections.", true);
            const ids = yield* Effect.tryPromise({
              try: (signal) => client.tool.ids({}, { signal, throwOnError: true }),
              catch: () => failure("OpenCode memory tools could not be enumerated.", true),
            });
            if (!ids.data) return yield* failure("OpenCode did not disclose its tool list.", true);
            tools = Object.fromEntries(["*", ...ids.data].map((id) => [id, false]));
            const controller = new AbortController();
            const events = yield* Effect.tryPromise({
              try: () => client.event.subscribe({}, { signal: controller.signal }),
              catch: () => failure("OpenCode memory event subscription failed."),
            }).pipe(Effect.onError(() => Effect.sync(() => controller.abort())));
            yield* Stream.fromAsyncIterable(events.stream, () =>
              failure("OpenCode memory event stream failed."),
            ).pipe(
              Stream.runForEach((event) => {
                if (
                  event.type === "message.part.updated" &&
                  event.properties.part.sessionID === sessionId &&
                  event.properties.part.type === "tool"
                )
                  return reject();
                if (event.type === "permission.asked" && event.properties.sessionID === sessionId) {
                  attemptedTool = true;
                  return Effect.tryPromise({
                    try: (signal) =>
                      client.permission.reply(
                        { requestID: event.properties.id, reply: "reject" },
                        { signal },
                      ),
                    catch: () => failure("OpenCode permission denial failed."),
                  }).pipe(Effect.timeout("5 seconds"), Effect.ignore, Effect.andThen(reject()));
                }
                return Effect.void;
              }),
              Effect.andThen(
                Deferred.fail(rejected, failure("OpenCode memory event stream was lost.")),
              ),
              Effect.catch((cause) => Deferred.fail(rejected, cause)),
              Effect.forkScoped,
            );
            yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
          }
          const session = yield* Effect.tryPromise({
            try: (signal) =>
              client.session.create(
                {
                  title: `GOAT ${input.operation}`,
                  permission: [{ permission: "*", pattern: "*", action: "deny" }],
                },
                { signal },
              ),
            catch: (cause) =>
              new OpenCodeTextGenerationSessionRequestError({
                operation: input.operation,
                cwd: input.cwd,
                cause,
              }),
          });
          if (!session.data) {
            return yield* new OpenCodeTextGenerationSessionPayloadError({
              operation: input.operation,
              cwd: input.cwd,
            });
          }
          sessionId = session.data.id;
          if (memory) {
            const id = session.data.id;
            yield* Effect.addFinalizer(() =>
              Effect.tryPromise({
                try: (signal) => client.session.abort({ sessionID: id }, { signal }),
                catch: () => failure("OpenCode memory session abort failed."),
              }).pipe(
                Effect.timeout("5 seconds"),
                Effect.ignore,
                Effect.andThen(
                  Effect.tryPromise({
                    try: (signal) => client.session.delete({ sessionID: id }, { signal }),
                    catch: () => failure("OpenCode memory session cleanup failed."),
                  }).pipe(Effect.timeout("5 seconds"), Effect.ignore),
                ),
              ),
            );
          }
          const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
          const selectedVariant = getModelSelectionStringOptionValue(
            input.modelSelection,
            "variant",
          );
          const promptContext = {
            operation: input.operation,
            cwd: input.cwd,
            sessionId: session.data.id,
            providerId: parsedModel.providerID,
            modelId: parsedModel.modelID,
          };

          const result = yield* Effect.tryPromise({
            try: (signal) =>
              client.session.prompt(
                {
                  sessionID: session.data.id,
                  model: parsedModel,
                  ...(tools === undefined ? {} : { tools }),
                  ...(!memory && selectedAgent ? { agent: selectedAgent } : {}),
                  ...(selectedVariant ? { variant: selectedVariant } : {}),
                  parts: [{ type: "text", text: input.prompt }, ...fileParts],
                },
                { signal },
              ),
            catch: (cause) =>
              new OpenCodeTextGenerationPromptRequestError({
                ...promptContext,
                cause,
              }),
          }).pipe(
            // Cancelling an HTTP request does not stop generation on a shared server.
            Effect.onInterrupt(() => {
              // The isolated helper's scope already aborts and deletes its session.
              if (memory) return Effect.void;
              return OpenCodeRuntime.runOpenCodeSdk("session.abort", (signal) =>
                client.session.abort({ sessionID: session.data.id }, { signal }),
              ).pipe(
                Effect.interruptible,
                Effect.timeout("10 seconds"),
                Effect.catch(() =>
                  Effect.logWarning(
                    "Failed to stop cancelled OpenCode text generation.",
                    promptContext,
                  ),
                ),
                Effect.asVoid,
              );
            }),
            Effect.raceFirst(Deferred.await(rejected)),
          );
          if (memory && attemptedTool)
            return yield* reject().pipe(Effect.andThen(Deferred.await(rejected)));
          if (memory && (yield* Deferred.isDone(rejected))) return yield* Deferred.await(rejected);
          if (memory && result.data?.parts.some((part) => part.type === "tool"))
            return yield* reject().pipe(Effect.andThen(Deferred.await(rejected)));
          const promptFailure = getOpenCodePromptFailure(result.data?.info?.error);
          if (promptFailure) {
            return yield* new OpenCodeTextGenerationPromptResponseError({
              ...promptContext,
              ...(promptFailure.name ? { providerErrorName: promptFailure.name } : {}),
              providerMessage: promptFailure.message,
            });
          }
          if (
            memory &&
            (result.data?.info?.modelID !== parsedModel.modelID ||
              result.data?.info?.providerID !== parsedModel.providerID ||
              result.data?.info?.variant !== selectedVariant)
          )
            return yield* failure("OpenCode did not confirm the selected memory model.", true);
          const responseParts = result.data?.parts ?? [];
          const rawText = getOpenCodeTextResponse(responseParts);
          if (rawText.length === 0) {
            return yield* new OpenCodeTextGenerationEmptyOutputError({
              ...promptContext,
              responsePartCount: responseParts.length,
              textPartCount: responseParts.filter(isOpenCodeTextPart).length,
            });
          }
          return rawText;
        },
        Effect.catchTags({
          OpenCodeTextGenerationSessionRequestError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: cause.operation,
                detail: "OpenCode session.create request failed.",
                cause,
              }),
            ),
          OpenCodeTextGenerationSessionPayloadError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: cause.operation,
                detail: "OpenCode session.create returned no session payload.",
                cause,
              }),
            ),
          OpenCodeTextGenerationPromptRequestError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: cause.operation,
                detail: "OpenCode session.prompt request failed.",
                cause,
              }),
            ),
          OpenCodeTextGenerationPromptResponseError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: cause.operation,
                detail: cause.providerMessage,
                cause,
              }),
            ),
          OpenCodeTextGenerationEmptyOutputError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: cause.operation,
                detail: "OpenCode returned empty output.",
                cause,
              }),
            ),
        }),
      );

      const serverOutput = isolated
        ? openCodeRuntime
            .startOpenCodeServerProcess({
              binaryPath: openCodeSettings.binaryPath,
              directory: isolated.directory,
              environment: isolated.environment,
            })
            .pipe(Effect.flatMap(runAgainstServer))
        : openCodeSettings.serverUrl.length > 0
          ? openCodeRuntime
              .connectToOpenCodeServer({
                binaryPath: openCodeSettings.binaryPath,
                directory: input.cwd,
                serverUrl: openCodeSettings.serverUrl,
                ...(openCodeSettings.serverPassword
                  ? { serverPassword: openCodeSettings.serverPassword }
                  : {}),
              })
              .pipe(Effect.flatMap(runAgainstServer), Effect.scoped)
          : serverOwner.withServer(runAgainstServer);
      const rawOutput = yield* serverOutput.pipe(
        Effect.catchTags({
          OpenCodeRuntimeError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
                // A runtime that cannot start or is too old fails every memory request; a held
                // database lock clears on its own.
                cause:
                  memory && cause.reason !== "databaseLocked"
                    ? new MemoryGenerationRunnerError({ code: "unavailable" })
                    : cause,
              }),
            ),
        }),
      );

      const result = yield* TextGenerationOperations.decodeJsonReply(input, "OpenCode", rawOutput);
      return { result, effectiveModel: `${parsedModel.providerID}/${parsedModel.modelID}` };
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: "3 minutes",
          orElse: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "OpenCode text generation timed out.",
              }),
            ),
        }),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "OpenCode memory workspace setup failed.",
                cause,
              }),
        ),
        Effect.scoped,
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
  );

  return TextGenerationOperations.fromRunner(
    "OpenCodeTextGeneration",
    TextGenerationOperations.withoutInvestigation("OpenCode", (input) =>
      runOpenCodeSelected(input).pipe(Effect.map((selected) => selected.result)),
    ),
    {
      memoryRunner: withMemoryExecution(
        options.memoryRunnerContext,
        ProviderDriverKind.make("opencode"),
        runOpenCodeSelected,
      ),
    },
  );
});
