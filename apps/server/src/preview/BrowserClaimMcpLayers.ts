import * as Layer from "effect/Layer";
import * as SshRemoteDispatchLive from "../sshRemote/SshRemoteDispatchLive.ts";
import * as PreviewSessions from "./PreviewSessions.ts";
import * as BrowserClaimHandoffs from "./BrowserClaimHandoffs.ts";

export const layer = Layer.mergeAll(
  SshRemoteDispatchLive.layer,
  PreviewSessions.layerHandoffs,
  BrowserClaimHandoffs.layer,
);
