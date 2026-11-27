import { nodeProcessRuntimeAttributes, processServiceInstanceId } from "@goat/shared/observability";
import * as RelayTracing from "@goat/shared/relayTracing";

import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

const relayClientTracingConfig = resolveRelayClientTracingConfig();

const relayLayer = (resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">) =>
  // Never the operator's own `service.instance.id`: it names their machine for their receiver.
  RelayTracing.layer(relayClientTracingConfig, {
    ...resource,
    serviceInstanceId: processServiceInstanceId(),
  });

export const layerHeadlessRelayClient = relayLayer({
  serviceName: "goat-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "goat-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
