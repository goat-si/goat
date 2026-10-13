import { LEGACY_ORCHESTRATION_PROTOCOL_HEADER } from "@goat/contracts/legacyT3Names";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@goat/contracts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
  LEGACY_ORCHESTRATION_PROTOCOL_HEADER,
] as const;

/** Origins of the Electron renderer, packaged and dev, current and before D13. */
export const DESKTOP_RENDERER_ORIGINS = [
  "goat://app",
  "goat-dev://app",
  "t3code://app",
  "t3code-dev://app",
] as const;
