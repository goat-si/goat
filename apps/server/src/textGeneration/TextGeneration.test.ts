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
import * as ServerSettings from "../serverSettings.ts";
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
        Effect.provide(ServerSettings.layerTest()),
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
        Effect.provide(ServerSettings.layerTest()),
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
        expect(summary.result).not.toBeNull();
        expect(summary.result?.text).toBe(fixture.name);
        expect(conflict.result).not.toBeNull();
        expect(conflict.result?.text).toBe(fixture.name);
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
        Effect.provide(ServerSettings.layerTest()),
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
          yield* Effect.result(
            generation.generateMemorySummary!(inputs.summary).pipe(Effect.asVoid),
          ),
          yield* Effect.result(
            generation.resolveMemoryConflict!(inputs.conflict).pipe(Effect.asVoid),
          ),
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

const textProvider = (
  instanceId: ProviderInstanceId,
  driver: string,
  models: ReadonlyArray<{ readonly slug: string; readonly supportsTextGeneration?: false }>,
  supportsTextGeneration?: false,
): M.ServerProvider => ({
  instanceId,
  driver: M.ProviderDriverKind.make(driver),
  ...(supportsTextGeneration === undefined ? {} : { supportsTextGeneration }),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-16T00:00:00.000Z",
  models: models.map((model) => ({
    name: model.slug,
    isCustom: false,
    capabilities: null,
    ...model,
  })),
  slashCommands: [],
  skills: [],
});

const PI = ProviderInstanceId.make("pi");
const CODEX = ProviderInstanceId.make("codex");
const OMO = ProviderInstanceId.make("omo");

const capableSelectionHarness = (
  snapshots: ReadonlyArray<M.ServerProvider>,
  options: { readonly awaitingFirstCheck?: true } = {},
) => {
  const ran: Array<M.ModelSelection> = [];
  const instances = snapshots.map((snapshot) => ({
    ...makeStubInstance(
      snapshot.instanceId,
      makeStubTextGeneration({
        generateBranchName: (input) =>
          Effect.sync(() => {
            ran.push(input.modelSelection);
            return { branch: "feature/fallback" };
          }),
      }),
    ),
    driverKind: snapshot.driver,
    snapshot: {
      getSnapshot: Effect.succeed(snapshot),
      ...(options.awaitingFirstCheck ? { isAwaitingFirstCheck: Effect.succeed(true) } : {}),
    } as unknown as ProviderInstance["snapshot"],
  }));
  const generation = TextGeneration.make.pipe(
    Effect.provideService(
      ProviderInstanceRegistry.ProviderInstanceRegistry,
      makeStubRegistry(instances),
    ),
    Effect.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("branch names never resolve links"),
      }),
    ),
  );
  return { ran, generation };
};

const generateBranch = (
  generation: TextGeneration.TextGeneration["Service"],
  modelSelection: M.ModelSelection,
) => generation.generateBranchName({ cwd: "/tmp", message: "Add a model", modelSelection });

