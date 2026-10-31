// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off - Driver replies are bounded by the primitive channel; target IDs are opaque UUIDs.
/** The launch a screen.app or screen.launch call sends, and the wait for the launched app's window. */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type {
  ComputerUsePrimitiveReply,
  ScreenHostCall,
  ScreenRunError,
  ScreenTargetRef,
} from "@goat/contracts";
import { CELL_RESERVE_MS, driverCallCapMs, seconds } from "../cua/ComputerUseCallCaps.ts";
import { driverOutcomeSafety } from "../cua/ComputerUseDriverOutcome.ts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Option from "effect/Option";
import { driverResult, driverValue, fail } from "./DesktopDriverReplies.ts";
import type { ScreenHostContext } from "./ScreenHostBridge.ts";
import type { BoundWindow } from "./DesktopTargetHost.ts";
import type { ScreenCellRef, ScreenTargetLabel } from "../cua/ComputerUseCallApps.ts";
import { boundsOf } from "./DesktopFrames.ts";
import * as NodeCrypto from "node:crypto";

/** How long a launch that binds keeps looking for the app's first window. */
const WINDOW_WAIT_MS = 5_000;
// A list_windows poll takes about 10 ms; a launched window shows within a few of these.
const POLL_MS = 100;
/** Kept back after the last poll so the bound target's reply reaches the cell in time. */
const REPLY_RESERVE_MS = 250;

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** What the cell asked to launch: its own query, or the list_apps row it matched. */
export interface LaunchQuery {
  readonly bundleId?: string | undefined;
  readonly name?: string | undefined;
  /** A macOS `.app` path the cell named; launched as given, never swapped for another copy. */
  readonly path?: string | undefined;
  /** The list_apps `launch_path` of the row the cell matched. */
  readonly launchPath?: string | undefined;
  /** The /Applications copy to prefer among several installed copies (macOS). */
  readonly preferPath?: string | undefined;
}

export interface LaunchPlan {
  readonly args: Record<string, string>;
  /** Sent once instead when GOAT refuses `args` before the driver because only bundle ids pass. */
  readonly fallback?: Record<string, string>;
}

/**
 * The driver's launch_app arguments per platform. macOS resolves a bundle id through
 * LaunchServices and takes a `.app` path as `name`; Linux ignores bundle_id and prefers the
 * list_apps launch_path; Windows activates a packaged app by its AUMID (a bundle_id with "!"),
 * which a launch_path would bypass, and launches desktop apps by launch_path.
 */
export const launchPlan = (
  platform: NodeJS.Platform,
  query: LaunchQuery,
): LaunchPlan | ScreenRunError => {
  const { bundleId, name, path, launchPath, preferPath } = query;
  if (path !== undefined && platform !== "darwin")
    return fail("unsupported", "A path launch is macOS only; pass name or bundle_id.");
  if (platform === "darwin") {
    if (path !== undefined) return { args: { name: path } };
    if (preferPath !== undefined && bundleId !== undefined)
      return { args: { name: preferPath }, fallback: { bundle_id: bundleId } };
    if (bundleId !== undefined) return { args: { bundle_id: bundleId } };
    if (launchPath !== undefined) return { args: { name: launchPath } };
  } else if (platform === "win32") {
    if (bundleId?.includes("!")) return { args: { bundle_id: bundleId } };
    if (launchPath !== undefined) return { args: { launch_path: launchPath } };
    if (bundleId !== undefined) return { args: { bundle_id: bundleId } };
  } else {
    if (launchPath !== undefined) return { args: { launch_path: launchPath } };
    // A desktop-file id, which Linux list_apps reports as bundle_id, also matches by name.
    if (name === undefined && bundleId !== undefined) return { args: { name: bundleId } };
  }
  return name === undefined
    ? fail("invalid_argument", "Name the app with bundle_id, name or path.")
    : { args: { name } };
};

export interface LaunchedWindow {
  readonly window_id: number;
  readonly pid: number;
  readonly title?: string;
  readonly bounds?: unknown;
}

/**
 * The app's own top-level windows on screen that a list_windows or launch_app answer names. An
 * off-screen one may be a window the app closed but keeps, or a bar it never shows.
 */
const windowsOf = (value: unknown, pid: number): LaunchedWindow[] => {
  const listed = object(value)?.windows;
  const windows = (Array.isArray(listed) ? listed : [])
    .map(object)
    .filter((window) => window !== undefined)
    .filter((window) => {
      const bounds = object(window.bounds);
      const sized =
        bounds === undefined ||
        ((typeof bounds.width !== "number" || bounds.width > 1) &&
          (typeof bounds.height !== "number" || bounds.height > 1));
      // With a pid, list_windows answers every layer: menu bar items and panels are not windows to bind.
      return (
        positive(window.window_id) !== undefined &&
        (window.pid === undefined || window.pid === pid) &&
        (window.layer === undefined || window.layer === 0) &&
        window.is_on_screen !== false &&
        sized
      );
    });
  return windows.map((window): LaunchedWindow => {
    const title = string(window.title);
    return {
      window_id: positive(window.window_id) ?? 0,
      pid,
      ...(title === undefined ? {} : { title }),
      ...(window.bounds === undefined ? {} : { bounds: window.bounds }),
    };
  });
};

