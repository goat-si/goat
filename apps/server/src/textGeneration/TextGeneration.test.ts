import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@goat/contracts";
import * as M from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";

import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Layer from "effect/Layer";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
    generateReviewGuide: () => Effect.die("generateReviewGuide stub not configured for this test"),
    ...overrides,
  });

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration,
  }) satisfies ProviderInstance;

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

describe("TextGeneration.generateChannelReception", () => {
  it.effect("refuses providers without channel reception instead of calling them", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("cursor");
      const generation = yield* TextGeneration.make.pipe(
        Effect.provideService(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          makeStubRegistry([makeStubInstance(instanceId, makeStubTextGeneration({}))]),
        ),
        Effect.provide(
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("reception never resolves links"),
          }),
        ),
      );
      const generate = generation.generateChannelReception;
      if (generate === undefined)
        return yield* Effect.die("server text generation must offer reception");
      const error = yield* Effect.flip(
        generate({
          cwd: process.cwd(),
          input: {
            mode: "input",
            conversationId: "conv-1" as never,
            originKind: "goat",
            inputText: "hi",
            tail: [],
            tasks: [],
            allowedTargets: [],
            requester: {
              ownerId: "owner",
              principalId: "owner",
              displayName: "Owner",
              originKind: "goat",
              runtimeModeCeiling: "full-access",
              grantedScopes: [],
            },
          },
          modelSelection: createModelSelection(instanceId, "composer"),
        }),
      );
      expect(error.detail).toBe("This provider does not support channel reception.");
    }),
  );
});

const memoryFixture = (instanceId: ProviderInstanceId) => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
  const modelSelection = createModelSelection(instanceId, "pinned-model");
  const sourceThread = {
    environmentId: M.EnvironmentId.make("fixture-owner"),
    threadId: M.ThreadId.make(uuid(1)),
  };
  const sourceWatermark = {
    fromEventId: M.EventId.make(uuid(2)),
    toEventId: M.EventId.make(uuid(3)),
    throughSequence: 7,
  };
  const memorySpaceId = M.MemorySpaceId.make(uuid(4));
  const memoryId = M.MemoryId.make(uuid(5));
  const heads = [6, 7].map((n) => ({
    revision: {
      memorySpaceId,
      memoryId,
      revisionId: M.MemoryRevisionId.make(uuid(n)),
      operationId: M.MemoryOperationId.make(uuid(n + 10)),
      parents: [],
      scope: { kind: "user" as const },
      payloadRef: M.MemoryRevisionId.make(uuid(n)),
      assertionKind: "inference" as const,
      provenance: { environmentId: sourceThread.environmentId },
      createdAtUtc: "2026-10-14T00:00:00.000Z",
    },
    payload: { text: "ordinary fixture", evidence: [], derivedFromMemoryRevisions: [] },
  }));
  const summary: M.GenerateMemorySummaryInput = {
    cwd: "/isolated-fixture",
    sourceThread,
    sourceWatermark,
    messages: [{ messageId: M.MessageId.make(uuid(8)), text: "ordinary fixture", completed: true }],
    modelSelection,
  };
  const conflict: M.ResolveMemoryConflictInput = {
    cwd: summary.cwd,
    memorySpaceId,
    memoryId,
    conflictId: M.MemoryConflictId.make(uuid(9)),
    heads,
    modelSelection,
  };
  const execution: M.MemoryGenerationExecution = {
    requestedModelSelection: modelSelection,
    effectiveProvider: M.ProviderDriverKind.make("codex"),
    effectiveModel: "effective-alias",
    providerInstanceId: instanceId,
    environmentId: sourceThread.environmentId,
  };
  return { summary, conflict, execution };
};

describe("TextGeneration memory routing", () => {
  it.effect("routes both memory operations by pinned instance", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const fixtures = ["codex", "claude", "antigravity", "cursor", "grok", "opencode"].map(
        (name) => {
          const instanceId = ProviderInstanceId.make(`${name}-pinned`);
          return { name, instanceId, ...memoryFixture(instanceId) };
        },
      );
      const instances = fixtures.map((fixture) =>
        makeStubInstance(
          fixture.instanceId,
          makeStubTextGeneration({
            generateMemorySummary: (input) => {
              expect(input).toBe(fixture.summary);
              calls.push(`${fixture.name}:summary`);
              return Effect.succeed({
                result: { text: fixture.name, assertionKind: "inference", evidence: [] },
                execution: fixture.execution,
              });
            },
            resolveMemoryConflict: (input) => {
              expect(input).toBe(fixture.conflict);
              calls.push(`${fixture.name}:resolve`);
              return Effect.succeed({
                result: {
                  text: fixture.name,
                  judgment: "ordinary judgment",
                  assertionKind: "inference",
                  evidence: [],
                },
                execution: fixture.execution,
              });
            },
          }),
        ),
      );
      const generation = yield* TextGeneration.make.pipe(
        Effect.provideService(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          makeStubRegistry(instances),
        ),
        Effect.provide(
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("Memory routing must not resolve links"),
          }),
        ),
      );
      for (const fixture of fixtures) {
        const summary = yield* generation.generateMemorySummary!(fixture.summary);
        const conflict = yield* generation.resolveMemoryConflict!(fixture.conflict);
        expect(summary.result.text).toBe(fixture.name);
        expect(conflict.result.text).toBe(fixture.name);
        expect(summary.execution).toBe(fixture.execution);
        expect(conflict.execution).toBe(fixture.execution);
      }
      expect(calls).toEqual(fixtures.flatMap(({ name }) => [`${name}:summary`, `${name}:resolve`]));
    }),
  );
  it.effect("missing instance or operation has no fallback", () =>
    Effect.gen(function* () {
      let calls = 0;
      const available = ProviderInstanceId.make("available");
      const fixture = memoryFixture(available);
      const implemented = makeStubInstance(
        available,
        makeStubTextGeneration({
          generateMemorySummary: () => {
            calls++;
            return Effect.succeed({
              result: { text: "ordinary", assertionKind: "inference", evidence: [] },
              execution: fixture.execution,
            });
          },
          resolveMemoryConflict: () => {
            calls++;
            return Effect.succeed({
              result: {
                text: "ordinary",
                judgment: "ordinary",
                assertionKind: "inference",
                evidence: [],
              },
              execution: fixture.execution,
            });
          },
        }),
      );
      const missingMethod = ProviderInstanceId.make("missing-method");
      const generation = yield* TextGeneration.make.pipe(
        Effect.provideService(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          makeStubRegistry([
            implemented,
            makeStubInstance(missingMethod, makeStubTextGeneration({})),
          ]),
        ),
        Effect.provide(
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("Memory routing must not resolve links"),
          }),
        ),
      );
      for (const instanceId of [ProviderInstanceId.make("absent"), missingMethod]) {
        const inputs = memoryFixture(instanceId);
        const results = [
          yield* Effect.result(generation.generateMemorySummary!(inputs.summary)),
          yield* Effect.result(generation.resolveMemoryConflict!(inputs.conflict)),
        ];
        for (const result of results) {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("TextGenerationError");
            expect(result.failure.detail).toBe(
              instanceId === missingMethod ? "unsupported_operation" : "route_unavailable",
            );
          }
        }
      }
      expect(calls).toBe(0);
    }),
  );
});
