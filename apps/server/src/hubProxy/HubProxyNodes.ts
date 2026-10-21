import type {
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  HubNode,
  HubNodeRouteTarget,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { HubNodes } from "../hubNodes/HubNodes.ts";

/** A way the hub can reach a node's GOAT server. Cloud machines are SSH aliases here. */
export type HubProxyRoute =
  | { readonly kind: "ssh"; readonly target: DesktopSshEnvironmentTarget }
  | { readonly kind: "linked"; readonly baseUrl: string };

export interface HubProxyNode {
  readonly nodeId: string;
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  /** Preferred first. */
  readonly routes: ReadonlyArray<HubProxyRoute>;
}

/** The hub's node list as the proxy needs it; backed by the hub node service. */
export class HubProxyNodes extends Context.Service<
  HubProxyNodes,
  {
    readonly get: (nodeId: string) => Effect.Effect<Option.Option<HubProxyNode>>;
    /** Emits after any change to the node list. */
    readonly changes: Stream.Stream<void>;
    /** Re-reads a node's identity after its runtime was prepared. */
    readonly refreshIdentity: (nodeId: string) => Effect.Effect<void>;
  }
>()("goat/hubProxy/HubProxyNodes") {}

export const routeKey = (route: HubProxyRoute): string =>
  route.kind === "ssh"
    ? `ssh:${route.target.alias}\u0000${route.target.hostname}\u0000${route.target.username ?? ""}\u0000${route.target.port ?? ""}`
    : `linked:${route.baseUrl}`;

const proxyRoute = (target: HubNodeRouteTarget): HubProxyRoute => {
  switch (target.kind) {
    case "ssh":
      return {
        kind: "ssh",
        target: {
          alias: target.alias,
          hostname: target.hostname ?? target.alias,
          username: target.username,
          port: target.port,
        },
      };
    // A Boat machine is an SSH alias the hub manages; dialing it never wakes it.
    case "cloud":
      return {
        kind: "ssh",
        target: { alias: target.alias, hostname: target.alias, username: null, port: null },
      };
    case "linked":
      return { kind: "linked", baseUrl: target.baseUrl };
  }
};

const toProxyNode = (node: HubNode): HubProxyNode => ({
  nodeId: node.nodeId,
  environmentId: node.environmentId,
  label: node.label,
  routes: node.routes.map((route) => proxyRoute(route.target)),
});

export const layerFromHubNodes = Layer.effect(
  HubProxyNodes,
  Effect.gen(function* () {
    const hubNodes = yield* HubNodes;
    return HubProxyNodes.of({
      // An unreadable node list serves nothing rather than a stale destination.
      get: (nodeId) =>
        hubNodes.get(nodeId).pipe(
          Effect.map(Option.map(toProxyNode)),
          Effect.orElseSucceed(() => Option.none()),
        ),
      // Retried forever: losing this stream would leave removed nodes' sockets open.
      changes: hubNodes.changes.pipe(
        Stream.map((): void => undefined),
        Stream.retry(Schedule.spaced("5 seconds")),
        Stream.orDie,
      ),
      refreshIdentity: (nodeId) => hubNodes.check({ nodeId }).pipe(Effect.ignore),
    });
  }),
);
