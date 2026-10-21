/**
 * The channel layer as the server assembles it: ledger, gateway, reception, dispatch, worker
 * reports, delivery, and the background runtime, with the GOAT bot, the MCP mailbox, and Slack
 * registered as transports.
 *
 * Slack settings sit between the gateway and the workers: the live Slack runtime needs the gateway
 * and transport registry, and the dispatcher reads a connection's default target. On shutdown the
 * Slack layer is released before the gateway and ledger, so its sockets close first; an envelope
 * not yet stored is left unacknowledged for Slack to redeliver, and the dedupe key absorbs a
 * redelivery of one that was stored.
 *
 * @module ChannelLayers
 */
import * as Layer from "effect/Layer";

import * as MemoryStore from "../memory/MemoryStore.ts";
import * as ServerConfig from "../config.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import * as ChannelBotDirectory from "./ChannelBotDirectory.ts";
import * as ChannelBotRegistry from "./ChannelBotRegistry.ts";
import * as ChannelBotTimeline from "./ChannelBotTimeline.ts";
import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRemoteWorkers from "./ChannelRemoteWorkers.ts";
import * as ChannelTaskExport from "./ChannelTaskExport.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import * as ChannelWake from "./ChannelWake.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import * as SlackChannelRuntime from "./slack/SlackChannelRuntime.ts";
import * as SlackChannelSettingsLive from "./slack/SlackChannelSettings.live.ts";
import * as SlackSdk from "./slack/SlackSdk.ts";
import * as ImessageChannelRuntime from "./imessage/ImessageChannelRuntime.ts";

const layerFoundation = Layer.mergeAll(
  ChannelLedger.layer,
  MemoryStore.layer,
  ChannelBotHome.layer,
  ChannelBotDirectory.layer,
  ChannelWake.layer,
  ChannelTransport.layer,
);

const layerTimeline = ChannelBotTimeline.layer.pipe(Layer.provideMerge(layerFoundation));

const layerGateway = Layer.mergeAll(
  ChannelGateway.layer,
  ChannelBotRegistry.layer,
  ChannelIdentityService.layer,
).pipe(Layer.provideMerge(layerTimeline));

/** The live Slack runtime and settings. The SDK stays a requirement so tests can fake it. */
const layerSlackLive = SlackChannelSettingsLive.layer.pipe(
  Layer.provideMerge(SlackChannelRuntime.layer),
);

/**
 * Every channel service without background loops, over the given Slack settings. Tests that only
 * need a connection's default target can pass a stub here.
 */
export const makeLayerServices = <E, R>(
  layerSlack: Layer.Layer<SlackChannelSettings.SlackChannelSettings, E, R>,
  layerImessage: Layer.Layer<
    ImessageChannelRuntime.ImessageChannelRuntime,
    never,
    | ServerConfig.ServerConfig
    | ChannelLedger.ChannelLedger
    | ChannelGateway.ChannelGateway
    | ChannelBotHome.ChannelBotHome
    | ChannelTransport.ChannelTransportRegistry
  > = ImessageChannelRuntime.layerUnavailable,
) => {
  const layerWorkers = Layer.mergeAll(
    ChannelReceptionService.layer,
    ChannelDispatcher.layer,
    ChannelWorkerReports.layer,
    ChannelDeliveryWorker.layer,
  ).pipe(
    // Workers on other machines; needs SshRemoteDispatch from the server.
    Layer.provideMerge(ChannelRemoteWorkers.layer),
    Layer.provideMerge(layerSlack),
    Layer.provideMerge(layerGateway),
  );
  // Build the exporter inside the same graph as the workers so it captures the shared EventSink.
  return Layer.mergeAll(ChannelRuntime.layer, ChannelTaskExport.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ChannelBotTimeline.layerGoatTransport,
        ChannelGateway.layerMcpMailbox,
        layerImessage,
      ).pipe(Layer.provideMerge(layerWorkers)),
    ),
  );
};

/**
 * Every channel service, without background loops and without Slack (tests drive passes with
 * `drain` and register their own Slack transport).
 */
export const layerServices = makeLayerServices(SlackChannelSettings.layerUnavailable);

/** Every channel service with the live Slack runtime, over whatever `SlackSdk` is provided. */
export const makeLayerServicesWithSlack = (imessageLayer = ImessageChannelRuntime.layerLive) =>
  makeLayerServices(layerSlackLive, imessageLayer);

const layerServicesWithSlack = makeLayerServicesWithSlack();

/** Every channel service, the live Slack connection, and the background owner loop. */
export const layer = ChannelRuntime.layerBackground.pipe(
  Layer.provideMerge(layerServicesWithSlack),
  Layer.provide(SlackSdk.layer),
);
