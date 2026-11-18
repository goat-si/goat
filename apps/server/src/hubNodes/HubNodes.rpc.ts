import { HubMachinesError, WS_METHODS, WsHubNodesRpcGroup } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { canResolveHumanStep, sessionResolver } from "../handoffs/HumanStepAuthority.ts";
import * as DisposableAttach from "../hub/disposable/DisposableAttach.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as HubNodes from "./HubNodes.ts";

export const makeHubNodesHandlers = Effect.fn("HubNodes.rpcHandlers")(function* (
  session: AuthenticatedSession,
) {
  const hubNodes = yield* HubNodes.HubNodes;
  const machines = yield* DisposableAttach.DisposableAttach;
  // Admitting a machine to the owner's Pen mesh is a person's step in Settings.
  const person = canResolveHumanStep(sessionResolver(session), "person_only")
    ? Effect.succeed({
        provisioner: { kind: "person" as const, sessionId: session.sessionId },
      })
    : Effect.fail(
        new HubMachinesError({
          reason: "provisioner_refused",
          detail:
            "Only a person in Settings attaches, detaches or releases a machine from a client.",
        }),
      );
  const principal = "session:" + session.sessionId;
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
    [WS_METHODS.hubMachinesAttach]: (input) =>
      Effect.flatMap(person, (caller) => machines.attach(caller, principal, input)),
    [WS_METHODS.hubMachinesReissue]: (input) =>
      Effect.flatMap(person, (caller) => machines.reissue(caller, principal, input)),
    [WS_METHODS.hubMachinesDetach]: (input) =>
      Effect.flatMap(person, (caller) => machines.detach(caller, principal, input)),
    [WS_METHODS.hubMachinesRelease]: (input) =>
      Effect.flatMap(person, (caller) => machines.release(caller, principal, input)),
    [WS_METHODS.hubMachinesList]: (input) => machines.list(input),
  });
});
