import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { failureCode, fixture } from "./OpenCodexChildReady.testkit.ts";

// How setup operations succeed one another on a Child: request history, ownership across a
// crash, journal writes racing a newer operation, probe coalescing and the hydration barrier.
it.layer(NodeServices.layer)("OpenCodexChildReady operations", (it) => {
  it.effect("a new operation probes again after the previous operation's request failed", () =>
    Effect.gen(function* () {
      let first = true;
      const f = yield* fixture({}, (state) => {
        if (first) state.settingsDigest = "changed-mid-request";
        first = false;
      });
      yield* f.routed;
      expect(failureCode(yield* f.call("probe"))).toBe("route_unverified");
      // The same operation never sends a second paid request.
      expect(failureCode(yield* f.call("probe"))).toBe("route_unverified");
      expect(yield* f.probes).toBe(1);
      expect(yield* f.routedAs("op-2")).toBeUndefined();
      expect(yield* f.call("probe", f.state.revision, "op-2")).toMatchObject({
        kind: "ok",
        setup: { readiness: "ready", proof: { operationId: "op-2" } },
      });
      expect(yield* f.probes).toBe(2);
    }),
  );

  it.effect("a proof invalidated later under the same operation needs a new operation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      expect((yield* f.call("probe")).kind).toBe("ok");
      f.state.codexVersion = "0.157.0";
      expect(yield* f.status).toMatchObject({ setup: { readiness: "invalid" } });
      f.state.codexVersion = "0.156.1";
      expect(failureCode(yield* f.call("probe"))).toBe("route_unverified");
      expect(yield* f.probes).toBe(1);
      yield* f.routedAs("op-2");
      expect((yield* f.call("probe", f.state.revision, "op-2")).kind).toBe("ok");
      expect(yield* f.probes).toBe(2);
    }),
  );
});
