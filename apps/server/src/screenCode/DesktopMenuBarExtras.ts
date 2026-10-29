// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  ComputerUsePrimitiveReply,
  ScreenHostCall,
  ScreenJournalEntry,
  ScreenRunError,
  ScreenTargetRef,
} from "@goat/contracts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import { driverResult, driverValue, fail } from "./DesktopDriverReplies.ts";
import { admitDesktopInput } from "./DesktopInputGuards.ts";
import { boundsOf } from "./DesktopFrames.ts";
import type { ScreenHostContext, ScreenHostDispatchResult } from "./ScreenHostBridge.ts";

const RESTARTED_EXTRAS =
  "The driver restarted; call screen.menuBarExtras() again to get current handles.";
const FAILED_CATEGORIES = new Set(["partial", "suspected_noop", "refused"]);

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const natural = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

interface MenuItemRecord {
  readonly index: number;
  readonly token: string;
  readonly role: string;
  readonly name: string;
  readonly rawLabel?: string;
  readonly cmdChar?: string;
  readonly cmdModifiers?: ReadonlyArray<string>;
  readonly enabled?: boolean;
  readonly selected?: boolean;
  readonly frame?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

interface OpenExtraMenu {
  readonly menuId: string;
  readonly menuToken: string;
  readonly cellKey: string;
  readonly context: ScreenHostContext;
  readonly items: ReadonlyArray<MenuItemRecord>;
}

interface BoundMenuBarExtra {
  readonly ref: ScreenTargetRef;
  readonly token: string;
  readonly pid: number;
  readonly bundleId?: string;
  readonly app: string;
  readonly title?: string;
  readonly index: number;
  readonly epoch: number;
  readonly controlId: string;
  readonly connectionGeneration: string;
  openMenu?: OpenExtraMenu;
}

const cellKeyOf = (runId: string, turnId: string, cellId: string) =>
  `${runId}\u0000${turnId}\u0000${cellId}`;

const callArgs = (args: ScreenHostCall["args"]): Record<string, unknown> => {
  const { targetRef: _t, batch: _b, ...rest } = object(Array.isArray(args) ? args[0] : args) ?? {};
  return rest;
};

export interface DesktopMenuBarExtrasController {
  readonly list: (
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  readonly open: (
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  readonly pressItem: (
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  readonly close: (
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  readonly cleanupCell: (
    context: ScreenHostContext,
  ) => Effect.Effect<ReadonlyArray<ScreenJournalEntry>>;
  readonly invalidateTarget: (targetId: string) => void;
  readonly finishTurn: (runId: string, turnId: string) => void;
  readonly hasTarget: (targetId: string) => boolean;
  readonly controlIdForTarget: (targetId: string) => string | undefined;
  readonly matchesControl: (targetId: string, controlId: string) => boolean;
}

export const createDesktopMenuBarExtras = (deps: {
  readonly request: (
    tool: string,
    args: Record<string, unknown>,
    call: ScreenHostCall,
    context: ScreenHostContext,
    expectedConnectionGeneration?: string,
  ) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
  readonly leases: ComputerUseLeases["Service"];
  readonly nextEpoch: () => number;
}): DesktopMenuBarExtrasController => {
  const extras = new Map<string, BoundMenuBarExtra>();

  const resolveExtra = (
    call: ScreenHostCall,
    context: ScreenHostContext,
  ): BoundMenuBarExtra | undefined => {
    const ref = call.targetRef;
    const bound = ref && extras.get(ref.id);
    return ref?.kind === "app" &&
      bound &&
      ref.environmentId === context.environmentId &&
      ref.runId === context.runId &&
      ref.turnId === context.turnId &&
      ref.generation === bound.epoch
      ? bound
      : undefined;
  };

  const verifyBundleScope = Effect.fn("DesktopMenuBarExtras.verifyBundleScope")(function* (
    extra: BoundMenuBarExtra,
    context: ScreenHostContext,
  ) {
    const current = Option.getOrUndefined(
      yield* deps.leases.currentControl(context.invocation.thread.threadId),
    );
    if (!current || current.controlId !== extra.controlId)
      return yield* Effect.fail(fail("unavailable", "Desktop control is no longer active."));
    const state = yield* deps.leases
      .controlState(context.invocation.thread.threadId, current.controlId)
      .pipe(Effect.orElseSucceed(() => ({ _tag: "ended" as const })));
    if (state._tag !== "active" || state.idle === true)
      return yield* Effect.fail(fail("unavailable", "Desktop control is not active."));
    if (extra.bundleId === undefined)
      return yield* Effect.fail(
        fail(
          "permission_denied",
          "This menu bar extra has no known owner bundle id, so GOAT cannot verify app approval.",
        ),
      );
    if (state.apps !== undefined && !state.apps.includes(extra.bundleId))
      return yield* Effect.fail(
        fail("permission_denied", `${extra.bundleId} is not in this thread's approved apps.`),
      );
  });

  const extraRequest = Effect.fn("DesktopMenuBarExtras.extraRequest")(function* (
    extra: BoundMenuBarExtra,
    tool: string,
    args: Record<string, unknown>,
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) {
    return yield* deps
      .request(tool, args, call, context, extra.connectionGeneration)
      .pipe(
        Effect.mapError((error) =>
          error.code === "stale_reference" && error.safety === undefined
            ? fail("stale_reference", RESTARTED_EXTRAS)
            : error,
        ),
      );
  });

  const list: DesktopMenuBarExtrasController["list"] = Effect.fn("DesktopMenuBarExtras.list")(
    function* (call, context) {
      const current = Option.getOrUndefined(
        yield* deps.leases.currentControl(context.invocation.thread.threadId),
      );
      if (!current) return yield* Effect.fail(fail("unavailable"));
      const reply = yield* deps.request("list_menu_bar_extras", {}, call, context);
      for (const [id, existing] of extras) {
        if (existing.ref.runId === context.runId && existing.ref.turnId === context.turnId)
          extras.delete(id);
      }
      const rawList = array(object(driverValue(reply))?.extras);
      const boundList = rawList
        .map(object)
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .flatMap((item, fallbackIndex) => {
          const token = string(item.token);
          const pid = integer(item.owner_pid) ?? integer(item.pid);
          if (token === undefined || pid === undefined) return [];
          const bundleId = string(item.owner_bundle_id) ?? string(item.bundle_id);
          const app = string(item.app_name) ?? string(item.app) ?? bundleId ?? `pid:${pid}`;
          const title = string(item.title) ?? string(item.label);
          const index = natural(item.index) ?? fallbackIndex;
          const epoch = deps.nextEpoch();
          const ref: ScreenTargetRef = {
            id: NodeCrypto.randomUUID(),
            kind: "app",
            environmentId: context.environmentId,
            runId: context.runId,
            turnId: context.turnId,
            generation: epoch,
          };
          extras.set(ref.id, {
            ref,
            token,
            pid,
            ...(bundleId === undefined ? {} : { bundleId }),
            app,
            ...(title === undefined ? {} : { title }),
            index,
            epoch,
            controlId: current.controlId,
            connectionGeneration: reply.connectionGeneration,
          });
          return [
            {
              targetRef: ref,
              identity: bundleId ?? app,
              app,
              ...(bundleId === undefined ? {} : { bundleId }),
              pid,
              ...(title === undefined ? {} : { title }),
              index,
            },
          ];
        });
      return {
        value: { extras: boundList },
        category: "unverifiable",
      };
    },
  );

  const open: DesktopMenuBarExtrasController["open"] = Effect.fn("DesktopMenuBarExtras.open")(
    function* (call, context) {
      const extra = resolveExtra(call, context);
      if (!extra)
        return yield* Effect.fail(
          fail(
            "stale_reference",
            "Menu bar extra handle is stale; call screen.menuBarExtras() again.",
          ),
        );
      yield* verifyBundleScope(extra, context);
      const reply = yield* extraRequest(
        extra,
        "open_menu_bar_extra",
        { token: extra.token },
        call,
        context,
      );
      const data = object(driverValue(reply));
      const menuToken = string(data?.menu_token) ?? extra.token;
      const rawElements = array(data?.elements);
      const items: MenuItemRecord[] = rawElements
        .map(object)
        .filter((el): el is Record<string, unknown> => el !== undefined)
        .flatMap((el, idx) => {
          const itemToken = string(el.element_token) ?? string(el.token);
          if (itemToken === undefined) return [];
          const index = natural(el.element_index) ?? natural(el.index) ?? idx;
          const role = string(el.role) ?? "AXMenuItem";
          const name = string(el.label) ?? string(el.title) ?? string(el.name) ?? "";
          const rawLabel = string(el.label);
          const cmdChar = string(el.cmd_char) ?? string(el.cmdChar);
          const rawMods = Array.isArray(el.cmd_modifiers)
            ? el.cmd_modifiers
            : Array.isArray(el.modifiers)
              ? el.modifiers
              : undefined;
          const cmdModifiers = rawMods
            ?.map(string)
            .filter((mod): mod is string => mod !== undefined);
          const rect = boundsOf(el.frame);
          return [
            {
              index,
              token: itemToken,
              role,
              name,
              ...(rawLabel === undefined ? {} : { rawLabel }),
              ...(cmdChar === undefined ? {} : { cmdChar }),
              ...(cmdModifiers === undefined ? {} : { cmdModifiers }),
              ...(typeof el.enabled === "boolean" ? { enabled: el.enabled } : {}),
              ...(typeof el.selected === "boolean" ? { selected: el.selected } : {}),
              ...(rect === undefined
                ? {}
                : { frame: { x: rect.x, y: rect.y, width: rect.w, height: rect.h } }),
            },
          ];
        });
      const menuId = NodeCrypto.randomUUID();
      extra.openMenu = {
        menuId,
        menuToken,
        cellKey: cellKeyOf(context.runId, context.turnId, context.cellId),
        context,
        items,
      };
      return {
        value: {
          menuId,
          elements: items.map(
            ({ token: _token, rawLabel: _r, cmdChar: _c, cmdModifiers: _m, ...guest }) => guest,
          ),
        },
        category: "confirmed",
        evidence: ["driver:menu_opened"],
      };
    },
  );

  const pressItem: DesktopMenuBarExtrasController["pressItem"] = Effect.fn(
    "DesktopMenuBarExtras.pressItem",
  )(function* (call, context) {
    const extra = resolveExtra(call, context);
    if (!extra)
      return yield* Effect.fail(
        fail(
          "stale_reference",
          "Menu bar extra handle is stale; call screen.menuBarExtras() again.",
        ),
      );
    yield* verifyBundleScope(extra, context);
    const args = callArgs(call.args);
    const menuId = string(args.menuId);
    const openMenu = extra.openMenu;
    if (!openMenu || (menuId !== undefined && openMenu.menuId !== menuId))
      return yield* Effect.fail(
        fail("stale_reference", "That menu is no longer open; call extra.open() again."),
      );
    const itemTarget = args.item;
    let chosen: MenuItemRecord | undefined;
    if (typeof itemTarget === "number" && Number.isSafeInteger(itemTarget) && itemTarget >= 0) {
      chosen = openMenu.items.find((candidate) => candidate.index === itemTarget);
      if (!chosen)
        return yield* Effect.fail(
          fail(
            "invalid_argument",
            `Menu item [${itemTarget}] is not in the open menu; pick an index from menu.elements.`,
          ),
        );
    } else if (typeof itemTarget === "string" && itemTarget.trim().length > 0) {
      const query = itemTarget.trim();
      const exact = openMenu.items.filter((candidate) => candidate.name === query);
      const matches =
        exact.length > 0
          ? exact
          : openMenu.items.filter(
              (candidate) => candidate.name.toLowerCase() === query.toLowerCase(),
            );
      if (matches.length === 0)
        return yield* Effect.fail(
          fail("target_missing", `No menu item named ${JSON.stringify(query)} in the open menu.`),
        );
      if (matches.length > 1)
        return yield* Effect.fail(
          fail(
            "target_ambiguous",
            `Menu item ${JSON.stringify(query)} matches ${matches.length} items; pass its index number.`,
          ),
        );
      chosen = matches[0];
    } else {
      return yield* Effect.fail(
        fail("invalid_argument", "Pass a menu item index number or item name string."),
      );
    }
    if (!chosen)
      return yield* Effect.fail(
        fail("invalid_argument", "Pass a menu item index number or item name string."),
      );
    const admission = admitDesktopInput({
      method: "press_menu_item",
      args: { label: chosen.name },
      appId: extra.app,
      ...(extra.bundleId === undefined ? {} : { bundleId: extra.bundleId }),
      elementToken: chosen.token,
      element: {
        index: chosen.index,
        role: chosen.role,
        name: chosen.name,
        rawLabel: chosen.rawLabel ?? chosen.name,
        nonValueLabel: chosen.name,
        description: "",
        placeholder: "",
        identifier: "",
        editable: false,
        tableCell: false,
        menuSurface: true,
      },
    });
    if (admission.refused !== undefined) return yield* Effect.fail(admission.refused);
    const reply = yield* extraRequest(
      extra,
      "press_menu_item",
      { token: chosen.token },
      call,
      context,
    );
    const result = driverResult("press_menu_item", reply);
    if (!FAILED_CATEGORIES.has(result.category)) delete extra.openMenu;
    return result;
  });

  const close: DesktopMenuBarExtrasController["close"] = Effect.fn("DesktopMenuBarExtras.close")(
    function* (call, context) {
      const extra = resolveExtra(call, context);
      if (!extra)
        return yield* Effect.fail(
          fail(
            "stale_reference",
            "Menu bar extra handle is stale; call screen.menuBarExtras() again.",
          ),
        );
      yield* verifyBundleScope(extra, context);
      const args = callArgs(call.args);
      const menuId = string(args.menuId);
      const openMenu = extra.openMenu;
      if (!openMenu || (menuId !== undefined && openMenu.menuId !== menuId))
        return yield* Effect.fail(
          fail("stale_reference", "That menu is already closed; call extra.open() to open it."),
        );
      const reply = yield* extraRequest(
        extra,
        "close_menu",
        { token: openMenu.menuToken },
        call,
        context,
      );
      const result = driverResult("close_menu", reply);
      if (!FAILED_CATEGORIES.has(result.category)) delete extra.openMenu;
      return result;
    },
  );

  const cleanupCell: DesktopMenuBarExtrasController["cleanupCell"] = Effect.fn(
    "DesktopMenuBarExtras.cleanupCell",
  )(function* (context) {
    const key = cellKeyOf(context.runId, context.turnId, context.cellId);
    const notices: ScreenJournalEntry[] = [];
    for (const extra of extras.values()) {
      const openMenu = extra.openMenu;
      if (!openMenu || openMenu.cellKey !== key) continue;
      delete extra.openMenu;
      const now = yield* Clock.currentTimeMillis;
      const syntheticCall: ScreenHostCall = {
        t: "call",
        runId: context.runId,
        turnId: context.turnId,
        cellId: context.cellId,
        callId: 0,
        method: "close_menu",
        args: [{ token: openMenu.menuToken }],
        deadlineMillis: now + 4_500,
      };
      const closed = yield* deps
        .request(
          "close_menu",
          { token: openMenu.menuToken },
          syntheticCall,
          context,
          extra.connectionGeneration,
        )
        .pipe(Effect.result);
      const failedClose =
        closed._tag === "Failure" ||
        FAILED_CATEGORIES.has(driverResult("close_menu", closed.success).category);
      if (failedClose) {
        notices.push({
          sequence: notices.length + 1,
          truncated: false,
          receipt: {
            callId: 0,
            method: "close_menu",
            targetId: extra.ref.id,
            journalState: "unknown",
            category: "unknown_outcome",
            dispatched: true,
            evidence: ["cleanup_failed:close_menu", `app:${extra.app.slice(0, 80)}`],
          },
        });
      }
    }
    return notices;
  });

  return {
    list,
    open,
    pressItem,
    close,
    cleanupCell,
    invalidateTarget: (targetId) => {
      extras.delete(targetId);
    },
    finishTurn: (runId, turnId) => {
      for (const [id, extra] of extras) {
        if (extra.ref.runId === runId && extra.ref.turnId === turnId) extras.delete(id);
      }
    },
    hasTarget: (targetId) => extras.has(targetId),
    controlIdForTarget: (targetId) => extras.get(targetId)?.controlId,
    matchesControl: (targetId, controlId) => extras.get(targetId)?.controlId === controlId,
  };
};
