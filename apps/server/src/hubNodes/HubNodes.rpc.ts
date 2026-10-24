import { WS_METHODS, WsHubNodesRpcGroup } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as HubNodes from "./HubNodes.ts";

export const makeHubNodesHandlers = Effect.gen(function* () {
  const hubNodes = yield* HubNodes.HubNodes;
  return WsHubNodesRpcGroup.middleware(RpcInstrumentation).of({
    [WS_METHODS.hubNodesList]: () => hubNodes.snapshot,
    [WS_METHODS.hubNodesSubscribe]: () => hubNodes.changes,
    [WS_METHODS.hubNodesAdd]: (input) =>
      Effect.flatMap(DateTime.now, (now) =>
        hubNodes.add(input, {
          addedBy: { kind: "user", at: DateTime.formatIso(now) },
          beforeSave: Effect.void,
        }),
      ),
    [WS_METHODS.hubNodesRemove]: (input) => hubNodes.remove(input),
    [WS_METHODS.hubNodesCheck]: (input) => hubNodes.check(input),
    [WS_METHODS.hubNodesImport]: (input) => hubNodes.importProfiles(input),
    [WS_METHODS.hubNodesDismissNotice]: (input) => hubNodes.dismissNotice(input.id),
  });
});
