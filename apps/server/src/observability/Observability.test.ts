import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Tracer from "effect/Tracer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import type { EffectTraceRecord } from "@goat/shared/observability";

import * as ServerConfig from "../config.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as Observability from "./Observability.ts";
import * as Metrics from "./Metrics.ts";
import * as BrowserTraceCollector from "./BrowserTraceCollector.ts";

// Synthetic canaries; neither is a real credential.
const canaryJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnktc3Bhbi1leGl0In0.Y2FuYXJ5LXNwYW4tZXhpdA";
const canaryBearer = "canary-nested-bearer";

class UpstreamError extends Error {
  override readonly name = "UpstreamError";
}

interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue?: string; readonly boolValue?: boolean };
}

interface OtlpSpan {
  readonly name: string;
  readonly attributes: ReadonlyArray<OtlpAttribute>;
  readonly events: ReadonlyArray<{
    readonly name: string;
    readonly attributes: ReadonlyArray<OtlpAttribute>;
  }>;
  readonly status: { readonly code: number; readonly message?: string };
}

const layerTraceCollector = (bodies: Array<string>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag === "Uint8Array")
          bodies.push(new TextDecoder().decode(request.body.body));
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    ),
  );

const exportedSpans = (bodies: ReadonlyArray<string>): ReadonlyArray<OtlpSpan> =>
  bodies.flatMap((body) => {
    const payload = JSON.parse(body) as {
      readonly resourceSpans?: ReadonlyArray<{
        readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<OtlpSpan> }>;
      }>;
    };
    return (payload.resourceSpans ?? []).flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    );
  });

const attribute = (attributes: ReadonlyArray<OtlpAttribute>, key: string) =>
  attributes.find((entry) => entry.key === key)?.value;

/**
 * Runs a failing, a dying, an interrupted and a succeeding span through the server's tracing
 * composition, then returns the program's own exits, the trace file and what OTLP received.
 */
const traceThroughServer = (otlpTracesUrl: string | undefined) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-observability-test-" }),
    );
    const bodies: Array<string> = [];
    const layerConfig = Layer.effect(
      ServerConfig.ServerConfig,
      Effect.gen(function* () {
        const base = yield* ServerConfig.ServerConfig;
        return ServerConfig.make({ ...base, otlpTracesUrl });
      }),
    ).pipe(Layer.provide(ServerConfig.layerTest(baseDir, baseDir)));

    const failure = new UpstreamError(`upstream rejected ${canaryJwt}`);
    const defect = new Error("worker crashed", {
      cause: new Error(`Authorization: Bearer ${canaryBearer}`),
    });
    const { failExit, dieExit, tracePath } = yield* Effect.gen(function* () {
      const failExit = yield* Effect.fail(failure).pipe(
        Effect.withSpan("observability-fail"),
        Effect.exit,
      );
      const dieExit = yield* Effect.die(defect).pipe(
        Effect.withSpan("observability-die"),
        Effect.exit,
      );
      yield* Effect.interrupt.pipe(Effect.withSpan("observability-interrupt"), Effect.exit);
      // More interrupts than redaction keeps one by one; the span must still read as interrupted.
      yield* Effect.failCause(
        Cause.fromReasons<never>(
          Array.from({ length: 17 }, (_, id) => Cause.makeInterruptReason(id)),
        ),
      ).pipe(Effect.withSpan("observability-interrupts"), Effect.exit);
      yield* Effect.void.pipe(Effect.withSpan("observability-success"));
      const { serverTracePath } = yield* ServerConfig.ServerConfig;
      return { failExit, dieExit, tracePath: serverTracePath };
    }).pipe(
      Effect.provide(
        Observability.layer.pipe(
          Layer.provideMerge(layerConfig),
          Layer.provide(ResourceAttribution.layer),
          Layer.provide(layerTraceCollector(bodies)),
        ),
      ),
    );

    const traceText = yield* fileSystem.readFileString(tracePath);
    const records = traceText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EffectTraceRecord)
      .filter((record) => record.name.startsWith("observability-"));
    const record = (name: string) => {
      const found = records.find((entry) => entry.name === name);
      assert.isDefined(found, `no trace record for ${name}`);
      return found!;
    };
    return { failure, defect, failExit, dieExit, traceText, record, bodies };
  }).pipe(Effect.provide(NodeServices.layer));

