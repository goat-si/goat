import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChannelLayers from "../ChannelLayers.ts";
import * as ChannelLedger from "../ChannelLedger.ts";
import * as ChannelRuntime from "../ChannelRuntime.ts";
import * as ChannelSessionFirst from "../ChannelSessionFirst.ts";

// These suites exercise reception's decisions; session admission has its own integration suite.
export const receptionDecisionChannels = Layer.fresh(ChannelRuntime.layer).pipe(
  Layer.provideMerge(
    Layer.effect(
      ChannelSessionFirst.ChannelSessionFirst,
      Effect.gen(function* () {
        const service = yield* ChannelSessionFirst.ChannelSessionFirst;
        return ChannelSessionFirst.ChannelSessionFirst.of({
          ...service,
          offer: Effect.fn("ReceptionHarness.offer")(() => Effect.succeed(false)),
        });
      }),
    ).pipe(Layer.provideMerge(ChannelLayers.layerServices)),
  ),
);

export const claimChannelRuntime = Effect.gen(function* () {
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  const ledger = yield* ChannelLedger.ChannelLedger;
  yield* ledger.claimOwnership({
    token: runtime.ownerToken,
    now: "2026-10-12T00:00:00.000Z",
    staleBefore: "2026-10-11T00:00:00.000Z",
  });
  return runtime;
});
