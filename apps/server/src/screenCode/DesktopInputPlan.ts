import { admitDesktopInput, buildGuardInput } from "./DesktopInputGuards.ts";
import type { BoundWindow } from "./DesktopTargetHost.ts";
/**
 * Desktop input argument planning, named AX action validation, and waitFor expectation building.
 */
import type { ScreenHostCall, ScreenRunError } from "@goat/contracts";
import { fail } from "./DesktopDriverReplies.ts";
import type { DesktopRow } from "./DesktopObserveRead.ts";
import { applyDesktopPointerArgs, pointerStateFor } from "./DesktopTargetPoints.ts";

const ACTION_TO_AX: Readonly<Record<string, string>> = {
  press: "AXPress",
  show_menu: "AXShowMenu",
  pick: "AXPick",
  confirm: "AXConfirm",
  cancel: "AXCancel",
  open: "AXOpen",
  show_alternate_ui: "AXShowAlternateUI",
  show_default_ui: "AXShowDefaultUI",
};
const AX_TO_ACTION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ACTION_TO_AX).map(([k, v]) => [v.toLowerCase(), k]),
);

const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const validateNamedAction = (
  requested: unknown,
  row: DesktopRow | undefined,
): { readonly action?: string; readonly error?: ScreenRunError } => {
  if (requested === undefined) return {};
  const name = typeof requested === "string" ? requested.trim() : "";
  const ax = ACTION_TO_AX[name];
  const offered = (row?.rawActions ?? row?.actions ?? []).flatMap((a) => {
    const mapped = AX_TO_ACTION[a.toLowerCase()] ?? (ACTION_TO_AX[a] ? a : undefined);
    return mapped === undefined ? [] : [mapped];
  });
  if (!ax || !offered.includes(name)) {
    const list = offered.length > 0 ? offered.join(", ") : "none";
    return {
      error: fail(
        "invalid_argument",
        `Action ${JSON.stringify(requested)} is not offered by this element (mapped actions: ${list}).`,
      ),
    };
  }
  return { action: name };
};

export const INPUT_METHODS: ReadonlySet<string> = new Set([
  "click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "set_value",
  "bring_to_front",
  "launch_app",
]);

const buildForwardedInput = (
  method: string,
  args: Record<string, unknown>,
  bound: { readonly pid: number; readonly windowId: number; readonly appId: string },
  elementToken: string | undefined,
  action: string | undefined,
): Record<string, unknown> => {
  const target = { kind: "window", pid: bound.pid, window_id: bound.windowId };
  const forwarded: Record<string, unknown> = { ...args, target, delivery_mode: "background" };
  delete forwarded.elementRef;
  delete forwarded.send;
  delete forwarded.replace;
  delete forwarded.targetRef;
  delete forwarded.element_token;
  delete forwarded.pid;
  delete forwarded.window_id;
  if (action !== undefined) forwarded.action = action;
  if (elementToken) forwarded.element_token = elementToken;
  if (method === "bring_to_front") {
    delete forwarded.delivery_mode;
    forwarded.pid = bound.pid;
    forwarded.window_id = bound.windowId;
  }
  if (method === "launch_app") {
    delete forwarded.delivery_mode;
    delete forwarded.target;
    forwarded.bundle_id = bound.appId;
  }
  if (method === "set_value" || method === "right_click") {
    delete forwarded.target;
    if (method === "set_value") delete forwarded.delivery_mode;
    forwarded.pid = bound.pid;
    if (elementToken === undefined) forwarded.window_id = bound.windowId;
  }
  return forwarded;
};

export const buildWaitExpectation = (
  args: Record<string, unknown>,
): { readonly expectation?: Record<string, unknown>; readonly error?: ScreenRunError } => {
  const window = args.window === "exists" || args.window === "gone" ? args.window : undefined;
  const role = string(args.role);
  const name = string(args.name);
  const value = typeof args.value === "string" ? args.value : undefined;
  const hasValue = value !== undefined && value.trim().length > 0;
  const enabled = typeof args.enabled === "boolean" ? args.enabled : undefined;
  const selected = typeof args.selected === "boolean" ? args.selected : undefined;
  if (
    window === undefined &&
    role === undefined &&
    name === undefined &&
    !hasValue &&
    enabled === undefined &&
    selected === undefined
  )
    return {
      error: fail(
        "invalid_argument",
        "Wait for {role?, name?, value?, enabled?, selected?} or {window}.",
      ),
    };
  return {
    expectation:
      window === undefined
        ? {
            element: {
              selector: {
                ...(role === undefined ? {} : { role }),
                ...(name === undefined ? {} : { label_contains: name }),
              },
              exists: true,
              ...(value === undefined ? {} : { value_equals: value }),
              ...(enabled === undefined ? {} : { enabled }),
              ...(selected === undefined ? {} : { selected }),
            },
          }
        : { window: { exists: window === "exists" } },
  };
};

