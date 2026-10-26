import { addDevice } from "../ssh/addDevice.ts";
import { type ConnectionCatalogOperation } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as ConnectionCatalogBroker from "../../../connections/ConnectionCatalogBroker.ts";
import * as HubNodes from "../../../hubNodes/HubNodes.ts";
import { hubNodesFailure, legacyConnection } from "../../../hubNodes/legacyConnection.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ConnectionToolkit } from "./tools.ts";

const forward = (operation: ConnectionCatalogOperation, timeoutMs: number) =>
  Effect.gen(function* () {
    const broker = yield* ConnectionCatalogBroker.ConnectionCatalogBroker;
    if (!(yield* broker.hasHost)) return "not_attached" as const;
    return yield* broker.invoke(operation, timeoutMs).pipe(
      Effect.map((result) =>
        result.type === operation.type ? ("saved" as const) : ("failed" as const),
      ),
      Effect.catch(() => Effect.succeed("failed" as const)),
    );
  });

export const layer = McpToolAccess.toLayer(ConnectionToolkit, {
  goat_connection_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const hub = yield* HubNodes.HubNodes;
      const { nodes, notices } = yield* hub.snapshot.pipe(Effect.mapError(hubNodesFailure));
      return {
        connections: nodes.flatMap((node) => {
          const connection = legacyConnection(node);
          return connection === undefined ? [] : [connection];
        }),
        nodes,
        notices,
      };
    }),
  ),
  goat_connection_add_ssh: addDevice,
  goat_connection_remove: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        const hub = yield* HubNodes.HubNodes;
        const { removed: node } = yield* hub
          .remove({ nodeId: input.nodeId ?? input.environmentId! })
          .pipe(Effect.mapError(hubNodesFailure));
        const removed = legacyConnection(node);
        const desktopCatalog =
          node.environmentId === null
            ? ("not_attached" as const)
            : yield* forward({ type: "remove", environmentId: node.environmentId }, 30_000);
        return { node, ...(removed === undefined ? {} : { removed }), desktopCatalog };
      }),
    ),
  ),
});
