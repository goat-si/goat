import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as HomeRoute from "./OpenCodexRoute.ts";
import { fixture } from "./OpenCodexRoute.testkit.ts";
const isRouteUnavailable = Schema.is(HomeRoute.OpenCodexRouteUnavailable);
it.effect.each(["missing", "changed"])(
  "accepts a source-derived disconnected Home with %s client credentials through actual route verification",
  (credential) =>
    Effect.gen(function* () {
      const { service, input, catalog, calls, reads } = yield* fixture({
        role: "home",
        credential,
      });
      assert.equal((yield* service.inspect(input)).state, "home");
      yield* HomeRoute.verifyEffectiveCodexRoute(
        input,
        {
          model_provider: "openai",
          openai_base_url: input.settings.opencodexBaseUrl,
          model_catalog_json: catalog,
        },
        catalog,
      );
      assert.isTrue(calls.includes("ocx link status --json"));
      assert.isFalse(reads.some((name) => /token|credential|auth\.json/.test(name)));
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("does not promote the real K16 client-role fallback to Home", () =>
  Effect.gen(function* () {
    const { service, input, calls } = yield* fixture({ role: "client", linkRole: "home" });
    assert.equal((yield* service.inspect(input)).state, "connected");
    assert.isFalse(calls.includes("ocx link status --json"));
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each([
  { modelsStatus: 503, expected: "reconnecting" },
  { modelsStatus: 401, expected: "failed" },
  { ready: "pending", expected: "reconnecting" },
  { cliPid: 998, expected: "failed" },
])(
  "requires matching Child health readiness models and catalog for connected: $expected",
  ({ expected, ...options }) =>
    Effect.gen(function* () {
      const { service, input } = yield* fixture(options);
      const status = yield* service.inspect(input);
      assert.equal(status.state, expected);
      if (expected === "reconnecting") assert.equal(status.reason, "Reconnecting to Home…");
      if (options.cliPid !== undefined)
        assert.equal(
          status.reason,
          "OpenCodex on this machine uses a different address. Update the URL, then check status.",
        );
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect(
  "uses the configured catalog pointer and never falls back from a broken explicit pointer",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { service, input, catalog } = yield* fixture();
      const pointer = `${input.execution.home}/config.toml`;
      yield* fs.writeFileString(pointer, 'model_catalog_json = "selected.json"\n');
      yield* fs.writeFileString(`${input.execution.cwd}/selected.json`, "{}");
      assert.include(
        (yield* service.launchArgs(input)).join(" "),
        `${input.execution.cwd}/selected.json`,
      );
      yield* fs.remove(`${input.execution.cwd}/selected.json`);
      assert.equal((yield* service.launchArgs(input).pipe(Effect.result))._tag, "Failure");
      assert.isTrue(yield* fs.exists(catalog));
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect(
  "supports a 92 MB catalog without reading it on every turn and invalidates on catalog changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { service, input, catalog, calls, reads } = yield* fixture();
      yield* fs.truncate(catalog, 92 * 1024 * 1024);
      yield* service.requireAvailable(input);
      yield* service.requireAvailable(input);
      assert.equal(calls.filter((call) => call.endsWith("/models")).length, 1);
      assert.isFalse(reads.includes(catalog));
      yield* fs.truncate(catalog, 92 * 1024 * 1024 + 1);
      yield* service.requireAvailable(input);
      assert.equal(calls.filter((call) => call.endsWith("/models")).length, 2);
      yield* TestClock.adjust("31 seconds");
      yield* service.requireAvailable(input);
      assert.equal(calls.filter((call) => call.endsWith("/models")).length, 3);
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("fails without route arguments when the selected catalog is missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { service, input, catalog, calls } = yield* fixture();
    yield* fs.remove(catalog);
    assert.equal((yield* service.launchArgs(input).pipe(Effect.result))._tag, "Failure");
    assert.equal((yield* service.inspect(input)).state, "failed");
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("rejects redirects and oversized models without treating readyz as tunnel health", () =>
  Effect.gen(function* () {
    const over = yield* fixture({
      response: () =>
        new Response("", { headers: { "content-length": String(128 * 1024 * 1024 + 1) } }),
    });
    assert.equal((yield* over.service.inspect(over.input)).state, "failed");
    const redirect = yield* fixture({
      response: () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://untrusted.example/models" },
        }),
    });
    assert.equal((yield* redirect.service.inspect(redirect.input)).state, "failed");
    assert.isFalse(redirect.calls.some((call) => call.includes("untrusted.example")));
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect(
  "rejects an actual config mismatch even when the environment contains the desired endpoint",
  () =>
    Effect.gen(function* () {
      const { input, catalog } = yield* fixture();
      const result = yield* HomeRoute.verifyEffectiveCodexRoute(
        input,
        {
          model_provider: "openai",
          openai_base_url: "http://127.0.0.1:10101/v1",
          model_catalog_json: catalog,
        },
        catalog,
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("does not compose a Home route for managed Codex or probe default settings", () =>
  Effect.gen(function* () {
    const { service, input, calls } = yield* fixture();
    assert.equal(
      (yield* service
        .launchArgs({ ...input, settings: { ...input.settings, setupMode: "managed" } })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.deepStrictEqual(
      yield* service.launchArgs({
        ...input,
        settings: { ...input.settings, modelRoute: "default" },
      }),
      [],
    );
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each([
  "not a URL",
  "http://127.0.0.1:0/v1",
  "http://127.0.0.1:10100/other",
  "https://127.0.0.1:10100/v1",
  "http://example.com/v1",
  "http://user:password@localhost:10100/v1",
  "http://localhost:10100/v1?token=hidden",
])("rejects a non-loopback or credential-bearing Home URL: %s", (url) =>
  Effect.gen(function* () {
    const result = yield* Effect.try({
      try: () => HomeRoute.normalizeOpenCodexBaseUrl(url),
      catch: (error) =>
        isRouteUnavailable(error)
          ? error
          : new HomeRoute.OpenCodexRouteUnavailable({
              detail: "Unexpected address validation error",
            }),
    }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.equal(
        result.failure.detail,
        "Enter a local OpenCodex address such as http://127.0.0.1:10100/v1.",
      );
  }),
);

it.effect("shares in-flight probes and keeps explicit refresh fresh", () =>
  Effect.gen(function* () {
    const { service, input, calls } = yield* fixture();
    yield* Effect.all([service.requireAvailable(input), service.requireAvailable(input)], {
      concurrency: "unbounded",
    });
    assert.equal(calls.filter((call) => call.endsWith("/models")).length, 1);
    yield* service.inspect(input);
    assert.equal(calls.filter((call) => call.endsWith("/models")).length, 2);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect(
  "bounds and cancels actual models streams at 128 MiB without trusting Content-Length",
  () =>
    Effect.gen(function* () {
      let cancelled = false;
      let chunk = 0;
      const encoder = new TextEncoder();
      const f = yield* fixture({
        response: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(
                  encoder.encode(
                    chunk++ === 0
                      ? '{"data":[{"id":"home-model","metadata":"'
                      : "x".repeat(1024 * 1024),
                  ),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      });
      assert.equal((yield* f.service.inspect(f.input)).state, "failed");
      assert.isTrue(cancelled);
      assert.isAtMost(chunk, 131);
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("cancels a models body that does not finish before its deadline", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();
    let cancelled = false;
    const f = yield* fixture({
      onModelsRequest: Deferred.succeed(requested, undefined),
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    const probe = yield* f.service.inspect(f.input).pipe(Effect.forkScoped);
    yield* Deferred.await(requested);
    yield* TestClock.adjust("16 seconds");
    assert.equal((yield* Fiber.join(probe)).state, "failed");
    assert.isTrue(cancelled);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "redirect", response: () => new Response(null, { status: 302 }) },
  { name: "HTTP rejection", response: () => new Response("{}", { status: 401 }) },
  { name: "failed readiness", response: () => new Response("{}", { status: 503 }) },
  { name: "invalid JSON", response: () => new Response("invalid response") },
  { name: "invalid model structure", response: () => new Response('{"data":[{}]}') },
  {
    name: "oversized response",
    response: () =>
      new Response("", { headers: { "content-length": String(128 * 1024 * 1024 + 1) } }),
  },
])("uses one endpoint recovery reason for $name", ({ response }) =>
  Effect.gen(function* () {
    const f = yield* fixture({ response });
    const status = yield* f.service.inspect(f.input);
    assert.equal(status.state, "failed");
    assert.equal(
      status.reason,
      "OpenCodex didn't answer correctly at http://127.0.0.1:10100/v1. Check that OpenCodex is running, then check status.",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("explains unavailable CLI status without exposing parser details", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ cliOutput: "invalid CLI status" });
    const status = yield* f.service.inspect(f.input);
    assert.equal(status.state, "failed");
    assert.equal(
      status.reason,
      "Couldn't read OpenCodex status. Check that OpenCodex is running, then check status.",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("uses the endpoint recovery reason when readiness reports failure", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ ready: "failed" });
    const status = yield* f.service.inspect(f.input);
    assert.equal(status.state, "failed");
    assert.equal(
      status.reason,
      "OpenCodex didn't answer correctly at http://127.0.0.1:10100/v1. Check that OpenCodex is running, then check status.",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
