import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";

import {
  validateMemoryGenerationResult,
  GenerateMemorySummaryExecutionResult,
  ResolveMemoryConflictExecutionResult,
  type ChatAttachment,
  type ModelSelection,
  TextGenerationError,
} from "@goat/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@goat/shared/git";
import { extractJsonObject } from "@goat/shared/schemaJson";

import { buildChannelReceptionPrompt, toChannelReceptionResult } from "./channelReceptionPrompt.ts";
import {
  buildMemoryConflictPrompt,
  buildMemorySummaryPrompt,
  memoryEvidenceSources,
  memoryResultFromModelOutput,
} from "./memoryGenerationPrompts.ts";
import { unsupportedMemoryRunner, type MemoryRunner } from "./memoryGenerationRunner.ts";
export type { MemoryRunner } from "./memoryGenerationRunner.ts";
import type { ProviderTextGeneration } from "./textGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildReviewGuidePrompt,
  buildThreadTitlePrompt,
} from "./textGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

export type Operation = keyof ProviderTextGeneration;
export const isMemoryOperation = (
  operation: Operation,
): operation is "resolveMemoryConflict" | "generateMemorySummary" =>
  operation === "resolveMemoryConflict" || operation === "generateMemorySummary";

/**
 * Parse options for a provider's raw structured output. Memory output is authority-bearing, so a
 * key outside its schema fails the decode instead of being silently dropped.
 */
export const outputDecodeOptions = (operation: Operation): SchemaAST.ParseOptions | undefined =>
  isMemoryOperation(operation) ? { onExcessProperty: "error" } : undefined;
const sameMemorySelection = (
  a: import("@goat/contracts").MemoryModelSelection,
  b: import("@goat/contracts").MemoryModelSelection,
) =>
  a.instanceId === b.instanceId &&
  a.model === b.model &&
  (a.options?.length ?? 0) === (b.options?.length ?? 0) &&
  (a.options ?? []).every(
    (option, i) => option.id === b.options?.[i]?.id && option.value === b.options[i]?.value,
  );
const decodeMemorySummaryExecution = Schema.decodeUnknownEffect(
  GenerateMemorySummaryExecutionResult,
);
const decodeMemoryConflictExecution = Schema.decodeUnknownEffect(
  ResolveMemoryConflictExecutionResult,
);

export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** Investigate cwd with read-only tools across turns; fail if the runner cannot guarantee read-only access. */
  readonly investigate?: { readonly timeoutMs: number } | undefined;
}

const INVESTIGATION_TIMEOUT_MS = 15 * 60_000;

export const investigationUnsupported = (operation: Operation, provider: string) =>
  new TextGenerationError({
    operation,
    detail: `${provider} cannot investigate a checkout read-only. Choose another review guide model, or source control writer model when none is set.`,
  });

export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

export const withoutInvestigation =
  (provider: string, run: Runner): Runner =>
  (request) =>
    request.investigate
      ? Effect.fail(investigationUnsupported(request.operation, provider))
      : run(request);

