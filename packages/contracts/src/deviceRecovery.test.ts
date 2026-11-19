import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DeviceOperationError } from "./device.ts";

const encodeDeviceOperationError = Schema.encodeSync(DeviceOperationError);

const previous = Schema.TaggedStruct("DeviceOperationError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "command_failed",
    "request_failed",
    "invalid_payload",
    "settings_failed",
    "hub_rejected",
  ]),
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.Defect(),
});
const decodePrevious = Schema.decodeSync(previous);

it("keeps missing-npm device errors readable by the previous client schema", () => {
  const error = new DeviceOperationError({
    operation: "update device tool",
    reason: "command_failed",
    recovery: "npm_not_found",
    cause: "npm unavailable",
  });
  const encoded = encodeDeviceOperationError(error);
  expect(encoded).toHaveProperty("recovery", "npm_not_found");
  expect(decodePrevious(encoded)).toMatchObject({ reason: "command_failed" });
});
