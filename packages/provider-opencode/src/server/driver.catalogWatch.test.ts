// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import type { OpenCodeSettings } from "../settings.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { OpenCodeDriver } from "./driver.ts";
import { reachedServer } from "./driver.testkit.ts";
import {
  OPENCODE_2_RESPONSES,
  OPENCODE_2_SKILL_EVENTS,
  OPENCODE_2_WORKSPACE_RESPONSES,
} from "./probeResponses.fixture.ts";

const openCode2Runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "opencode v2.0.18\n", stderr: "", code: 0 }),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

const openCode2Model = (providerID: string, id: string, name: string) => ({
  id,
  providerID,
  name,
  family: id,
  status: "active",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: [],
  limit: { context: 128_000, output: 8_192 },
  variants: [],
  time: { released: "2026-01-01" },
});

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
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const create = (config: Partial<OpenCodeSettings>, http: HttpClient.HttpClient) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode-test"),
    displayName: undefined,
    environment: [],
    enabled: true,
    config: { ...OpenCodeDriver.defaultConfig(), ...config },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

// A managed OpenCode 2 whose config can change while no server runs. Each start gets its own
// port, and stopping a server ends its event streams.
const makeIdlingOpenCode2Instance = Effect.gen(function* () {
  const subscribed = yield* Deferred.make<void>();
  const catalogs = { machine: [openCode2Model("opencode", "big-pickle", "Big Pickle")] };
  const servers: Array<{
    running: boolean;
    readonly streams: Set<ReadableStreamDefaultController>;
  }> = [];
  const http = HttpClient.make((request) => {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
    const server = servers[Number(url.port) - 4096];
    if (!server?.running) return json({ _tag: "InternalServerError", message: "stopped" }, 503);
    switch (url.pathname) {
      case "/api/info":
        return json(JSON.parse(OPENCODE_2_RESPONSES["/api/info"].body));
      case "/api/event":
        return Deferred.succeed(subscribed, undefined).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(new ReadableStream({ start: (stream) => server.streams.add(stream) }), {
                headers: { "content-type": "text/event-stream" },
              }),
            ),
          ),
        );
      case "/api/model":
      case "/api/provider":
        return json({
          location: { directory: "/work" },
          data: url.pathname === "/api/provider" ? [] : catalogs.machine,
        });
      default:
        return json({ _tag: "NotFoundError", message: "not found" }, 404);
    }
  });
  const runtime = {
    ...openCode2Runtime,
    startOpenCodeServerProcess: ({
      verify,
    }: Parameters<OpenCodeRuntime.OpenCodeRuntime["Service"]["startOpenCodeServerProcess"]>[0]) =>
      Effect.gen(function* () {
        const server = { running: true, streams: new Set<ReadableStreamDefaultController>() };
        const url = `http://127.0.0.1:${4096 + servers.length}`;
        servers.push(server);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.running = false;
            for (const stream of server.streams) {
              try {
                stream.close();
              } catch {}
            }
          }),
        );
        const version = verify ? yield* verify(url) : "2.0.18";
        return {
          url,
          version,
          isRunning: Effect.sync(() => server.running),
          exitCode: Effect.never,
        };
      }),
  };
  const instance = yield* create({}, http).pipe(
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
  );
  const ready = yield* instance.snapshot.streamChanges.pipe(
    Stream.filter((snapshot) => snapshot.status === "ready"),
    Stream.take(1),
    Stream.runCollect,
    Effect.forkChild,
  );
  // The catalog's settle delay starts only after its first HTTP read; the first event
  // subscription is a request that follows that read.
  yield* Deferred.await(subscribed);
  yield* TestClock.adjust("5 seconds");
  yield* Fiber.join(ready);
  return {
    instance,
    catalogs,
    servers,
    // Text generation borrows a server without reading the catalog. The fake has no session
    // API, so the generation fails once it has borrowed the server.
    borrowWithoutCatalogRead: instance.textGeneration
      .generateThreadTitle({
        cwd: "/work",
        message: "Rename the thread",
        modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
      })
      .pipe(Effect.ignore, Effect.andThen(TestClock.adjust("5 seconds"))),
    // The managed server stops 30 seconds after its last borrower.
    idleOut: TestClock.adjust("31 seconds"),
  };
});

