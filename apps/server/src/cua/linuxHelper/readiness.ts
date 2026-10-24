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
import type { WindowCaptureCheck } from "./windowCapture.ts";

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

/** Shown windows readiness tries before it settles for the best answer it has. */
const READINESS_WINDOWS = 5;
const CAPTURE_RANK = { varied: 3, uniform: 2, failed: 1, noWindow: 0, unproven: 0 } as const;
const TREE_RANK = { ready: 2, empty: 1, unavailable: 0 } as const;

const decodePermissions = Schema.decodeUnknownOption(Permissions);
const decodeWindows = Schema.decodeUnknownOption(Windows);

/** Shared by the helper and host status; never creates a second driver or replaces its tree. */
export async function readLinuxReadiness(
  deps: {
    readonly session: LinuxSession;
    readonly uinputWritable: () => Promise<boolean>;
    readonly secureFocus: (pid: number) => Promise<SecureFocus>;
    readonly windowCapture: WindowCaptureCheck;
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
    captureRefused: undefined,
  };
  const call = async (tool: string, args: Readonly<Record<string, unknown>>) => {
    const answer = await deps.call(tool, args, deadlineMs);
    return typeof answer === "string" || "outcome" in answer || answer.isError ? null : answer;
  };
  if (deps.session.unavailable === undefined && deps.session.unsupported === undefined) {
    const permissions = await call("check_permissions", {});
    const decoded = decodePermissions(permissions?.structured);
    if (decoded._tag === "Some") {
      facts.driver = decoded.value;
      // A cropped capture proves nothing about one window, so it is not even taken.
      facts.captureRefused = await deps.windowCapture();
      const list = await call("list_windows", {});
      const windows = decodeWindows(list?.structured);
      const shown =
        windows._tag === "Some"
          ? windows.value.windows
              .filter((entry) => entry.is_on_screen !== false)
              .slice(0, READINESS_WINDOWS)
          : [];
      if (shown.length === 0) facts.capture = windows._tag === "Some" ? "noWindow" : "failed";
      // One window does not speak for the desktop: an app without accessibility, or a covered
      // window that captures blank. The best answer among a few shown windows wins.
      for (const window of shown) {
        if (facts.capture !== "varied" && facts.captureRefused === undefined) {
          // display_only preserves the snapshot the agent's element tokens belong to.
          const capture = await call("get_window_state", {
            pid: window.pid,
            window_id: window.window_id,
            include_accessibility_tree: false,
            display_only: true,
            max_image_dimension: 256,
          });
          const image = capture?.images[0];
          const found = image
            ? (pngColors(Buffer.from(image.data, "base64")) ?? "failed")
            : "failed";
          if (CAPTURE_RANK[found] > CAPTURE_RANK[facts.capture]) facts.capture = found;
        }
        if (facts.tree !== "ready") {
          const focus = await deps.secureFocus(window.pid);
          const found = !focus.known ? "unavailable" : focus.windows > 0 ? "ready" : "empty";
          if (TREE_RANK[found] > TREE_RANK[facts.tree]) facts.tree = found;
        }
        if (facts.capture === "varied" && facts.tree === "ready") break;
      }
    }
  }
  return linuxReadiness(facts);
}
