import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@goat/contracts";
import { orchestrationProtocolRangeOf } from "@goat/shared/sshRuntimeProtocol";

import { ConnectionBlockedError } from "./model.ts";

/**
 * A client always speaks its own orchestration protocol; a server may still serve older ones,
 * which it advertises as its range. The client connects when that range includes its version.
 */
export function orchestrationProtocolCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionBlockedError | null {
  const served = orchestrationProtocolRangeOf(descriptor);
  if (served === null) {
    return new ConnectionBlockedError({
      reason: "unsupported",
      detail: `${descriptor.label} reports an unreadable protocol range, so GOAT cannot tell whether this app can talk to it. Update GOAT on ${descriptor.label} or this app.`,
    });
  }
  if (
    served.min <= ORCHESTRATION_PROTOCOL_VERSION &&
    ORCHESTRATION_PROTOCOL_VERSION <= served.max
  ) {
    return null;
  }
  return served.min > ORCHESTRATION_PROTOCOL_VERSION
    ? new ConnectionBlockedError({
        reason: "unsupported",
        detail: `This client is not supported by this server. Update your app or use a compatible release to connect to ${descriptor.label}.`,
      })
    : new ConnectionBlockedError({
        reason: "unsupported",
        detail: `This client requires a newer server. Update GOAT on ${descriptor.label} to connect.`,
        ...(canSelfUpdate(descriptor) ? { serverUpdateRequired: true } : {}),
      });
}

function canSelfUpdate(descriptor: ExecutionEnvironmentDescriptor): boolean {
  const { serverSelfUpdate, desktopAppUpdate } = descriptor.capabilities;
  return (
    serverSelfUpdate !== undefined &&
    (serverSelfUpdate !== "desktop-managed" || desktopAppUpdate === true)
  );
}

export function appendOrchestrationProtocol(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}