describe("TextGeneration model Settings no longer offers", () => {
  it.effect("moves a saved Pi extension model to Pi's default model", () =>
    Effect.gen(function* () {
      const { ran, generation } = capableSelectionHarness([
        textProvider(PI, "pi", [
          { slug: "default" },
          { slug: "demo/demo-model", supportsTextGeneration: false },
        ]),
      ]);
      yield* generateBranch(
        yield* generation.pipe(Effect.provide(ServerSettings.layerTest())),
        createModelSelection(PI, "demo/demo-model"),
      );
      expect(ran).toEqual([{ instanceId: PI, model: "default" }]);
    }),
  );

  it.effect("moves off a Pi whose whole listing is flagged to another capable provider", () =>
    Effect.gen(function* () {
      const { ran, generation } = capableSelectionHarness([
        textProvider(PI, "pi", [{ slug: "demo/demo-model", supportsTextGeneration: false }], false),
        textProvider(CODEX, "codex", [{ slug: M.DEFAULT_TEXT_GENERATION_MODEL }]),
      ]);
      yield* generateBranch(
        yield* generation.pipe(Effect.provide(ServerSettings.layerTest())),
        createModelSelection(PI, "demo/demo-model"),
      );
      expect(ran).toEqual([{ instanceId: CODEX, model: M.DEFAULT_TEXT_GENERATION_MODEL }]);
    }),
  );

  it.effect("uses Pi's documented default when no other provider can generate text", () =>
    Effect.gen(function* () {
      const { ran, generation } = capableSelectionHarness([
        textProvider(PI, "pi", [{ slug: "demo/demo-model", supportsTextGeneration: false }], false),
      ]);
      yield* generateBranch(
        yield* generation.pipe(Effect.provide(ServerSettings.layerTest())),
        createModelSelection(PI, "demo/demo-model"),
      );
      expect(ran).toEqual([{ instanceId: PI, model: "default" }]);
    }),
  );

  // OmO has no text generation default in the model tables; Settings shows its first listed model.
  it.effect.each([
    ["a flagged OmO model", OMO, false, false],
    ["OmO flagged as a whole with no other provider", OMO, true, false],
    ["Pi flagged as a whole with OmO the first capable fallback", PI, true, true],
  ] as const)("runs OmO's own default for %s", ([, saved, wholeListing, withOmoFallback]) =>
    Effect.gen(function* () {
      const flagged = [
        { slug: "default" },
        { slug: "demo/demo-model", supportsTextGeneration: false as const },
      ];
      const { ran, generation } = capableSelectionHarness([
        textProvider(
          saved,
          saved === OMO ? "omo" : "pi",
          flagged,
          wholeListing ? false : undefined,
        ),
        ...(withOmoFallback ? [textProvider(OMO, "omo", [{ slug: "default" }])] : []),
      ]);
      yield* generateBranch(
        yield* generation.pipe(Effect.provide(ServerSettings.layerTest())),
        createModelSelection(saved, "demo/demo-model"),
      );
      expect(ran).toEqual([{ instanceId: OMO, model: "default" }]);
    }),
  );

  it.effect("keeps the saved model when the status predates the flag or is not checked yet", () =>
    Effect.gen(function* () {
      const saved = createModelSelection(PI, "demo/demo-model");
      const older = capableSelectionHarness([
        textProvider(PI, "pi", [{ slug: "demo/demo-model" }]),
      ]);
      yield* generateBranch(
        yield* older.generation.pipe(Effect.provide(ServerSettings.layerTest())),
        saved,
      );
      const unchecked = capableSelectionHarness(
        [
          textProvider(
            PI,
            "pi",
            [{ slug: "demo/demo-model", supportsTextGeneration: false }],
            false,
          ),
        ],
        { awaitingFirstCheck: true },
      );
      yield* generateBranch(
        yield* unchecked.generation.pipe(Effect.provide(ServerSettings.layerTest())),
        saved,
      );
      expect([...older.ran, ...unchecked.ran]).toEqual([saved, saved]);
    }),
  );

  // goat_environment_settings_update stores the model through updateSettings without checking the list.
  it.effect("falls back from a flagged model an agent saved through the settings service", () =>
    Effect.gen(function* () {
      const { ran, generation } = capableSelectionHarness([
        textProvider(PI, "pi", [
          { slug: "default" },
          { slug: "demo/demo-model", supportsTextGeneration: false },
        ]),
      ]);
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          textGenerationModelSelection: createModelSelection(PI, "demo/demo-model"),
        });
        const saved = (yield* settings.getSettings).textGenerationModelSelection;
        expect(saved).toEqual(createModelSelection(PI, "demo/demo-model"));
        yield* generateBranch(yield* generation, saved);
      }).pipe(
        Effect.provide(
          ServerSettings.layerTest({
            providerInstances: { [PI]: { driver: M.ProviderDriverKind.make("pi"), enabled: true } },
          }),
        ),
      );
      expect(ran).toEqual([{ instanceId: PI, model: "default" }]);
    }),
  );
});