const recordedCause = (record: EffectTraceRecord) =>
  record.exit._tag === "Success" ? "" : record.exit.cause;

describe("Observability.layer", () => {
  it.effect.each([
    { otlp: false, exports: "the trace file" },
    { otlp: true, exports: "the trace file and the OTLP export" },
  ])(
    "redacts failed span causes in $exports, keeping their kind, name and stack shape",
    ({ otlp }) =>
      Effect.gen(function* () {
        const { failure, defect, failExit, dieExit, traceText, record, bodies } =
          yield* traceThroughServer(otlp ? "http://otlp.test/v1/traces" : undefined);

        // The application's own failures are untouched.
        assert.strictEqual(Option.getOrUndefined(Exit.findErrorOption(failExit)), failure);
        assert.include(failure.message, canaryJwt);
        assert.isTrue(Exit.isFailure(dieExit));
        if (Exit.isFailure(dieExit)) {
          assert.strictEqual(Cause.squash(dieExit.cause), defect);
        }

        for (const canary of [canaryJwt, canaryBearer]) {
          expect(traceText).not.toContain(canary);
          for (const body of bodies) expect(body).not.toContain(canary);
        }

        const failed = record("observability-fail");
        assert.equal(failed.exit._tag, "Failure");
        expect(recordedCause(failed)).toContain("UpstreamError: upstream rejected ");
        expect(recordedCause(failed)).toContain("at observability-fail");
        const died = record("observability-die");
        assert.equal(died.exit._tag, "Failure");
        expect(recordedCause(died)).toContain("Error: worker crashed");
        expect(recordedCause(died)).toContain("Authorization: ");
        assert.equal(record("observability-interrupt").exit._tag, "Interrupted");
        assert.equal(record("observability-interrupts").exit._tag, "Interrupted");
        assert.deepStrictEqual(record("observability-success").exit, { _tag: "Success" });

        if (!otlp) {
          assert.deepStrictEqual(bodies, []);
          return;
        }
        const spans = exportedSpans(bodies);
        const span = (name: string) => {
          const found = spans.find((entry) => entry.name === name);
          assert.isDefined(found, `no exported span for ${name}`);
          return found!;
        };
        const exception = (name: string) => {
          const events = span(name).events.filter((event) => event.name === "exception");
          assert.equal(events.length, 1);
          const attributes = events[0]!.attributes;
          return {
            type: attribute(attributes, "exception.type")?.stringValue,
            message: attribute(attributes, "exception.message")?.stringValue ?? "",
            stack: attribute(attributes, "exception.stacktrace")?.stringValue ?? "",
          };
        };

        const failedExport = exception("observability-fail");
        assert.equal(failedExport.type, "UpstreamError");
        expect(failedExport.message).toMatch(/^upstream rejected /);
        expect(failedExport.stack).toMatch(/^UpstreamError: upstream rejected /);
        expect(failedExport.stack).toContain("\n    at ");
        assert.equal(span("observability-fail").status.message, failedExport.message);

        const diedExport = exception("observability-die");
        assert.equal(diedExport.type, "Error");
        assert.equal(diedExport.message, "worker crashed");
        expect(diedExport.stack).toContain("Authorization: ");

        for (const name of ["observability-interrupt", "observability-interrupts"]) {
          const interrupted = span(name);
          assert.equal(interrupted.events.filter((event) => event.name === "exception").length, 0);
          assert.equal(
            attribute(interrupted.attributes, "effect.fiber.interrupted")?.boolValue,
            true,
          );
        }
        const succeeded = span("observability-success");
        assert.equal(succeeded.events.filter((event) => event.name === "exception").length, 0);
        assert.equal(succeeded.status.message, undefined);
      }),
  );
});

