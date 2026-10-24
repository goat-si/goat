import type { ComputerUseReadiness, ComputerUseRefusal } from "@goat/contracts";
import * as Schema from "effect/Schema";

import type { SecureFocus } from "./atspiFocus.ts";
import type { DriverToolResult } from "./CuaDriverMcp.ts";
import {
  linuxReadiness,
  pngColors,
  type LinuxSession,
  type ReadinessFacts,
} from "./linuxSession.ts";

const Permissions = Schema.Struct({
  x11: Schema.Boolean,
  wayland: Schema.Boolean,
  atspi: Schema.Boolean,
});
const Windows = Schema.Struct({
  windows: Schema.Array(
    Schema.Struct({
      pid: Schema.Int,
      window_id: Schema.Int,
      is_on_screen: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

/** Shared by the helper and host status; never creates a second driver or replaces its tree. */
export async function readLinuxReadiness(
  deps: {
    readonly session: LinuxSession;
    readonly uinputWritable: () => Promise<boolean>;
    readonly secureFocus: (pid: number) => Promise<SecureFocus>;
    readonly call: (
      tool: string,
      args: Readonly<Record<string, unknown>>,
      deadlineMs: number,
    ) => Promise<DriverToolResult | string | ComputerUseRefusal>;
  },
  deadlineMs: number,
): Promise<ComputerUseReadiness> {
  const facts: { -readonly [K in keyof ReadinessFacts]: ReadinessFacts[K] } = {
    session: deps.session,
    driver: null,
    capture: "unproven",
    tree: "unavailable",
    uinputWritable: await deps.uinputWritable(),
  };
  const call = async (tool: string, args: Readonly<Record<string, unknown>>) => {
    const answer = await deps.call(tool, args, deadlineMs);
    return typeof answer === "string" || "outcome" in answer || answer.isError ? null : answer;
  };
  if (deps.session.unavailable === undefined && deps.session.unsupported === undefined) {
    const permissions = await call("check_permissions", {});
    const decoded = Schema.decodeUnknownOption(Permissions)(permissions?.structured);
    if (decoded._tag === "Some") {
      facts.driver = decoded.value;
      const list = await call("list_windows", {});
      const windows = Schema.decodeUnknownOption(Windows)(list?.structured);
      const shown =
        windows._tag === "Some"
          ? windows.value.windows.find((entry) => entry.is_on_screen !== false)
          : undefined;
      if (!shown) facts.capture = windows._tag === "Some" ? "noWindow" : "failed";
      else {
        // display_only preserves the snapshot the agent's element tokens belong to.
        const capture = await call("get_window_state", {
          pid: shown.pid,
          window_id: shown.window_id,
          include_accessibility_tree: false,
          display_only: true,
          max_image_dimension: 256,
        });
        const image = capture?.images[0];
        facts.capture = image
          ? (pngColors(Buffer.from(image.data, "base64")) ?? "failed")
          : "failed";
        const focus = await deps.secureFocus(shown.pid);
        facts.tree = !focus.known ? "unavailable" : focus.windows > 0 ? "ready" : "empty";
      }
    }
  }
  return linuxReadiness(facts);
}
