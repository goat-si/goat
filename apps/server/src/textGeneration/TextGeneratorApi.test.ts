import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Logger from "effect/Logger";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, vi } from "vite-plus/test";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";

const instanceId = ProviderInstanceId.make("api-fixture");
const key = "test-secret-never-log-932";
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  textGenerators: {
    [instanceId]: {
      kind: "openaiCompatible" as const,
      label: "Fixture",
      baseUrl: "https://model.example/v1",
      apiKey: key,
      enabled: true,
    },
  },
};
const title = {
  cwd: "/unused",
  message: "repair login",
  linkedContext: "",
  modelSelection: { instanceId, model: "fixture-model" },
};
const services = Layer.mergeAll(
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: () => Effect.sync(() => undefined),
  }),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("no links"),
  }),
  Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.succeed(settings as never),
  }),
);

it.effect("uses the configured API generator for a thread title", () =>
  Effect.gen(function* () {
    using fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"title":"Repair login"}' } }],
      }),
    );
    const generation = yield* TextGeneration.make.pipe(Effect.provide(services));
    expect(yield* generation.generateThreadTitle(title)).toEqual({ title: "Repair login" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://model.example/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`);
    expect(init?.redirect).toBe("error");
    expect(String(init?.body)).toContain('"model":"fixture-model"');
  }),
);

it.effect("uses a key materialized from real settings storage for title generation", () =>
  Effect.gen(function* () {
    using fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"title":"Repair login"}' } }],
      }),
    );
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    yield* serverSettings.updateSettings({
      textGenerators: { [instanceId]: settings.textGenerators[instanceId]! },
      textGenerationModelSelection: title.modelSelection,
    });
    const generation = yield* TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ServerSettings.ServerSettingsService, serverSettings),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Effect.sync(() => undefined),
          }),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("no links"),
          }),
        ),
      ),
    );
    const current = yield* serverSettings.getSettings;
    expect(
      yield* generation.generateThreadTitle({
        ...title,
        modelSelection: current.textGenerationModelSelection,
      }),
    ).toEqual({ title: "Repair login" });
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("authorization")).toBe(
      `Bearer ${key}`,
    );
  }).pipe(
    Effect.provide(
      ServerSettings.layer.pipe(
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(Layer.fresh(Sqlite.layerMemory)),
        Layer.provideMerge(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-textgen-integration-" }),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("generates commit and pull request text through the configured model", () =>
  Effect.gen(function* () {
    using fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: '{"subject":"fix login","body":"Protect sessions"}' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: '{"title":"Fix login","body":"Protect sessions"}' },
            },
          ],
        }),
      );
    const generation = yield* TextGeneration.make.pipe(Effect.provide(services));
    const commit = yield* generation.generateCommitMessage({
      cwd: "/unused",
      branch: "work",
      stagedSummary: "changed",
      stagedPatch: "+change",
      modelSelection: title.modelSelection,
    });
    expect(commit.subject).toBe("fix login");
    const pr = yield* generation.generatePrContent({
      cwd: "/unused",
      baseBranch: "main",
      headBranch: "work",
      commitSummary: "changed",
      diffSummary: "changed",
      diffPatch: "+change",
      modelSelection: title.modelSelection,
    });
    expect(pr).toEqual({ title: "Fix login", body: "Protect sessions" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }),
);

it.effect("sends an Anthropic request without leaking the credential", () =>
  Effect.gen(function* () {
    using fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        stop_reason: "end_turn",
        content: [{ type: "text", text: '{"title":"Repair login"}' }],
      }),
    );
    const anthropic = {
      ...settings,
      textGenerators: {
        [instanceId]: { ...settings.textGenerators[instanceId], kind: "anthropic" as const },
      },
    };
    const service = TextGeneration.make.pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed(anthropic),
      } as never),
      Effect.provide(services),
    );
    const generation = yield* service;
    expect(yield* generation.generateThreadTitle(title)).toEqual({ title: "Repair login" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://model.example/v1/messages");
    expect(new Headers(init?.headers).get("x-api-key")).toBe(key);
    expect(init?.redirect).toBe("error");
  }),
);

it.effect("returns a sanitized API error through the caller's existing failure path", () =>
  Effect.gen(function* () {
    using fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ error: { message: key } }, { status: 401 }));
    const generation = yield* TextGeneration.make.pipe(Effect.provide(services));
    const error = yield* Effect.flip(generation.generateThreadTitle(title));
    expect(error._tag).toBe("TextGenerationError");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error.detail).toBe("The configured model API could not generate text.");
    expect(JSON.stringify(error)).not.toContain(key);
    const logs: unknown[] = [];
    yield* Effect.logWarning("Thread title generation failed", { cause: error }).pipe(
      Effect.provide(
        Logger.layer(
          [
            Logger.make((entry) => {
              logs.push(entry);
            }),
          ],
          { mergeWithExisting: false },
        ),
      ),
    );
    expect(JSON.stringify(logs)).not.toContain(key);
  }),
);

it.effect("rejects oversized streamed API replies", () =>
  Effect.gen(function* () {
    using _fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            controller.enqueue(new Uint8Array(1024 * 1024));
            controller.close();
          },
        }),
      ),
    );
    const generation = yield* TextGeneration.make.pipe(Effect.provide(services));
    const error = yield* Effect.flip(generation.generateThreadTitle(title));
    expect(error._tag).toBe("TextGenerationError");
    expect(JSON.stringify(error)).not.toContain(key);
  }),
);

it.effect("bounds concurrent model API requests without a waiting queue", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = Promise.withResolvers<void>();
    yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
    let count = 0;
    using fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (++count === 8) Deferred.doneUnsafe(started, Effect.void);
      await release.promise;
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"title":"Repair login"}' } }],
      });
    });
    const generation = yield* TextGeneration.make.pipe(Effect.provide(services));
    const running = yield* Effect.forEach(Array.from({ length: 8 }), () =>
      generation.generateThreadTitle(title).pipe(Effect.forkChild),
    );
    yield* Deferred.await(started);
    const refused = yield* Effect.flip(generation.generateThreadTitle(title));
    expect(refused._tag).toBe("TextGenerationError");
    expect(fetchMock).toHaveBeenCalledTimes(8);
    release.resolve();
    yield* Effect.forEach(running, Fiber.join);
  }).pipe(Effect.scoped),
);

it.effect("times out and aborts a stalled model API request", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let aborted = false;
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
          Deferred.doneUnsafe(started, Effect.void);
        }),
    );
    const generation = yield* TextGeneration.make.pipe(Effect.provide(services));
    const fiber = yield* generation.generateThreadTitle(title).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("120 seconds");
    const error = yield* Fiber.join(fiber);
    expect(error._tag).toBe("TextGenerationError");
    expect(aborted).toBe(true);
  }),
);
