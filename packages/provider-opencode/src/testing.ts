import { Durable } from "@opencode/schema/durable-event-manifest";

export {
  OPENCODE_DEFAULT_INSTANCE_ID,
  OPENCODE_PROVIDER,
  OPENCODE_SDK_PROTOCOL,
} from "./server/adapter.ts";
export {
  OPENCODE_2_STILL_STOPPING,
  cuaMcpServerName,
  goatMcpServerName,
} from "./server/v2/adapter.ts";
export { goatRemoteMcpConfig } from "./server/goatMcpConfig.ts";

const durableVersions = new Map<string, number>();
for (const { type, durable } of Durable.values())
  durableVersions.set(type, Math.max(durable.version, durableVersions.get(type) ?? 0));

/**
 * The durable envelope version OpenCode stamps on an event type, or undefined for an
 * ephemeral one. Replayed frames must carry it: the client drops a durable event whose
 * version does not match the installed protocol.
 */
export const openCode2DurableVersion = (type: string) => durableVersions.get(type);