export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
  return decodeOutput(extractJsonObject(text), outputDecodeOptions(request.operation)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output.`,
          cause,
        }),
    ),
  );
};

export interface FromRunnerOptions {
  readonly memoryRunner?: MemoryRunner;
  /**
   * Also offer channel reception. Only providers whose runner has been checked to run it with
   * tools off and in an empty directory turn this on.
   */
  readonly channelReception?: boolean;
}

export function fromRunner(
  name: string,
  run: Runner,
  options: FromRunnerOptions = {},
): ProviderTextGeneration {
  const runMemory = options.memoryRunner ?? unsupportedMemoryRunner;
  const resolveMemoryConflict: NonNullable<ProviderTextGeneration["resolveMemoryConflict"]> =
    Effect.fn(`${name}.resolveMemoryConflict`)(function* (input) {
      const request = yield* buildMemoryConflictPrompt(input);
      const generated = yield* runMemory({
        operation: "resolveMemoryConflict",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...request,
      });
      const result = yield* decodeMemoryConflictExecution(
        {
          ...generated,
          result: memoryResultFromModelOutput(generated.result, memoryEvidenceSources(input)),
        },
        { onExcessProperty: "error" },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "resolveMemoryConflict",
              detail: "Memory result is invalid.",
              cause,
            }),
        ),
      );
      if (
        !validateMemoryGenerationResult(input, result.result) ||
        result.execution.providerInstanceId !== input.modelSelection.instanceId ||
        !sameMemorySelection(result.execution.requestedModelSelection, input.modelSelection)
      )
        return yield* new TextGenerationError({
          operation: "resolveMemoryConflict",
          detail: "Memory evidence or execution is invalid.",
        });
      return result;
    });
  const generateMemorySummary: NonNullable<ProviderTextGeneration["generateMemorySummary"]> =
    Effect.fn(`${name}.generateMemorySummary`)(function* (input) {
      const request = yield* buildMemorySummaryPrompt(input);
      const generated = yield* runMemory({
        operation: "generateMemorySummary",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...request,
      });
      const result = yield* decodeMemorySummaryExecution(
        {
          ...generated,
          result: memoryResultFromModelOutput(generated.result, memoryEvidenceSources(input)),
        },
        { onExcessProperty: "error" },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateMemorySummary",
              detail: "Memory result is invalid.",
              cause,
            }),
        ),
      );
      if (
        !validateMemoryGenerationResult(input, result.result) ||
        result.execution.providerInstanceId !== input.modelSelection.instanceId ||
        !sameMemorySelection(result.execution.requestedModelSelection, input.modelSelection)
      )
        return yield* new TextGenerationError({
          operation: "generateMemorySummary",
          detail: "Memory evidence or execution is invalid.",
        });
      return result;
    });
  const generateCommitMessage: ProviderTextGeneration["generateCommitMessage"] = Effect.fn(
    `${name}.generateCommitMessage`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      }),
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: ProviderTextGeneration["generatePrContent"] = Effect.fn(
    `${name}.generatePrContent`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generatePrContent",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
        threadContext: input.threadContext,
      }),
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: ProviderTextGeneration["generateBranchName"] = Effect.fn(
    `${name}.generateBranchName`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateBranchName",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      }),
    });
    return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
  });

  const generateThreadTitle: ProviderTextGeneration["generateThreadTitle"] = Effect.fn(
    `${name}.generateThreadTitle`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        forkSource: input.forkSource,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
        instructions: input.instructions,
      }),
    });
    return {
      title: sanitizeThreadTitle(generated.title),
      ...(generated.needsRefinement ? { needsRefinement: true } : {}),
    };
  });

  const generateChannelReception: NonNullable<ProviderTextGeneration["generateChannelReception"]> =
    Effect.fn(`${name}.generateChannelReception`)(function* (input) {
      const generated = yield* run({
        operation: "generateChannelReception",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...buildChannelReceptionPrompt(input.input),
      });
      const result = toChannelReceptionResult(generated);
      if (Option.isNone(result)) {
        return yield* new TextGenerationError({
          operation: "generateChannelReception",
          detail: "The model chose an action without the fields it needs.",
        });
      }
      return result.value;
    });

  const generateReviewGuide: ProviderTextGeneration["generateReviewGuide"] = Effect.fn(
    `${name}.generateReviewGuide`,
  )(function* (input) {
    return yield* run({
      operation: "generateReviewGuide",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      investigate: { timeoutMs: INVESTIGATION_TIMEOUT_MS },
      ...buildReviewGuidePrompt(input),
    });
  });

  return {
    resolveMemoryConflict,
    generateMemorySummary,
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    ...(options.channelReception === true ? { generateChannelReception } : {}),
    generateReviewGuide,
  } satisfies ProviderTextGeneration;
}