it.effect.each(["Info", "Debug", "Trace"] as const)(
  "applies the local SQL policy at %s while preserving OTLP spans",
  (traceMinLevel) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sql-policy-" });
      const bodies: string[] = [];
      const layerConfig = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const base = yield* ServerConfig.ServerConfig;
          return ServerConfig.make({
            ...base,
            traceMinLevel,
            otlpTracesUrl: "http://otlp.test/v1/traces",
          });
        }),
      ).pipe(Layer.provide(ServerConfig.layerTest(dir, dir)));
      const tracePath = yield* Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const parent = Tracer.externalSpan({ traceId: "1".repeat(32), spanId: "2".repeat(16) });
        for (let index = 0; index < 1_000; index++) {
          const span = tracer.span({
            name: "sqlite",
            parent: Option.some(parent),
            annotations: Context.empty(),
            links: [],
            startTime: 0n,
            kind: "client",
            root: false,
            sampled: true,
          });
          span.attribute("db.lock_wait_ms", 0);
          span.attribute("fixture.id", index);
          span.end(1_000_000n, Exit.void);
        }
        yield* Effect.void.pipe(Effect.withSpan("policy-fixture"));
        return (yield* ServerConfig.ServerConfig).serverTracePath;
      }).pipe(
        Effect.provide(
          Observability.layer.pipe(
            Layer.provideMerge(layerConfig),
            Layer.provide(ResourceAttribution.layer),
            Layer.provide(layerTraceCollector(bodies)),
          ),
        ),
      );
      const records = (yield* fs.readFileString(tracePath))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EffectTraceRecord)
        .filter((record) => record.name === "sqlite");
      const expectedIds =
        traceMinLevel === "Info" ? [] : Array.from({ length: 1_000 }, (_, i) => i);
      assert.deepEqual(
        records.map((record) => record.attributes["fixture.id"]),
        expectedIds,
      );
      const bytes = records.reduce(
        (total, record) => total + Buffer.byteLength(`${JSON.stringify(record)}\n`),
        0,
      );
      if (traceMinLevel === "Info") assert.equal(bytes, 0);
      else assert.isAbove(bytes, 0);
      assert.equal(exportedSpans(bodies).filter((span) => span.name === "sqlite").length, 1_000);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps browser SQL records and counts server sink loss with a fixed reason", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-trace-metric-" });
    const metric = Metric.withAttributes(Metrics.serverTraceDroppedRecords, { reason: "oversize" });
    const before = yield* Metric.value(metric);
    const layerConfig = Layer.effect(
      ServerConfig.ServerConfig,
      Effect.gen(function* () {
        const base = yield* ServerConfig.ServerConfig;
        return ServerConfig.make({ ...base, traceMinLevel: "Info", traceMaxBytes: 1024 });
      }),
    ).pipe(Layer.provide(ServerConfig.layerTest(dir, dir)));
    const record: EffectTraceRecord = {
      type: "effect-span",
      name: "sqlite",
      traceId: "browser",
      spanId: "browser-sql",
      parentSpanId: "browser-parent",
      sampled: true,
      kind: "client",
      startTimeUnixNano: "0",
      endTimeUnixNano: "1000000",
      durationMs: 1,
      attributes: { "db.lock_wait_ms": 0, "fixture.browser": true },
      events: [],
      links: [],
      exit: { _tag: "Success" },
    };
    const tracePath = yield* Effect.gen(function* () {
      const collector = yield* BrowserTraceCollector.BrowserTraceCollector;
      yield* collector.record([record, { ...record, name: "x".repeat(2048) }]);
      return (yield* ServerConfig.ServerConfig).serverTracePath;
    }).pipe(
      Effect.provide(
        Observability.layer.pipe(
          Layer.provideMerge(layerConfig),
          Layer.provide(ResourceAttribution.layer),
        ),
      ),
    );
    const after = yield* Metric.value(metric);
    assert.equal(after.count - before.count, 1);
    assert.isTrue(after.incremental);
    const records = (yield* fs.readFileString(tracePath))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EffectTraceRecord);
    assert.deepEqual(
      records.filter((entry) => entry.name === "sqlite"),
      [record],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
