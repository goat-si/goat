import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type TextGenerationError,
} from "@goat/contracts";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { writeFakeCli } from "@goat/provider-testing/fakeCli";
import { createModelSelection } from "@goat/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Routes from "../provider/CodexRouteService.ts";
import {
  caller,
  commitAndApply,
  instanceId,
  layer as routeLayer,
} from "../provider/CodexRouteService.testkit.ts";
import * as HomeRoute from "../provider/OpenCodexRoute.ts";
import { fixture } from "../provider/OpenCodexRoute.testkit.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";

const decode = Schema.decodeSync(CodexSettings);
const decodeLaunches = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      config: Schema.Record(Schema.String, Schema.Unknown),
      home: Schema.optional(Schema.String),
    }),
  ),
);
/** Fake Codex that applies GOAT's -c overrides; an invalid config reports another provider. */
const writeFakeCodex = (input: {
  readonly home: string;
  readonly log: string;
  readonly version: string;
  readonly validConfig: boolean;
  readonly output: unknown;
}) =>
  writeFakeCli({
    directory: input.home + "/bin",
    name: "codex",
    source: [
      'import fs from "node:fs";',
      'import readline from "node:readline";',
      `import { parse } from ${JSON.stringify(import.meta.resolve("smol-toml"))};`,
      "const args = process.argv.slice(2);",
      "const config = {};",
      'args.forEach((arg, index) => { if ((args[index - 1] === "-c" || args[index - 1] === "--config") && /^(model_provider|openai_base_url|model_providers\\.opencodex|model_catalog_json)=/.test(arg)) Object.assign(config, parse(arg)); });',
      'const kind = args.includes("app-server") ? "app-server" : args.includes("mcp") ? "mcp" : args[0];',
      `fs.appendFileSync(${JSON.stringify(input.log)}, JSON.stringify({ kind, config, home: process.env.CODEX_HOME }) + "\\n");`,
      'if (kind === "app-server") {',
      '  readline.createInterface({ input: process.stdin }).on("line", (line) => {',
      "    const { id, method } = JSON.parse(line);",
      "    if (id === undefined) return;",
      `    const result = method === "initialize" ? { userAgent: ${JSON.stringify(`codex/${input.version}`)}, codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" } : { config: ${input.validConfig ? "config" : '{ ...config, model_provider: "hostile" }'}, origins: {} };`,
      '    process.stdout.write(JSON.stringify({ id, result }) + "\\n");',
      "  });",
      '} else if (kind === "mcp") process.stdout.write("[]");',
      'else if (kind === "exec") {',
      "  for await (const _ of process.stdin) {}",
      `  fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], ${JSON.stringify(JSON.stringify(input.output))});`,
      "}",
    ].join("\n"),
  });
