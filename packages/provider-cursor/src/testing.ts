/**
 * Cursor internals the server's replay testkit, fixture recorder, and
 * orchestration tests use directly.
 *
 * @module provider-cursor/testing
 */
export {
  CURSOR_DEFAULT_INSTANCE_ID,
  CURSOR_DRIVER_KIND,
  CursorProviderCapabilitiesV2,
  cursorSdkModelSelection,
  makeCursorAgentOptions,
} from "./server/adapter.ts";
export {
  makeCursorCloudAdapter,
  capabilities as CursorCloudCapabilities,
  DRIVER as CURSOR_CLOUD_DRIVER_KIND,
} from "./server/cloud/adapter.ts";
export {
  CursorCloudSdk,
  CursorCloudSdkError,
  type CloudAgent,
  type CloudRun,
  type CloudRunOptions,
} from "./server/cloud/sdk.ts";
