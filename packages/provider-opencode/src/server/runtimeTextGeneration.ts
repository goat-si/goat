import { MemoryModelSelection, TextGenerationError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  MemoryGenerationRunnerContext,
  MemoryGenerationRunnerError,
  type MemoryOperationName,
} from "@goat/provider-core/server/memoryGenerationRunner";
import {
  classifySpawnFailure,
  isCommandMissingCause,
} from "@goat/provider-core/server/snapshotProbe";
import type { ProviderTextGeneration } from "@goat/provider-core/server/textGeneration";

import { LaunchEnvironment } from "./launchEnvironment.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { findSpawnFailure } from "./spawnFailure.ts";
import { requireOpenCodeMemoryIsolation } from "./textGeneration.ts";
import type { ProbedOpenCode } from "./versionProbe.ts";

const decodeMemoryContext = Schema.decodeEffect(MemoryGenerationRunnerContext);
const decodeMemorySelection = Schema.decodeEffect(MemoryModelSelection);

export function selectOpenCodeRuntimeTextGeneration(
  resolve: Effect.Effect<ProbedOpenCode, OpenCodeRuntime.OpenCodeRuntimeError>,
  currentEnvironment: Effect.Effect<NodeJS.ProcessEnv>,
  memoryContext: MemoryGenerationRunnerContext,
  external: boolean,
  binaryPath: string,
  v1: ProviderTextGeneration,
  v2: ProviderTextGeneration,
): ProviderTextGeneration {
  const memoryPreflight = Effect.fn("OpenCode.memoryPreflight")(function* (
    operation: MemoryOperationName,
    selection: MemoryModelSelection,
  ) {
    const failure = (code: "unavailable" | "identity_mismatch") =>
      new TextGenerationError({
        operation,
        detail: "Memory runner identity or output is invalid.",
        cause: new MemoryGenerationRunnerError({ code }),
      });
    if (memoryContext.environmentId === undefined) return yield* failure("unavailable");
    const identity = yield* decodeMemoryContext(memoryContext, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => failure("identity_mismatch")),
    );
    const model = yield* decodeMemorySelection(selection, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => failure("identity_mismatch")));
    if (model.instanceId !== identity.providerInstanceId)
      return yield* failure("identity_mismatch");
    if (external) return yield* requireOpenCodeMemoryIsolation(operation);
  });
  const select = <A, E, R, PE>(
    operation: string,
    probe: Effect.Effect<ProbedOpenCode | undefined, PE>,
    paths: { readonly v1: Effect.Effect<A, E, R>; readonly v2: Effect.Effect<A, E, R> },
    memory = false,
  ) =>
    currentEnvironment.pipe(
      Effect.flatMap((environment) =>
        probe.pipe(
          Effect.mapError((cause) => {
            const spawn = findSpawnFailure(cause);
            const failure =
              spawn === undefined
                ? undefined
                : classifySpawnFailure(cause, spawn.cwd, undefined, {
                    binary: binaryPath,
                    env: { PATH: spawn.path },
                  });
            const unavailable =
              !external &&
              memory &&
              (failure === "missing" ||
                failure === "permission_denied" ||
                failure === "exec_failed" ||
                (spawn === undefined &&
                  OpenCodeRuntime.isOpenCodeRuntimeError(cause) &&
                  isCommandMissingCause(cause.cause)));
            return new TextGenerationError({
              operation,
              detail: "Could not determine the OpenCode runtime version.",
              cause: unavailable ? new MemoryGenerationRunnerError({ code: "unavailable" }) : cause,
            });
          }),
          Effect.flatMap((result) => (result?.generation === "v2" ? paths.v2 : paths.v1)),
          Effect.provideService(LaunchEnvironment, environment),
        ),
      ),
    );
  const unsupportedMemory = (operation: MemoryOperationName) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "The selected OpenCode runtime has no memory runner.",
        cause: new MemoryGenerationRunnerError({ code: "unsupported_operation" }),
      }),
    );
  return {
    resolveMemoryConflict: (input) =>
      memoryPreflight("resolveMemoryConflict", input.modelSelection).pipe(
        Effect.andThen(
          select(
            "resolveMemoryConflict",
            resolve,
            {
              v1:
                v1.resolveMemoryConflict === undefined
                  ? unsupportedMemory("resolveMemoryConflict")
                  : v1.resolveMemoryConflict(input),
              v2:
                v2.resolveMemoryConflict === undefined
                  ? unsupportedMemory("resolveMemoryConflict")
                  : v2.resolveMemoryConflict(input),
            },
            true,
          ),
        ),
      ),
    generateMemorySummary: (input) =>
      memoryPreflight("generateMemorySummary", input.modelSelection).pipe(
        Effect.andThen(
          select(
            "generateMemorySummary",
            resolve,
            {
              v1:
                v1.generateMemorySummary === undefined
                  ? unsupportedMemory("generateMemorySummary")
                  : v1.generateMemorySummary(input),
              v2:
                v2.generateMemorySummary === undefined
                  ? unsupportedMemory("generateMemorySummary")
                  : v2.generateMemorySummary(input),
            },
            true,
          ),
        ),
      ),
    generateCommitMessage: (input) =>
      select("generateCommitMessage", resolve, {
        v1: v1.generateCommitMessage(input),
        v2: v2.generateCommitMessage(input),
      }),
    generatePrContent: (input) =>
      select("generatePrContent", resolve, {
        v1: v1.generatePrContent(input),
        v2: v2.generatePrContent(input),
      }),
    generateBranchName: (input) =>
      select("generateBranchName", resolve, {
        v1: v1.generateBranchName(input),
        v2: v2.generateBranchName(input),
      }),
    generateThreadTitle: (input) =>
      select("generateThreadTitle", resolve, {
        v1: v1.generateThreadTitle(input),
        v2: v2.generateThreadTitle(input),
      }),
    generateReviewGuide: (input) =>
      select("generateReviewGuide", resolve, {
        v1: v1.generateReviewGuide(input),
        v2: v2.generateReviewGuide(input),
      }),
  };
}
