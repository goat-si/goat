import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerSettings from "../serverSettings.ts";
import { getTelemetryIdentity } from "./Identify.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import { layerWithdrawable } from "./AnalyticsService.testHelpers.ts";

const decode = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      batch: Schema.Array(Schema.Struct({ event: Schema.String, distinct_id: Schema.String })),
    }),
  ),
);
const recordingClient = () => {
  const bodies: Array<string> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag === "Uint8Array")
        bodies.push(new TextDecoder().decode(request.body.body));
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
    }),
  );
  return { bodies, client };
};
const decodeEvents = (bodies: ReadonlyArray<string>) =>
  Effect.forEach(bodies, (body) => decode(body)).pipe(
    Effect.map((batches) => batches.flatMap((batch) => batch.batch)),
    Effect.orDie,
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("telemetry consent races", (it) => {
  it.effect("a consent change after a batch is taken prevents sending it", () =>
    Effect.gen(function* () {
      const { bodies, client } = recordingClient();
      const gate = yield* Deferred.make<void>();
      const reached = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let reads = -1;
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* analytics.record("test.old");
        reads = 0;
        const flushing = yield* analytics.flush.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(reached);
        yield* settings.updateSettings({ telemetryConsent: "declined" });
        yield* settings.updateSettings({ telemetryConsent: "granted" });
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(flushing);
        yield* Deferred.succeed(gate, undefined);
        assert.deepEqual(yield* decodeEvents(bodies), []);
        yield* analytics.flush;
        yield* analytics.record("test.new");
        yield* analytics.flush;
        assert.deepEqual(
          (yield* decodeEvents(bodies)).map((event) => event.event),
          ["test.new"],
        );
      }).pipe(
        Effect.provide(
          layerWithdrawable(
            client,
            (remove) => remove,
            gate,
            () =>
              Effect.suspend(() => {
                if (reads < 0 || ++reads !== 2) return Effect.void;
                return Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(resume)),
                );
              }),
          ),
        ),
      );
    }),
  );

  it.effect("a decline at the startup snapshot resets the prior identity", () =>
    Effect.gen(function* () {
      const { bodies, client } = recordingClient();
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const old = yield* getTelemetryIdentity;
        yield* settings.updateSettings({ telemetryConsent: "granted" });
        yield* analytics.flush;
        yield* analytics.record("test.new");
        yield* analytics.flush;
        const events = yield* decodeEvents(bodies);
        assert.lengthOf(events, 1);
        assert.notEqual(events[0]?.distinct_id, old.distinctId);
      }).pipe(
        Effect.provide(layerWithdrawable(client, (remove) => remove, undefined, undefined, true)),
      );
    }),
  );
});
