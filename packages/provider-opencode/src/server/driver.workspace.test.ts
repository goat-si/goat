// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import type { OpenCodeSettings } from "../settings.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import {
  OPENCODE_2_RESPONSES,
  OPENCODE_2_WORKSPACE_RESPONSES,
  replayOpenCodeServer,
} from "./probeResponses.fixture.ts";
import { noHttp } from "./driver.testkit.ts";
import { OpenCodeDriver } from "./driver.ts";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
const serverStarts: Array<string> = [];
const reachedServer = (operation: string) =>
  Effect.sync(() => serverStarts.push(operation)).pipe(
    Effect.andThen(
      Effect.fail(
        new OpenCodeRuntime.OpenCodeRuntimeError({
          operation,
          detail: "reached a 1.x server path",
        }),
      ),
    ),
  );
const openCode2Runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "opencode v2.0.18\n", stderr: "", code: 0 }),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(HostProcess.HomeDirectory, "/fixture/opencode-test"),
  Layer.succeed(HostProcess.Environment, {
    HOME: "/fixture/opencode-test",
    XDG_DATA_HOME: "/fixture/opencode-test",
    PATH: [NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(NodePath.delimiter),
  }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, openCode2Runtime),
).pipe(Layer.provideMerge(NodeServices.layer));

const create = (config: Partial<OpenCodeSettings>, http: HttpClient.HttpClient) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode-test"),
    displayName: undefined,
    environment: [],
    enabled: true,
    config: { ...OpenCodeDriver.defaultConfig(), ...config },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

