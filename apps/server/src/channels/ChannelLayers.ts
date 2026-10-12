/**
 * The channel layer as the server assembles it: ledger, gateway, reception, dispatch, worker
 * reports, delivery, and the background runtime, with the GOAT bot and the MCP mailbox registered
 * as transports. Slack settings use the unavailable port until a live Slack runtime is assembled.
 *
 * @module ChannelLayers
 */
import * as Layer from "effect/Layer";

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
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import * as ChannelWake from "./ChannelWake.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";

const layerFoundation = Layer.mergeAll(
  ChannelLedger.layer,
  ChannelBotDirectory.layer,
  ChannelWake.layer,
  ChannelTransport.layer,
  SlackChannelSettings.layerUnavailable,
);

const layerTimeline = ChannelBotTimeline.layer.pipe(Layer.provideMerge(layerFoundation));

const layerGateway = Layer.mergeAll(
  ChannelGateway.layer,
  ChannelBotRegistry.layer,
  ChannelIdentityService.layer,
).pipe(Layer.provideMerge(layerTimeline));

const layerWorkers = Layer.mergeAll(
  ChannelReceptionService.layer,
  ChannelDispatcher.layer,
  ChannelWorkerReports.layer,
  ChannelDeliveryWorker.layer,
).pipe(
  // Workers on other machines; needs SshRemoteDispatch from the server.
  Layer.provideMerge(ChannelRemoteWorkers.layer),
  Layer.provideMerge(layerGateway),
);

/** Every channel service, without background loops (tests drive passes with `drain`). */
export const layerServices = ChannelRuntime.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(ChannelBotTimeline.layerGoatTransport, ChannelGateway.layerMcpMailbox).pipe(
      Layer.provideMerge(layerWorkers),
    ),
  ),
);

/** Every channel service plus the background owner loop. */
export const layer = ChannelRuntime.layerBackground.pipe(Layer.provideMerge(layerServices));
