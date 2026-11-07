import { CuaAgentBlock } from "@goat/contracts";
import * as Schema from "effect/Schema";

export class CuaDriverStartError extends Schema.TaggedError<CuaDriverStartError>()(
  "CuaDriverStartError",
  { binaryPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Failed to start Cua Driver.";
  }
}
export class CuaDriverHostError extends Schema.TaggedError<CuaDriverHostError>()(
  "CuaDriverHostError",
  {
    // "restart" is the desktop retiring its driver on purpose, such as after new grants.
    // "refused" is the driver rejecting GOAT's capability manifest or launch options at startup.
    // "display" is a start refused because this host has no screen the driver can use.
    // "install" is turning computer use on when the verified driver download failed.
    operation: Schema.Literals([
      "busy",
      "start",
      "stop",
      "exit",
      "desktop",
      "timeout",
      "restart",
      "refused",
      "display",
      "install",
    ]),
    cause: Schema.optional(Schema.Defect()),
    /** The desktop's typed reason, beside its message, when agents cannot get past it alone. */
    block: Schema.optional(CuaAgentBlock),
  },
) {
  override get message() {
    // The desktop's explanation, such as a missing macOS grant, and the display probe's reason
    // are written for users.
    if (
      (this.operation === "desktop" ||
        this.operation === "display" ||
        this.operation === "install") &&
      typeof this.cause === "string"
    )
      return this.cause;
    if (this.operation === "refused") return CUA_DRIVER_REFUSED_MESSAGE;
    return `Cua Driver host failed during ${this.operation}.`;
  }
}
export const CUA_DRIVER_REFUSED_MESSAGE =
  "Cua Driver refused GOAT's capability manifest or launch options. The server log has the driver's reason.";
export type CuaDriverError = CuaDriverStartError | CuaDriverHostError;