export const validateMenuInput = (
  menuArgs: Record<string, unknown>,
  bound: BoundWindow,
): { readonly path?: ReadonlyArray<string>; readonly error?: ScreenRunError } => {
  const raw = Array.isArray(menuArgs.path) ? menuArgs.path : [];
  if (
    raw.length === 0 ||
    raw.length > 16 ||
    !raw.every((label): label is string => typeof label === "string" && label.trim().length > 0)
  )
    return {
      error: fail("invalid_argument", "Name the menu path, such as ['File', 'Open…']."),
    };
  const admission = admitDesktopInput({
    method: "invoke_menu",
    args: menuArgs,
    appId: bound.appId,
    ...(bound.bundleId === undefined ? {} : { bundleId: bound.bundleId }),
  });
  if (admission.refused !== undefined) return { error: admission.refused };
  return { path: raw };
};

export const prepareDesktopInput = (
  method: string,
  args: Record<string, unknown>,
  bound: BoundWindow,
  resolveToken: (el: Record<string, unknown>) => string | undefined,
): {
  readonly forwarded?: Record<string, unknown>;
  readonly elementToken?: string | undefined;
  readonly actedRow?: DesktopRow | undefined;
  readonly admission?: ReturnType<typeof admitDesktopInput>;
  readonly error?: ScreenRunError;
} => {
  if (!INPUT_METHODS.has(method)) return { error: fail("unsupported") };
  const element =
    typeof args.elementRef === "object" &&
    args.elementRef !== null &&
    !Array.isArray(args.elementRef)
      ? (args.elementRef as Record<string, unknown>)
      : undefined;
  if (method === "set_value" && !element) return { error: fail("invalid_argument") };
  let elementToken: string | undefined;
  if (element) {
    elementToken = resolveToken(element);
    if (!elementToken) return { error: fail("stale_reference") };
  }
  const actedRow =
    elementToken === undefined
      ? undefined
      : bound.rows?.find((r) => r.driverToken === elementToken);
  const checkedAction =
    method === "click" || method === "right_click"
      ? validateNamedAction(args.action, actedRow)
      : {};
  if (checkedAction.error) return { error: checkedAction.error };
  const guardInput = buildGuardInput(method, args, bound, elementToken, resolveToken);
  if (!guardInput.ok) return { error: guardInput.error };
  const admission = admitDesktopInput(guardInput.input);
  if (admission.refused !== undefined) return { error: admission.refused };
  return {
    forwarded: buildForwardedInput(method, args, bound, elementToken, checkedAction.action),
    elementToken,
    actedRow,
    admission,
  };
};

export const availabilityFromControlState = (state: {
  readonly _tag: string;
  readonly idle?: boolean;
  readonly reason?: string;
}) => {
  if (state._tag === "active" && state.idle !== true)
    return [{ kind: "app" as const, available: true }];
  const reason =
    state._tag === "paused"
      ? state.reason === "private"
        ? ("private" as const)
        : ("paused" as const)
      : ("no_lease" as const);
  return [{ kind: "app" as const, available: false, reason }];
};

export const inspectBatchMember = (
  method: ScreenHostCall["method"],
  args: Record<string, unknown>,
  bound: BoundWindow | undefined,
  platform: NodeJS.Platform | undefined,
  resolveToken: (el: Record<string, unknown>, b: BoundWindow) => string | undefined,
) => {
  if (!bound) return { ok: false as const, error: fail("stale_reference") };
  const element =
    typeof args.elementRef === "object" &&
    args.elementRef !== null &&
    !Array.isArray(args.elementRef)
      ? (args.elementRef as Record<string, unknown>)
      : undefined;
  const elementToken = element ? resolveToken(element, bound) : undefined;
  if (element && !elementToken) return { ok: false as const, error: fail("stale_reference") };
  const guardInput = buildGuardInput(method, args, bound, elementToken, (el) =>
    resolveToken(el, bound),
  );
  if (!guardInput.ok) return guardInput;
  const pointerResolved = applyDesktopPointerArgs(
    method,
    args,
    elementToken === undefined ? {} : { element_token: elementToken },
    pointerStateFor(bound, platform, (el) => resolveToken(el, bound)),
  );
  if (!pointerResolved.ok) return pointerResolved;
  return { ok: true as const, ...guardInput.input };
};
