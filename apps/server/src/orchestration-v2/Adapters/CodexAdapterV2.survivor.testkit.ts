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
);

export { layerTest };