/**
 * Looks for the launched app's first window until WINDOW_WAIT_MS has passed. A poll starts only
 * while its whole list_windows cap fits in the cell, so a slow but normal answer never runs past
 * the deadline and costs a driver restart; a poll started before WINDOW_WAIT_MS may end up to its
 * cap (2 s) later, so the whole wait is bounded by WINDOW_WAIT_MS plus one poll cap.
 */
const awaitFirstWindow = Effect.fn("DesktopLaunch.awaitFirstWindow")(function* (input: {
  readonly pid: number;
  readonly initial: readonly LaunchedWindow[];
  readonly cellDeadlineMillis: number;
  readonly list: () => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
}) {
  const started = yield* Clock.currentTimeMillis;
  const pollCap = driverCallCapMs("list_windows", { pid: input.pid });
  const lastStart = input.cellDeadlineMillis - CELL_RESERVE_MS - REPLY_RESERVE_MS - pollCap;
  let found = input.initial;
  let cut = false;
  // Both bounds are read again after the sleep: a poll never starts past the wait or the cell's room.
  const stop = function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - started >= WINDOW_WAIT_MS) return true;
    if (now > lastStart) cut = true;
    return cut;
  };
  while (found.length === 0) {
    if (yield* stop()) break;
    yield* Effect.sleep(POLL_MS);
    if (yield* stop()) break;
    const listed = driverValue(yield* input.list());
    // A reply cut at the channel's cap lists no windows without proving there are none.
    if (!Array.isArray(object(listed)?.windows))
      return yield* Effect.fail(fail("target_missing", "The window list came back incomplete."));
    found = windowsOf(listed, input.pid);
  }
  const waitedMs = (yield* Clock.currentTimeMillis) - started;
  return { window: found[0], waitedMs, cut };
});

/** Why a launched app could not be bound: it ran, so this keeps the launch's write safety. */
const noWindow = (app: string, pid: number, waitedMs: number, cut: boolean) =>
  `${app} launched (pid ${pid}); no window appeared in ${seconds(waitedMs)}. ` +
  (cut
    ? "The cell had no time left to keep waiting: in a new cell, screen.discover() and pass window_id."
    : "It may be a menu bar or background app with no window to bind: call screen.app again once it opens one, or hand it to the person.");

/** What bindWindow needs to bind a window the driver listed. */
export interface WindowBinding {
  readonly pid: number;
  readonly windowId: number;
  readonly bundleId: string | undefined;
  readonly name: string | undefined;
  /** The id App.launch() relaunches by: the listed bundle id, else the listed name, else the query's. */
  readonly appId: string;
  readonly iconBundleId: string | undefined;
  readonly bounds: unknown;
  readonly connectionGeneration: string;
  readonly controlId: string;
}

/**
 * Binds a window the driver listed under connectionGeneration. Only what the driver reported
 * names the app on its row: the call's bundle id
 * found the window, so it may pick the icon, but the driver's app filter also matches names.
 */
export const makeBindWindow =
  (deps: {
    readonly targets: Map<string, BoundWindow>;
    readonly evict: (targetId: string) => void;
    readonly nextEpoch: () => number;
    readonly labelTarget:
      | ((targetId: string, label: ScreenTargetLabel, cell: ScreenCellRef) => void)
      | undefined;
  }) =>
  (input: WindowBinding, context: ScreenHostContext): ScreenTargetRef => {
    let lastClickedTableCell: number | string | undefined;
    for (const [id, previous] of deps.targets)
      if (
        previous.pid === input.pid &&
        previous.windowId === input.windowId &&
        previous.ref.runId === context.runId &&
        previous.ref.turnId === context.turnId
      ) {
        if (
          previous.connectionGeneration === input.connectionGeneration &&
          previous.controlId === input.controlId &&
          previous.ref.environmentId === context.environmentId
        ) {
          // The kept target takes this listing's frame: a moved or resized window places reads there.
          const moved = boundsOf(input.bounds);
          if (moved !== undefined) previous.windowBounds = moved;
          deps.labelTarget?.(
            previous.ref.id,
            {
              kind: "app",
              bundleId: input.bundleId,
              name: input.name,
              iconBundleId: input.iconBundleId,
            },
            context,
          );
          return previous.ref;
        }
        lastClickedTableCell ??= previous.lastClickedTableCell;
        deps.evict(id);
        deps.targets.delete(id);
      }
    const epoch = deps.nextEpoch();
    const ref: ScreenTargetRef = {
      id: NodeCrypto.randomUUID(),
      kind: "app",
      environmentId: context.environmentId,
      runId: context.runId,
      turnId: context.turnId,
      generation: epoch,
    };
    const listedBounds = boundsOf(input.bounds);
    deps.targets.set(ref.id, {
      ref,
      pid: input.pid,
      windowId: input.windowId,
      appId: input.appId,
      ...(input.bundleId === undefined ? {} : { bundleId: input.bundleId }),
      epoch,
      connectionGeneration: input.connectionGeneration,
      controlId: input.controlId,
      ...(listedBounds === undefined ? {} : { windowBounds: listedBounds }),
      ...(lastClickedTableCell === undefined ? {} : { lastClickedTableCell }),
    });
    deps.labelTarget?.(
      ref.id,
      { kind: "app", bundleId: input.bundleId, name: input.name, iconBundleId: input.iconBundleId },
      context,
    );
    return ref;
  };

