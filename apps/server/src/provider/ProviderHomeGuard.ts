import { TextGenerationError, type ServerProvider } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import { MemoryGenerationRunnerError } from "@goat/provider-core/server/memoryGenerationRunner";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2SessionRuntime,
} from "@goat/provider-core/server/ProviderAdapter";
import type { ProviderTextGeneration } from "@goat/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as Routes from "./CodexRouteService.ts";
import type { ProviderHomeRuntime } from "./ProviderHomeRuntime.ts";

const FOREIGN_MODEL =
  "This instance uses OpenCodex Home. Choose an explicit exported Home model, or disconnect it in Settings.";
const REPLACED = "This provider runtime was replaced. Refresh the instance and retry.";

/**
 * Admits model work on a Claude Code, OpenCode or Pi instance. A routed instance accepts only the
 * models Home exported, never a default or foreign selection, and a retained reference to a
 * replaced runtime fails before it can start work. Text generation holds an active-use lease so
 * a route change waits for it, on the default route too.
 */
export function guardProviderHomeInstance(
  instance: ProviderInstance,
  home: ProviderHomeRuntime | undefined,
  leases: Routes.CodexRouteState["Service"],
  generation: string,
): ProviderInstance {
  const driver = instance.driverKind;
  const allowed = (model: string) => home === undefined || home.allowedModels.has(model);
  const check = (model: string) =>
    leases.assertGeneration(instance.instanceId, generation).pipe(
      Effect.mapError(() => new ProviderAdapterProtocolError({ driver, detail: REPLACED })),
      Effect.andThen(() =>
        allowed(model)
          ? Effect.void
          : Effect.fail(new ProviderAdapterProtocolError({ driver, detail: FOREIGN_MODEL })),
      ),
    );
  const wrapRuntime = (
    runtime: ProviderAdapterV2SessionRuntime,
  ): ProviderAdapterV2SessionRuntime => {
    const { compactThread, resumeTurn } = runtime;
    return {
      ...runtime,
      ensureThread: (input) =>
        check(input.modelSelection.model).pipe(Effect.andThen(() => runtime.ensureThread(input))),
      // Without a selection these submit no inference; the next startTurn is checked.
      resumeThread: (input) =>
        (input.modelSelection ? check(input.modelSelection.model) : Effect.void).pipe(
          Effect.andThen(() => runtime.resumeThread(input)),
        ),
      forkThread: (input) =>
        (input.modelSelection ? check(input.modelSelection.model) : Effect.void).pipe(
          Effect.andThen(() => runtime.forkThread(input)),
        ),
      startTurn: (input) =>
        check(input.modelSelection.model).pipe(Effect.andThen(() => runtime.startTurn(input))),
      ...(compactThread === undefined
        ? {}
        : {
            compactThread: (input: Parameters<typeof compactThread>[0]) =>
              check(input.modelSelection.model).pipe(Effect.andThen(() => compactThread(input))),
          }),
      ...(resumeTurn === undefined
        ? {}
        : {
            resumeTurn: (input: Parameters<typeof resumeTurn>[0]) =>
              check(input.modelSelection.model).pipe(Effect.andThen(() => resumeTurn(input))),
          }),
    };
  };
  const lease = <I extends { readonly modelSelection: { readonly model: string } }, A>(
    operation: string,
    run: (input: I) => Effect.Effect<A, TextGenerationError>,
  ) =>
    Effect.fn(`ProviderHomeGuard.${operation}`)(function* (input: I) {
      if (!allowed(input.modelSelection.model))
        return yield* new TextGenerationError({ operation, detail: FOREIGN_MODEL });
      yield* leases
        .reserveUse(instance.instanceId, generation)
        .pipe(
          Effect.mapError(
            (cause) => new TextGenerationError({ operation, detail: cause.message, cause }),
          ),
        );
      return yield* run(input);
    }, Effect.scoped);
  // The memory runner selects its OpenCode generation outside this overlay, so routed memory work
  // is refused instead of risking a request outside Home.
  const unsupportedMemory = (operation: "resolveMemoryConflict" | "generateMemorySummary") =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail:
          "OpenCode memory generation is not available while this instance uses OpenCodex Home.",
        cause: new MemoryGenerationRunnerError({ code: "unsupported_operation" }),
      }),
    );
  const text = instance.textGeneration;
  const refuseMemory = home !== undefined && driver === "opencode";
  const { generateChannelReception, resolveMemoryConflict, generateMemorySummary } = text;
  const textGeneration: ProviderTextGeneration = {
    generateCommitMessage: lease("generateCommitMessage", text.generateCommitMessage),
    generatePrContent: lease("generatePrContent", text.generatePrContent),
    generateBranchName: lease("generateBranchName", text.generateBranchName),
    generateThreadTitle: lease("generateThreadTitle", text.generateThreadTitle),
    generateReviewGuide: lease("generateReviewGuide", text.generateReviewGuide),
    ...(generateChannelReception === undefined
      ? {}
      : { generateChannelReception: lease("generateChannelReception", generateChannelReception) }),
    ...(resolveMemoryConflict === undefined
      ? {}
      : {
          resolveMemoryConflict: refuseMemory
            ? () => unsupportedMemory("resolveMemoryConflict")
            : lease("resolveMemoryConflict", resolveMemoryConflict),
        }),
    ...(generateMemorySummary === undefined
      ? {}
      : {
          generateMemorySummary: refuseMemory
            ? () => unsupportedMemory("generateMemorySummary")
            : lease("generateMemorySummary", generateMemorySummary),
        }),
  };
  const observe = <S extends ServerProvider>(snapshot: S): S =>
    home === undefined
      ? snapshot
      : {
          ...snapshot,
          homeRoute: { modelRoute: "opencodex", effectiveBaseUrl: home.baseUrl },
          models: home.models,
        };
  const { snapshotForCwd } = instance;
  return {
    ...instance,
    snapshot: {
      ...instance.snapshot,
      getSnapshot: instance.snapshot.getSnapshot.pipe(Effect.map(observe)),
      refresh: instance.snapshot.refresh.pipe(Effect.map(observe)),
      streamChanges: instance.snapshot.streamChanges.pipe(Stream.map(observe)),
    },
    ...(snapshotForCwd === undefined
      ? {}
      : { snapshotForCwd: (cwd: string) => snapshotForCwd(cwd).pipe(Effect.map(observe)) }),
    orchestrationAdapter: {
      ...instance.orchestrationAdapter,
      openSession: (input) =>
        check(input.modelSelection.model).pipe(
          Effect.andThen(() => instance.orchestrationAdapter.openSession(input)),
          Effect.map(wrapRuntime),
        ),
    },
    textGeneration,
  };
}
