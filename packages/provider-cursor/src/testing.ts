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
  DRIVER as CURSOR_CLOUD_DRIVER_KIND,
} from "./server/cloud/adapter.ts";
export { CursorCloudSdk, type CloudAgent, type CloudRun } from "./server/cloud/sdk.ts";