/**
 * A launch the cell names by app: screen.launch, or screen.app for an app with no window. With
 * `bind`, the same call waits for the app's first window, under the launch's driver generation,
 * and binds it. Once the launch went out, every later failure keeps its write safety, so the
 * bridge refuses the cell's later input.
 */
export const makeLaunch = (deps: {
  /** The platform the driver runs on, which picks launch_app's arguments; this host's by default. */
  readonly platform: NodeJS.Platform | undefined;
  readonly request: (
    tool: string,
    args: Record<string, unknown>,
    call: ScreenHostCall,
    context: ScreenHostContext,
    expectedConnectionGeneration?: string,
  ) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
  readonly leases: ComputerUseLeases["Service"];
  readonly bind: (input: WindowBinding, context: ScreenHostContext) => ScreenTargetRef;
}) => {
  const platform = deps.platform ?? HostProcess.Platform.defaultValue();
  return Effect.fn("DesktopTargetHost.launch")(function* (
    call: ScreenHostCall,
    args: Record<string, unknown>,
    context: ScreenHostContext,
  ) {
    const bundleId = string(args.bundle_id) ?? string(args.bundleId);
    const name = string(args.name);
    const path = string(args.path);
    const plan = launchPlan(platform, {
      bundleId,
      name,
      path,
      launchPath: string(args.launch_path),
      preferPath: string(args.prefer_path),
    });
    if ("code" in plan) return yield* Effect.fail(plan);
    const current = yield* deps.leases.currentControl(context.invocation.thread.threadId);
    const controlId = Option.getOrUndefined(current)?.controlId;
    if (controlId === undefined) return yield* Effect.fail(fail("unavailable"));
    let copy: "path" | "launch_services" | undefined = plan.fallback ? "path" : undefined;
    let sent = yield* deps.request("launch_app", plan.args, call, context).pipe(Effect.result);
    // An approved-app list admits only bundle id launches: the /Applications pick gives way.
    if (
      sent._tag === "Failure" &&
      plan.fallback !== undefined &&
      sent.failure.effectStarted !== true &&
      sent.failure.detail === "app_not_approved"
    ) {
      copy = "launch_services";
      sent = yield* deps.request("launch_app", plan.fallback, call, context).pipe(Effect.result);
    }
    if (sent._tag === "Failure") return yield* Effect.fail(sent.failure);
    const reply = sent.success;
    const result = driverResult("launch_app", reply);
    const value: Record<string, unknown> = {
      ...object(result.value),
      ...(copy === undefined ? {} : { copy }),
    };
    if (args.bind !== true) return { ...result, value };
    const safety = driverOutcomeSafety("launch_app", reply);
    const afterLaunch = (nextStep: string, error = fail("target_missing")): ScreenRunError => ({
      ...error,
      effectStarted: true,
      safety,
      nextStep,
    });
    const pid = positive(value.pid);
    const label = string(value.name) ?? name ?? bundleId ?? path ?? "The app";
    if (pid === undefined)
      return yield* Effect.fail(
        afterLaunch(
          `${label} launched, but the driver named no pid: in a new cell, screen.discover() and pass window_id.`,
        ),
      );
    const waited = yield* awaitFirstWindow({
      pid,
      initial: windowsOf(value, pid),
      cellDeadlineMillis: call.deadlineMillis,
      list: () => deps.request("list_windows", { pid }, call, context, reply.connectionGeneration),
    }).pipe(
      Effect.mapError((error) =>
        afterLaunch(
          `${label} launched (pid ${pid}), but looking for its window failed: in a new cell, screen.discover() before acting.`,
          error,
        ),
      ),
    );
    if (waited.window === undefined)
      return yield* Effect.fail(afterLaunch(noWindow(label, pid, waited.waitedMs, waited.cut)));
    const launchedBundle = string(value.bundle_id);
    const targetRef = deps.bind(
      {
        pid,
        windowId: waited.window.window_id,
        bundleId: launchedBundle,
        name: string(value.name),
        appId: launchedBundle ?? string(value.name) ?? bundleId ?? name ?? label,
        iconBundleId: launchedBundle ?? bundleId,
        bounds: waited.window.bounds,
        connectionGeneration: reply.connectionGeneration,
        controlId,
      },
      context,
    );
    return {
      ...result,
      value: {
        targetRef,
        launched: true,
        windowId: waited.window.window_id,
        pid,
        ...(launchedBundle === undefined ? {} : { bundle_id: launchedBundle }),
        ...(string(value.name) === undefined ? {} : { name: string(value.name) }),
        ...(value.launch_state === undefined ? {} : { launch_state: value.launch_state }),
        ...(copy === undefined ? {} : { copy }),
      },
    };
  });
};
