import type { AuthClientMetadata, AuthClientSession } from "@goat/contracts";

import { keptByRevokeOthers } from "./revokeOthersKeeps.ts";

export function createDefaultClientMetadata(): AuthClientMetadata {
  return {
    deviceType: "unknown",
  };
}

export function toClientMetadata(record: {
  readonly label: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceType: AuthClientMetadata["deviceType"];
  readonly os: string | null;
  readonly browser: string | null;
}): AuthClientMetadata {
  return {
    ...(record.label ? { label: record.label } : {}),
    ...(record.ipAddress ? { ipAddress: record.ipAddress } : {}),
    ...(record.userAgent ? { userAgent: record.userAgent } : {}),
    deviceType: record.deviceType,
    ...(record.os ? { os: record.os } : {}),
    ...(record.browser ? { browser: record.browser } : {}),
  };
}

export function toAuthClientSession(
  input: Omit<AuthClientSession, "current" | "keptByRevokeOthers"> & { readonly penBound: boolean },
): AuthClientSession {
  const { penBound, ...session } = input;
  const kept = keptByRevokeOthers({ subject: session.subject, method: session.method, penBound });
  return {
    ...session,
    current: false,
    ...(kept === undefined ? {} : { keptByRevokeOthers: kept }),
  };
}
