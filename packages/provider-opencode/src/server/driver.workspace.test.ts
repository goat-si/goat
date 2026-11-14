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
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { OPENCODE_2_RESPONSES, OPENCODE_2_WORKSPACE_RESPONSES } from "./probeResponses.fixture.ts";
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