it.layer(layer)("OpenCodeDriver catalog watch", (it) => {
  it.effect("lists models added to OpenCode's config while its managed server was stopped", () =>
    Effect.gen(function* () {
      const { instance, catalogs, servers, borrowWithoutCatalogRead, idleOut } =
        yield* makeIdlingOpenCode2Instance;
      assert.deepStrictEqual(
        (yield* instance.snapshot.getSnapshot).models.map((model) => model.slug),
        ["opencode/big-pickle"],
      );

      yield* idleOut;
      assert.isFalse(servers[0]?.running);
      catalogs.machine = [...catalogs.machine, openCode2Model("uni", "medium-gpt", "Medium GPT")];
      const relisted = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models.length > 1),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* borrowWithoutCatalogRead;
      assert.strictEqual(servers.length, 2, "the borrow starts a fresh server");

      const [snapshot] = Array.from(yield* Fiber.join(relisted));
      assert.deepStrictEqual(snapshot?.models.map((model) => model.slug).toSorted(), [
        "opencode/big-pickle",
        "uni/medium-gpt",
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  // OpenCode 2.4.2 announces a skill that appears after a location's scan with another
  // skill.updated: a SKILL.md written while GOAT is open, or an MCP server's skills once it connects.
  const makeLateSkillServer = Effect.gen(function* () {
    let skillsRead = yield* Deferred.make<void>();
    let skillAdded = false;
    const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const send = (event: string, directory: string) =>
      Effect.sync(() => {
        const data = event.replace(
          '"directory":"/work"',
          `"directory":${JSON.stringify(directory)}`,
        );
        const frame = new TextEncoder().encode(`data: ${data}\n\n`);
        for (const stream of streams) {
          try {
            stream.enqueue(frame);
          } catch {
            streams.delete(stream);
          }
        }
      });
    const listed = JSON.parse(OPENCODE_2_WORKSPACE_RESPONSES["/api/skill"].body);
    const lateSkill = {
      id: "review",
      name: "review",
      description: "Review the current diff",
      path: "/work/.opencode/skills/review/SKILL.md",
      content: "Review the diff.",
    };
    const http = HttpClient.make((request) => {
      const path = new URL(request.url).pathname;
      const json = (body: unknown) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
      switch (path) {
        case "/api/info":
          return json(JSON.parse(OPENCODE_2_RESPONSES["/api/info"].body));
        case "/api/event":
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(new ReadableStream({ start: (stream) => streams.add(stream) }), {
                headers: { "content-type": "text/event-stream" },
              }),
            ),
          );
        case "/api/debug/location":
          return json([]);
        case "/api/provider":
        case "/api/model":
          return json({ location: { directory: "/work" }, data: [] });
        case "/api/command":
          return json(JSON.parse(OPENCODE_2_WORKSPACE_RESPONSES["/api/command"].body));
        case "/api/skill":
          return Deferred.succeed(skillsRead, undefined).pipe(
            Effect.andThen(
              json(skillAdded ? { ...listed, data: [...listed.data, lateSkill] } : listed),
            ),
          );
        default:
          return Effect.die(`Unexpected request: ${path}`);
      }
    });
    const instance = yield* create({ serverUrl: "http://127.0.0.1:4096" }, http);
    const skillNames = (cwd: string) =>
      Effect.gen(function* () {
        const read = yield* instance.snapshotForCwd!(cwd).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        return (yield* Fiber.join(read)).skills.map((skill) => skill.name);
      });
    return {
      skillNames,
      /** Opens a project OpenCode has not loaded: GOAT reads, then OpenCode ends the scan. */
      open: (cwd: string) =>
        Effect.gen(function* () {
          skillsRead = yield* Deferred.make<void>();
          const read = yield* instance.snapshotForCwd!(cwd).pipe(Effect.forkChild);
          yield* Deferred.await(skillsRead);
          yield* send(OPENCODE_2_SKILL_EVENTS.scanCommands, cwd);
          yield* send(OPENCODE_2_SKILL_EVENTS.scanSkills, cwd);
          yield* TestClock.adjust("10 seconds");
          return (yield* Fiber.join(read)).skills.map((skill) => skill.name);
        }),
      /** A skill appears in OpenCode; returns the first cwd GOAT is asked to rescan, if any. */
      addSkill: (cwd: string) =>
        Effect.gen(function* () {
          const leftover = yield* instance.workspaceRescans!.pipe(
            Stream.runHead,
            Effect.timeoutOption("1 second"),
            Effect.forkChild,
          );
          yield* TestClock.adjust("1 second");
          assert.deepStrictEqual(yield* Fiber.join(leftover), Option.none());
          const rescan = yield* instance.workspaceRescans!.pipe(
            Stream.runHead,
            Effect.timeoutOption("5 seconds"),
            Effect.forkChild,
          );
          skillAdded = true;
          yield* send(OPENCODE_2_SKILL_EVENTS.skillAdded, cwd);
          yield* TestClock.adjust("5 seconds");
          return Option.flatten(yield* Fiber.join(rescan));
        }),
      dropEvents: Effect.sync(() => {
        for (const stream of streams) stream.error(new TypeError("network connection lost"));
        streams.clear();
      }).pipe(Effect.andThen(TestClock.adjust("1 second"))),
    };
  });

  it.effect("rescans a directory when OpenCode adds a skill after its scan", () =>
    Effect.gen(function* () {
      const server = yield* makeLateSkillServer;
      assert.notInclude(yield* server.open("/work"), "review");

      assert.deepStrictEqual(yield* server.addSkill("/work"), Option.some("/work"));
      assert.include(yield* server.skillNames("/work"), "review");
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("rescans for a skill added after the server's event stream drops", () =>
    Effect.gen(function* () {
      const server = yield* makeLateSkillServer;
      yield* server.open("/work");
      yield* server.dropEvents;
      yield* server.open("/work/other");

      assert.deepStrictEqual(yield* server.addSkill("/work/other"), Option.some("/work/other"));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
