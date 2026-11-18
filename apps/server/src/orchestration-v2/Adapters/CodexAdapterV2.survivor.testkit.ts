import * as Effect from "effect/Effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Layer from "effect/Layer";

import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";

const layerTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

export { layerTest };

export function makeSurvivorInputEvidence() {
  let inherited = 0;
  return {
    inputDelivery: {
      begin: () => Effect.die("Survivor adoption must not submit input."),
      accepted: () => Effect.void,
      inherited: () =>
        Effect.sync(() => {
          inherited++;
        }),
    },
    inheritedCount: () => inherited,
  };
}
