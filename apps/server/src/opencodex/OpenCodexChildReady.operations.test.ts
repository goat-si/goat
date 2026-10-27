import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerSettingsError } from "@goat/contracts";
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

  it.effect("adopts an owned instance's committed update after the ownership record was lost", () =>
    Effect.gen(function* () {
      let crashAfterCommit = false;
      const f = yield* fixture({
        commit: (write) =>
          write.pipe(
            Effect.filterOrFail(
              () => !crashAfterCommit,
              () => new ServerSettingsError({ settingsPath: "<test>", operation: "normalize" }),
            ),
          ),
      });
      expect(yield* f.routed).toBeUndefined();
      // OpenCodex moved to another port, so the next operation updates the owned instance.
      f.state.port = 10200;
      crashAfterCommit = true;
      expect((yield* f.call("installCodex", f.state.revision, "op-2")).kind).toBe("ok");
      expect((yield* f.call("syncCatalog", f.state.revision, "op-2")).kind).toBe("ok");
      expect((yield* f.call("configure", f.state.revision, "op-2")).kind).toBe("error");
      expect(yield* f.storedInstance).toMatchObject({
        config: { opencodexBaseUrl: "http://127.0.0.1:10200/v1" },
      });
      crashAfterCommit = false;
      expect((yield* f.call("configure", f.state.revision, "op-2")).kind).toBe("ok");
      expect((yield* f.call("probe", f.state.revision, "op-2")).kind).toBe("ok");
    }),
  );
});
