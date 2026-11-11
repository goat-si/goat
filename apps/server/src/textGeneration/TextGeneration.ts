import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderInstanceId } from "@goat/contracts";
import type { ProviderTextGeneration } from "@goat/provider-core/server/textGeneration";
import { TextGenerationError } from "@goat/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import { apiTextGeneration } from "./TextGeneratorApi.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
  ResolveMemoryConflictInput,
  ResolveMemoryConflictResult,
  ResolveMemoryConflictExecutionResult,
  GenerateMemorySummaryInput,
  GenerateMemorySummaryResult,
  GenerateMemorySummaryExecutionResult,
  GenerateMemorySummaryOutcome,
  MemoryGenerationExecution,
} from "@goat/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "goat/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateChannelReception"
  | "generateReviewGuide"
  | "resolveMemoryConflict"
  | "generateMemorySummary";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail:
                operation === "resolveMemoryConflict" || operation === "generateMemorySummary"
                  ? "route_unavailable"
                  : `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const resolveText = Effect.fn("TextGeneration.resolveText")(
    (operation: TextGenerationOp, instanceId: ProviderInstanceId) =>
      settingsService.getSettings.pipe(
        Effect.mapError(
          () =>
            new TextGenerationError({
              operation,
              detail: "Could not read text generation settings.",
            }),
        ),
        Effect.flatMap((settings) => {
          const config = Object.hasOwn(settings.textGenerators, instanceId)
            ? settings.textGenerators[instanceId]
            : undefined;
          if (config === undefined) return resolveInstance(registry, operation, instanceId);
          if (!config.enabled)
            return Effect.fail(
              new TextGenerationError({
                operation,
                detail: "The configured model API is disabled.",
              }),
            );
          return Effect.succeed(apiTextGeneration(config, settings.secretProviders));
        }),
      ),
  );
  const resolveAgent = Effect.fn("TextGeneration.resolveAgent")(
    (operation: TextGenerationOp, instanceId: ProviderInstanceId) =>
      settingsService.getSettings.pipe(
        Effect.mapError(
          () =>
            new TextGenerationError({
              operation,
              detail: "Could not read text generation settings.",
            }),
        ),
        Effect.flatMap((settings) =>
          Object.hasOwn(settings.textGenerators, instanceId)
            ? Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "This task requires a coding provider.",
                }),
              )
            : resolveInstance(registry, operation, instanceId),
        ),
      ),
  );
  return TextGeneration.of({
    resolveMemoryConflict: (input) =>
      resolveAgent("resolveMemoryConflict", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.resolveMemoryConflict === undefined
            ? Effect.fail(
                new TextGenerationError({
                  operation: "resolveMemoryConflict",
                  detail: "unsupported_operation",
                }),
              )
            : textGeneration.resolveMemoryConflict(input),
        ),
      ),
    generateMemorySummary: (input) =>
      resolveAgent("generateMemorySummary", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.generateMemorySummary === undefined
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generateMemorySummary",
                  detail: "unsupported_operation",
                }),
              )
            : textGeneration.generateMemorySummary(input),
        ),
      ),
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return resolveText("generateCommitMessage", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return resolveText("generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return resolveText("generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      );
    }),
    generateChannelReception: (input) =>
      resolveAgent("generateChannelReception", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.generateChannelReception === undefined
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generateChannelReception",
                  detail: "This provider does not support channel reception.",
                }),
              )
            : textGeneration.generateChannelReception(input),
        ),
      ),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return resolveAgent("generateReviewGuide", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateReviewGuide(input)),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return resolveText("generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({ ...input, linkedContext });
          }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make);
