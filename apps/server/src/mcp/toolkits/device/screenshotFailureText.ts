import { DeviceOperationError, DeviceToolUnavailableError } from "@goat/contracts";
import * as Schema from "effect/Schema";

const isDeviceToolUnavailableError = Schema.is(DeviceToolUnavailableError);
const isDeviceOperationError = Schema.is(DeviceOperationError);

// Only these messages are written for the agent; other device errors can carry host output.
export const deviceScreenshotFailureText = (error: unknown): string => {
  if (isDeviceToolUnavailableError(error)) return error.message;
  if (!isDeviceOperationError(error)) return "Device screenshot failed.";
  return error.reason === "hub_rejected"
    ? `${error.message} Call goat_device_list to check the device state, and goat_device_open if it needs to be reopened.`
    : error.message;
};