it.layer(layer)("OpenCode workspace scan", (it) => {
  it.effect("caches a cold OpenCode 2 directory's skills only after its scan ends", () =>
    Effect.gen(function* () {
      // OpenCode 2.2.7: touching a location lists it as loaded with built-in commands and skills
      // at once, while provider.list waits for the scan that adds the project's skills.
      const scanEnded = yield* Deferred.make<void>();
      const builtinSkills = JSON.stringify({
        location: { directory: "/work" },
        data: (
          JSON.parse(OPENCODE_2_WORKSPACE_RESPONSES["/api/skill"].body).data as Array<{
            id: string;
          }>
        ).filter((skill) => skill.id !== "plum"),
      });
      const http = HttpClient.make((request) => {
        const path = new URL(request.url).pathname;
        const json = (body: string) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(JSON.parse(body))));
        const afterScan = (body: string) =>
          Deferred.await(scanEnded).pipe(Effect.andThen(json(body)));
        switch (path) {
          case "/api/info":
            return json(
              JSON.stringify({
                ...JSON.parse(OPENCODE_2_RESPONSES["/api/info"].body),
                version: "2.2.7",
              }),
            );
          case "/api/event":
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(new ReadableStream(), {
                  headers: { "content-type": "text/event-stream" },
                }),
              ),
            );
          case "/api/debug/location":
            return json('[{"directory":"/work"}]');
          case "/api/provider":
          case "/api/model":
            return afterScan('{"location":{"directory":"/work"},"data":[]}');
          case "/api/command":
            return json(OPENCODE_2_WORKSPACE_RESPONSES["/api/command"].body);
          case "/api/skill":
            return Deferred.isDone(scanEnded).pipe(
              Effect.flatMap((done) =>
                json(done ? OPENCODE_2_WORKSPACE_RESPONSES["/api/skill"].body : builtinSkills),
              ),
            );
          default:
            return Effect.die(`Unexpected request: ${path}`);
        }
      });
      const instance = yield* create({ serverUrl: "http://127.0.0.1:4096" }, http);

      const snapshot = yield* instance.snapshotForCwd!("/work").pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(scanEnded, undefined);
      yield* TestClock.adjust("30 seconds");
      const { skills } = yield* Fiber.join(snapshot);
      assert.include(
        skills.map((skill) => skill.name),
        "plum",
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

const openCode2Project = "/work/project-with-config";
const openCode2Model = (providerID: string, id: string, name: string) => ({
  id,
  modelID: id,
  providerID,
  name,
  package: "@opencode/ai/providers/openai-compatible",
  settings: {},
  compatibility: {},
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  time: { released: 1789516800000 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: "active",
  enabled: true,
  limit: { context: 1000000, output: 65536 },
});
// Serves one machine catalog everywhere plus extra models for the project directory.
const makeOpenCode2ProjectInstance = (
  projectCatalog: "listed" | "models-unavailable" | "providers-unavailable",
) =>
  Effect.gen(function* () {
    const machineModels = [openCode2Model("opencode", "big-pickle", "Big Pickle")];
    const projectModels = [
      ...machineModels,
      openCode2Model("uni", "medium-gpt", "Medium GPT"),
      openCode2Model("uni", "large-gpt", "Large GPT"),
    ];
    const replay = replayOpenCodeServer(
      { ...OPENCODE_2_RESPONSES, ...OPENCODE_2_WORKSPACE_RESPONSES },
      "secret",
    );
    const server = HttpClient.make((request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname !== "/api/model" && pathname !== "/api/provider") {
        return replay.execute(request);
      }
      const directory = Option.getOrUndefined(
        UrlParams.getFirst(request.urlParams, "location[directory]"),
      );
      const isProject = directory === openCode2Project;
      const data = pathname === "/api/provider" ? [] : isProject ? projectModels : machineModels;
      const unavailable =
        isProject &&
        ((pathname === "/api/model" && projectCatalog === "models-unavailable") ||
          (pathname === "/api/provider" && projectCatalog === "providers-unavailable"));
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ location: { directory }, data }), {
            status: unavailable ? 503 : 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });
    const instance = yield* create(
      { serverUrl: "http://127.0.0.1:4096", serverPassword: "secret" },
      server,
    );
    const ready = yield* instance.snapshot.streamChanges.pipe(
      Stream.filter((snapshot) => snapshot.status === "ready"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(ready);
    // Catalog reads repeat until two agree, so let them settle on the test clock.
    return (cwd: string) =>
      Effect.gen(function* () {
        const read = yield* Effect.forkChild(instance.snapshotForCwd!(cwd));
        yield* TestClock.adjust("5 seconds");
        return yield* Fiber.join(read);
      });
  });

it.layer(layer)("OpenCode 2 project models", (it) => {
  it.effect("lists a project's own opencode.jsonc models in that project's snapshot", () =>
    Effect.gen(function* () {
      const snapshotFor = yield* makeOpenCode2ProjectInstance("listed");

      const projectSnapshot = yield* snapshotFor(openCode2Project);
      assert.deepStrictEqual(projectSnapshot.models.map((entry) => entry.slug).toSorted(), [
        "opencode/big-pickle",
        "uni/large-gpt",
        "uni/medium-gpt",
      ]);
      const otherSnapshot = yield* snapshotFor("/work/other-project");
      assert.deepStrictEqual(
        otherSnapshot.models.map((entry) => entry.slug),
        ["opencode/big-pickle"],
      );
      assert.strictEqual(otherSnapshot.workspaceModels, undefined);
      assert.strictEqual(otherSnapshot.workspaceModelsPending, undefined);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect.each(["models-unavailable", "providers-unavailable"] as const)(
    "reports a project's catalog unknown when its read fails (%s)",
    (projectCatalog) =>
      Effect.gen(function* () {
        const snapshotFor = yield* makeOpenCode2ProjectInstance(projectCatalog);

        const projectSnapshot = yield* snapshotFor(openCode2Project);
        assert.deepStrictEqual(
          projectSnapshot.models.map((entry) => entry.slug),
          ["opencode/big-pickle"],
        );
        assert.strictEqual(projectSnapshot.workspaceModels, undefined);
        assert.strictEqual(projectSnapshot.workspaceModelsPending, true);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

const openCode1Provider = (id: string, models: ReadonlyArray<string>) => ({
  id,
  name: id,
  models: Object.fromEntries(
    models.map((model) => [model, { id: model, name: model, release_date: "2026-01-01" }]),
  ),
});
const openCode1Project = "/work/project-with-config";
const openCode1UnreadableProject = "/work/unreadable-project";
const openCode1Providers = (directory: string) => {
  const all = [
    openCode1Provider("opencode", ["big-pickle"]),
    ...(directory === openCode1Project ? [openCode1Provider("uni", ["medium-gpt"])] : []),
  ];
  return { all, connected: all.map((provider) => provider.id), default: {} };
};
const openCode1Runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "1.18.18\n", stderr: "", code: 0 }),
  startOpenCodeServerProcess: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4096",
      version: "1.18.18",
      isRunning: Effect.succeed(true),
      exitCode: Effect.never,
    }),
  createOpenCodeSdkClient: ({ directory }: { readonly directory: string }) => ({
    provider: {
      list: () =>
        directory === openCode1UnreadableProject
          ? Promise.reject(new Error("provider list failed"))
          : Promise.resolve({ data: openCode1Providers(directory) }),
    },
    app: { agents: () => Promise.resolve({ data: [] }) },
    command: { list: () => Promise.resolve({ data: [] }) },
  }),
  loadOpenCodeInventory: () =>
    Effect.succeed({ providerList: openCode1Providers("/machine"), agents: [], skills: [] }),
  loadOpenCodeSkills: () => Effect.succeed([]),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

it.layer(Layer.mergeAll(layer, Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, openCode1Runtime)))(
  "OpenCodeDriver on OpenCode 1",
  (it) => {
    it.effect("lists a project's own opencode.jsonc models in that project's snapshot", () =>
      Effect.gen(function* () {
        const instance = yield* create({}, noHttp);
        const ready = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.status === "ready"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Fiber.join(ready);
        const slugsOf = (snapshot: { readonly models: ReadonlyArray<{ readonly slug: string }> }) =>
          snapshot.models.map((model) => model.slug).toSorted();

        assert.deepStrictEqual(slugsOf(yield* instance.snapshotForCwd!(openCode1Project)), [
          "opencode/big-pickle",
          "uni/medium-gpt",
        ]);
        const otherSnapshot = yield* instance.snapshotForCwd!("/work/other-project");
        assert.deepStrictEqual(slugsOf(otherSnapshot), ["opencode/big-pickle"]);
        assert.strictEqual(otherSnapshot.workspaceModels, undefined);
        assert.strictEqual(otherSnapshot.workspaceModelsPending, undefined);
        const unreadable = yield* instance.snapshotForCwd!(openCode1UnreadableProject);
        assert.deepStrictEqual(slugsOf(unreadable), ["opencode/big-pickle"]);
        assert.strictEqual(unreadable.workspaceModels, undefined);
        assert.strictEqual(unreadable.workspaceModelsPending, true);
      }).pipe(Effect.scoped),
    );
  },
);
