import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { AcpRequestError } from "effect-acp/errors";
import type * as EffectAcpErrors from "effect-acp/errors";

import { ProviderDriverKind, TextGenerationError } from "@goat/contracts";
import {
  MemoryGenerationRunnerError,
  withMemoryExecution,
  type MemoryGenerationRunnerContext,
} from "@goat/provider-core/server/memoryGenerationRunner";
import type { GrokSettings } from "../settings.ts";
import { getModelSelectionStringOptionValue } from "@goat/shared/model";

import * as TextGenerationOperations from "@goat/provider-core/server/textGenerationOperations";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  currentGrokReasoningEffortFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
  requireGrokMemoryIsolation,
} from "./acpSupport.ts";

const GROK_TIMEOUT_MS = 180_000;
const GROK_CANCEL_TIMEOUT_MS = 2_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeGrokTextGeneration = Effect.fn("makeGrokTextGeneration")(function* (
  grokSettings: GrokSettings,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  options: {
    readonly memoryRunnerContext?: MemoryGenerationRunnerContext;
    /** Re-read at each launch so a key saved after startup reaches the CLI. */
    readonly resolveEnvironment?: Effect.Effect<NodeJS.ProcessEnv>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runGrokSelected = Effect.fn("GrokTextGeneration.runGrokJson")(
    function* <S extends Schema.Top>(request: TextGenerationOperations.Request<S>) {
      const { operation, cwd, prompt, modelSelection } = request;
      const memory = TextGenerationOperations.isMemoryOperation(operation);
      const environment = options.resolveEnvironment
        ? yield* options.resolveEnvironment
        : baseEnvironment;
      const isolated = memory
        ? yield* requireGrokMemoryIsolation(operation, environment).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          )
        : { cwd, environment };
      const rejected = yield* Deferred.make<never, TextGenerationError>();
      const reject = () =>
        Deferred.fail(
          rejected,
          new TextGenerationError({
            operation,
            detail: "Grok attempted a tool or permission request during memory generation.",
          }),
        ).pipe(Effect.asVoid);
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeGrokAcpRuntime({
        grokSettings,
        environment: isolated.environment,
        cwd: isolated.cwd,
        mcpServers: [],
        ...(memory
          ? {
              runtimeMode: "approval-required" as const,
              cancelBehavior: "wait-for-prompt" as const,
              cancelTimeout: GROK_CANCEL_TIMEOUT_MS,
            }
          : {}),
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
      );

      // Headless generation has no adapter consuming the runtime's event queue.
      // Native cancellation needs its barrier acknowledged after the prompt settles.
      if (memory) {
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) =>
            event._tag === "EventStreamBarrier"
              ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
      }

      if (memory) {
        const deny = () =>
          reject().pipe(
            Effect.andThen(
              Effect.fail(
                new AcpRequestError({
                  code: -32601,
                  errorMessage: "Tools are disabled for memory generation.",
                }),
              ),
            ),
          );
        yield* runtime.handleRequestPermission(() =>
          reject().pipe(Effect.as({ outcome: { outcome: "cancelled" as const } })),
        );
        yield* runtime.handleElicitation(() =>
          reject().pipe(Effect.as({ action: "decline" as const })),
        );
        yield* runtime.handleReadTextFile(deny);
        yield* runtime.handleWriteTextFile(deny);
        yield* runtime.handleCreateTerminal(deny);
        yield* runtime.handleTerminalOutput(deny);
        yield* runtime.handleTerminalWaitForExit(deny);
        yield* runtime.handleTerminalKill(deny);
        yield* runtime.handleTerminalRelease(deny);
        yield* runtime.handleUnknownExtRequest(deny);
      }
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (
          memory &&
          (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
        )
          return reject();
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      let promptStarted = false;
      let effectiveModel: string | undefined;
      const promptFiber = yield* Effect.gen(function* () {
        const resolvedModel = resolveGrokAcpBaseModelId(modelSelection.model);
        const started = yield* runtime.start();
        const requestedReasoningEffort = getModelSelectionStringOptionValue(
          modelSelection,
          "reasoningEffort",
        );
        const currentModel = currentGrokModelIdFromSessionSetup(started.sessionSetupResult);
        if (
          memory &&
          (currentModel === undefined ||
            (resolvedModel !== "grok-build" &&
              !started.sessionSetupResult.models?.availableModels.some(
                (model) => model.modelId === resolvedModel,
              )))
        ) {
          return yield* new TextGenerationError({
            operation,
            detail: "Grok did not disclose or support the selected memory model.",
            cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
          });
        }
        effectiveModel = yield* applyGrokAcpModelSelection({
          runtime,
          currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
          currentReasoningEffort: currentGrokReasoningEffortFromSessionSetup(
            started.sessionSetupResult,
          ),
          requestedModelId: resolvedModel,
          requestedReasoningEffort,
          mapError: (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to set Grok ACP base model for text generation.",
              // Memory treats a model it cannot select as unavailable until settings change.
              cause: memory ? new MemoryGenerationRunnerError({ code: "unavailable" }) : cause,
            }),
        });
        promptStarted = true;
        const result = yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
        if (memory && (yield* Deferred.isDone(rejected))) return yield* Deferred.await(rejected);
        return result;
      }).pipe(Effect.forkChild);
      // Race only the join: rejection and timeout must send cancel before interrupting
      // the actual prompt. A non-responsive agent is terminated before scope cleanup.
      const promptResult = yield* Fiber.join(promptFiber).pipe(
        Effect.raceFirst(Deferred.await(rejected)),
        Effect.timeoutOption(GROK_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Grok ACP request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.onError(() =>
          runtime.cancel.pipe(
            Effect.timeoutOption(GROK_CANCEL_TIMEOUT_MS),
            Effect.ignore,
            // Error finalizers are masked; make the bounded wait interruptible.
            Effect.interruptible,
            Effect.ensuring(
              Effect.gen(function* () {
                if (memory && runtime.terminateProcessGroup) {
                  yield* runtime.terminateProcessGroup.pipe(Effect.ignore);
                }
                yield* Fiber.interrupt(promptFiber).pipe(Effect.ignore);
              }),
            ),
          ),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail:
                  memory && !promptStarted
                    ? "Grok memory authentication or model selection is unavailable."
                    : "Grok ACP request failed.",
                cause:
                  memory && !promptStarted
                    ? new MemoryGenerationRunnerError({ code: "unavailable" })
                    : cause,
              }),
        ),
      );

      if (memory && promptResult.stopReason !== "end_turn")
        return yield* new TextGenerationError({
          operation,
          detail: "Grok memory generation did not complete normally.",
        });
      if (memory && (yield* fs.readDirectory(isolated.cwd)).length > 0)
        return yield* new TextGenerationError({
          operation,
          detail: "Grok wrote files during memory generation.",
        });
      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Grok ACP request was cancelled."
              : "Grok Agent returned empty output.",
        });
      }

      const result = yield* TextGenerationOperations.decodeJsonReply(
        request,
        "Grok Agent",
        trimmed,
      );
      return { result, effectiveModel: effectiveModel ?? modelSelection.model };
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Grok ACP text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
        Effect.provideService(FileSystem.FileSystem, fs),
      );
    },
  );

  return TextGenerationOperations.fromRunner(
    "GrokTextGeneration",
    TextGenerationOperations.withoutInvestigation("Grok", (request) =>
      runGrokSelected(request).pipe(Effect.map((selected) => selected.result)),
    ),
    {
      memoryRunner: withMemoryExecution(
        options.memoryRunnerContext,
        ProviderDriverKind.make("grok"),
        runGrokSelected,
      ),
    },
  );
});
