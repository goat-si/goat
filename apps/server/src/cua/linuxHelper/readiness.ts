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
import { driverShot, type CaptureRoute } from "./windowCapture.ts";

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
    readonly capture: CaptureRoute;
    /**
     * This driver sees a Hyprland instance that the agents' driver does not: the server's
     * embedded daemon passes no HYPRLAND_INSTANCE_SIGNATURE on (cua-driver-sdk embedded.rs), so
     * there the screen layout, and with it listing, fails for agents even when it reads here.
     */
    readonly agentLacksHyprland?: boolean;
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
    listingRefused: false,
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
      // Agents list windows through the driver's consent, which needs the screen layout; on a
      // Wayland desktop the driver cannot read, readiness's own listing below still answers.
      if (deps.session.displayServer === "wayland")
        facts.listingRefused =
          deps.agentLacksHyprland === true || (await call("get_screen_size", {})) === null;
      // A capture that may not be the window's own proves nothing, so it is not even taken.
      if (deps.capture.route === "refused") facts.captureRefused = deps.capture.reason;
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
      let refusedBy: string | undefined;
      for (const window of shown) {
        if (facts.capture !== "varied" && facts.captureRefused === undefined) {
          const found = await readinessCapture(deps, call, window);
          if (typeof found !== "string") refusedBy = found.refused;
          else if (CAPTURE_RANK[found] > CAPTURE_RANK[facts.capture]) facts.capture = found;
        }
        if (facts.tree !== "ready") {
          const focus = await deps.secureFocus(window.pid);
          const found = !focus.known ? "unavailable" : focus.windows > 0 ? "ready" : "empty";
          if (TREE_RANK[found] > TREE_RANK[facts.tree]) facts.tree = found;
        }
        if (facts.capture === "varied" && facts.tree === "ready") break;
      }
      // No window's own pixels could be read: say why, as the agent would hear it.
      if (refusedBy !== undefined && facts.capture !== "varied" && facts.capture !== "uniform")
        facts.captureRefused = refusedBy;
    }
  }
  return linuxReadiness(facts);
}

/**
 * One window's capture for readiness, taken the way the agent's would be: "varied" or "uniform"
 * when it is the window's own pixels, why not when the helper refused it, "failed" otherwise.
 */
async function readinessCapture(
  deps: { readonly capture: CaptureRoute },
  call: (tool: string, args: Readonly<Record<string, unknown>>) => Promise<DriverToolResult | null>,
  window: { readonly pid: number; readonly window_id: number },
): Promise<"varied" | "uniform" | "failed" | { readonly refused: string }> {
  if (deps.capture.route === "own") {
    // At most 256 pixels on a side, as the driver's readiness capture below.
    const geometry = await call("get_window_state", {
      pid: window.pid,
      window_id: window.window_id,
      include_accessibility_tree: false,
      display_only: true,
      max_image_dimension: 256,
    });
    const shot = driverShot(geometry?.structured);
    if (!shot) return "failed";
    const own = await deps.capture.capture(window.window_id, shot);
    return "refused" in own ? own : (pngColors(own.png) ?? "failed");
  }
  // display_only preserves the snapshot the agent's element tokens belong to.
  const capture = await call("get_window_state", {
    pid: window.pid,
    window_id: window.window_id,
    include_accessibility_tree: false,
    display_only: true,
    max_image_dimension: 256,
  });
  const image = capture?.images[0];
  return image ? (pngColors(Buffer.from(image.data, "base64")) ?? "failed") : "failed";
}