const cases = [
  { opencodexAuth: "openai", version: "0.156.1", validConfig: true, reception: false },
  { opencodexAuth: "none", version: "0.156.1", validConfig: true, reception: false },
  { opencodexAuth: "none", version: "0.999.0", validConfig: true, reception: false },
  { opencodexAuth: "openai", version: "0.156.1", validConfig: false, reception: false },
  { opencodexAuth: "none", version: "0.156.1", validConfig: false, reception: false },
  { opencodexAuth: "none", version: "0.156.1", validConfig: true, reception: true },
] as const;
it.live.each(cases)(
  "runs Home $opencodexAuth text generation only after verifying the effective config (version $version, valid $validConfig, reception $reception)",
  ({ opencodexAuth, version, validConfig, reception }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const route = yield* fixture();
      const home = route.input.execution.home;
      const log = home + "/launches.jsonl";
      const output = reception
        ? {
            replyText: "On it.",
            action: "create_task",
            title: "Fixture task",
            instruction: "Run the fixture",
            projectId: "project-1",
            host: "",
            taskId: "",
            questionId: "",
            answer: "",
            question: "",
            options: [],
            reads: [],
            remember: "",
            rememberQuote: "",
            notesChangeRequested: "",
            additionalTasks: [],
            clarifyAbout: "other",
          }
        : { title: "Home title" };
      const binary = writeFakeCodex({ home, log, version, validConfig, output });
      const guardedFs = {
        ...fs,
        exists: (filename: string) =>
          filename.endsWith("auth.json")
            ? Effect.die("Authless reception must not inspect local credentials")
            : fs.exists(filename),
      };
      const generation = yield* makeCodexTextGeneration(
        decode({ ...route.input.settings, binaryPath: binary, opencodexAuth }),
        { PATH: process.env.PATH },
      ).pipe(
        Effect.provideService(HomeRoute.OpenCodexRoute, route.service),
        Effect.provideService(FileSystem.FileSystem, reception ? guardedFs : fs),
      );
      const modelSelection = createModelSelection(ProviderInstanceId.make("codex"), "home-model");
      const generateReception = generation.generateChannelReception;
      if (generateReception === undefined) throw new Error("Codex reception unavailable");
      const request: Effect.Effect<unknown, TextGenerationError> = reception
        ? generateReception({
            cwd: route.input.execution.cwd,
            modelSelection,
            input: {
              mode: "input",
              conversationId: "fixture-conversation" as never,
              originKind: "slack",
              inputText: "Run the fixture",
              tail: [],
              tasks: [],
              allowedTargets: [{ projectId: "project-1" as never, label: "Fixture" }],
              requester: {
                ownerId: "owner",
                principalId: "owner",
                displayName: "Fixture",
                originKind: "slack",
                runtimeModeCeiling: "full-access",
                grantedScopes: ["orchestration:operate"],
              },
            },
          })
        : generation.generateThreadTitle({
            cwd: route.input.execution.cwd,
            message: "Name the work",
            modelSelection,
          });
      const result = yield* Effect.result(request);
      const launches = (yield* fs.exists(log))
        ? decodeLaunches(
            (yield* fs.readFileString(log))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          )
        : [];
      const execs = launches.filter((launch) => launch.kind === "exec");
      if (!validConfig) {
        assert.equal(result._tag, "Failure");
        assert.deepStrictEqual(execs, []);
        return;
      }
      assert.equal(result._tag, "Success", result._tag === "Failure" ? result.failure.message : "");
      assert.equal(execs.length, 1);
      const exec = execs[0]!;
      assert.equal(exec.config.model_provider, opencodexAuth === "none" ? "opencodex" : "openai");
      if (opencodexAuth === "none")
        assert.deepStrictEqual(exec.config.model_providers, {
          opencodex: {
            name: "OpenCodex",
            base_url: route.input.settings.opencodexBaseUrl,
            wire_api: "responses",
            requires_openai_auth: false,
          },
        });
      else assert.equal(exec.config.openai_base_url, route.input.settings.opencodexBaseUrl);
      assert.equal(exec.config.model_catalog_json, route.catalog);
      if (reception) assert.notEqual(exec.home, home);
    }).pipe(
      Effect.provide(
        Config.layerTest(process.cwd(), { prefix: "codex-home-generation-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

const codexDriver = ProviderDriverKind.make("codex");
/** The settings result of an admission, or "committed" if it got past the fence. */
const admission = <E>(mutation: Effect.Effect<unknown, E, Settings.ServerSettingsService>) =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const state = yield* Routes.CodexRouteState;
    const changes = yield* settings.subscribeProviderChanges!;
    const baseline = state.revision();
    const fiber = yield* mutation.pipe(Effect.result, Effect.forkScoped);
    return yield* Effect.raceFirst(
      Fiber.join(fiber),
      Stream.runHead(
        changes.pipe(Stream.filter((event) => event.revision.sequence > baseline.sequence)),
      ).pipe(Effect.as("committed" as const)),
    );
  });
const fenceWorld = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const route = yield* fixture();
  const home = route.input.execution.home;
  const log = home + "/launches.jsonl";
  const binary = writeFakeCodex({
    home,
    log,
    version: "0.156.1",
    validConfig: true,
    output: { title: "Home title" },
  });
  const settings = yield* Settings.ServerSettingsService;
  yield* settings.start;
  const routes = yield* Routes.CodexRouteService;
  const config = {
    modelRoute: "opencodex",
    opencodexAuth: "openai",
    opencodexBaseUrl: route.input.settings.opencodexBaseUrl,
    homePath: home,
    binaryPath: binary,
  } as const;
  const upsert = (opencodexAuth: "openai" | "none") =>
    routes.mutateProviderInstance(
      {
        mutation: {
          operation: "upsert",
          instanceId,
          instance: { driver: codexDriver, config: { ...config, opencodexAuth } },
        },
      },
      caller,
    );
  yield* commitAndApply(upsert("openai"));
  const generate = (getModels: Effect.Effect<ReadonlyArray<never>>) =>
    makeCodexTextGeneration(decode(config), { PATH: process.env.PATH }, getModels, undefined, {
      providerInstanceId: instanceId,
    }).pipe(
      Effect.provideService(HomeRoute.OpenCodexRoute, route.service),
      Effect.map((generation) =>
        generation.generateThreadTitle({
          cwd: route.input.execution.cwd,
          message: "Name the work",
          modelSelection: createModelSelection(instanceId, "home-model"),
        }),
      ),
    );
  const execs = fs.exists(log).pipe(
    Effect.flatMap((exists) => (exists ? fs.readFileString(log) : Effect.succeed(""))),
    Effect.map((text) => text.split("\n").filter((line) => line.includes('"kind":"exec"')).length),
  );
  return { upsert, generate, execs };
});
const fenceLayer = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    return ProviderHost.ProviderHost.of({
      paths: { cwd: "", baseDir: "", stateDir: "", providerStatusCacheDir: "", attachmentsDir: "" },
      settings: {
        get: settings.getSettings,
        withSnapshot: settings.withSettingsSnapshot,
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(false),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("unused"),
    });
  }),
).pipe(Layer.provideMerge(routeLayer));
it.live("holds the instance's route lease from its settings until Codex exits", () =>
  Effect.gen(function* () {
    const world = yield* fenceWorld;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const request = yield* world.generate(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as([]),
      ),
    );
    const generation = yield* request.pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const busy = yield* admission(world.upsert("none"));
    assert.notEqual(busy, "committed", "an auth change must not commit while Codex runs");
    if (busy !== "committed") {
      assert.equal(busy._tag, "Failure");
      if (busy._tag === "Failure") assert.equal(busy.failure.code, "provider_instance_busy");
    }
    yield* Deferred.succeed(release, undefined);
    assert.equal((yield* Fiber.join(generation)).title, "Home title");
    const saved = yield* commitAndApply(world.upsert("none"));
    assert.equal(decode(saved.providerInstances[instanceId]?.config ?? {}).opencodexAuth, "none");
  }).pipe(Effect.scoped, Effect.provide(fenceLayer)),
);
it.live("does not start Codex with route settings older than an admitted change", () =>
  Effect.gen(function* () {
    const world = yield* fenceWorld;
    const request = yield* world.generate(Effect.succeed([]));
    yield* commitAndApply(world.upsert("none"));
    const result = yield* request.pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.include(result.failure.message, "settings changed");
    assert.equal(yield* world.execs, 0);
  }).pipe(Effect.scoped, Effect.provide(fenceLayer)),
);
