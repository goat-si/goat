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
  return TextGeneration.of({
    resolveMemoryConflict: (input) =>
      resolveInstance(registry, "resolveMemoryConflict", input.modelSelection.instanceId).pipe(
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
      resolveInstance(registry, "generateMemorySummary", input.modelSelection.instanceId).pipe(
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
    generateCommitMessage: (input) =>
      resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
      ),
    generatePrContent: (input) =>
      resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return resolveInstance(
        registry,
        "generateCommitMessage",
        input.modelSelection.instanceId,
      ).pipe(Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)));
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      ),
    generateChannelReception: (input) =>
      resolveInstance(registry, "generateChannelReception", input.modelSelection.instanceId).pipe(
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
    generateReviewGuide: (input) =>
      resolveInstance(registry, "generateReviewGuide", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateReviewGuide(input)),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
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
