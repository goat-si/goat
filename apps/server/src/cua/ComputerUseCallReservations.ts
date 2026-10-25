import type {
  ComputerUseCallAdmission,
  ComputerUseCallReservation,
  ThreadId,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- ids are minted inside the atomic claim.
import * as NodeCrypto from "node:crypto";
import { movesPointer } from "./computerUseTarget.ts";

const READS = new Set([
  "check_permissions",
  "health_report",
  "get_guide",
  "list_apps",
  "list_windows",
  "get_accessibility_tree",
  "get_window_state",
  "wait_for_window_settle",
  "get_screen_size",
  "get_cursor_position",
  "verify_state",
  "zoom",
  "get_session",
  "list_sessions",
  "get_agent_cursor_state",
  "start_session",
  "end_session",
]);
const WINDOW_MUTATIONS = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "invoke_menu",
  "set_window_frame",
]);

type Resource = { readonly pid: number; readonly windowId: number } | "desktop";
type Call = Extract<ComputerUseCallReservation, { action: "reserve" }>;
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Foreground input shares the desktop even when its named window differs. */
export const foreground = (value: unknown, depth = 0): boolean => {
  if (depth > 16) return true;
  if (Array.isArray(value)) return value.some((item) => foreground(item, depth + 1));
  const object = record(value);
  if (object === undefined) return false;
  return Object.entries(object).some(
    ([key, child]) =>
      ((key === "delivery_mode" || key === "dispatch") &&
        typeof child === "string" &&
        child.toLowerCase() === "foreground") ||
      (key.includes("foreground") && child === true) ||
      foreground(child, depth + 1),
  );
};

export const requiresForeground = (call: Pick<Call, "name" | "args">) =>
  // Overlay moves ignore delivery mode; only the driver's desktop form moves the real pointer.
  call.name === "move_cursor"
    ? movesPointer(call.args)
    : call.name === "run_steps" ||
      call.name === "run_script" ||
      call.name === "bring_to_front" ||
      call.name === "launch_app" ||
      foreground(call.args);

/** Numeric identity is execution scope only; it never preserves approval across window reuse. */
export const callResource = (call: Pick<Call, "name" | "args">): Resource | "read" | "invalid" => {
  const desktop = requiresForeground(call);
  if (!WINDOW_MUTATIONS.has(call.name))
    return !desktop && READS.has(call.name) ? "read" : "desktop";
  const args = record(call.args);
  const target = record(args?.target);
  if (target !== undefined && (args?.pid !== undefined || args?.window_id !== undefined))
    return "invalid";
  const exact = target ?? args;
  if (exact?.pid !== undefined && !positive(exact.pid)) return "invalid";
  if (exact?.window_id !== undefined && !positive(exact.window_id)) return "invalid";
  if (desktop || (target !== undefined && target.kind !== "window")) return "desktop";
  if (positive(exact?.pid) && positive(exact?.window_id))
    return { pid: exact.pid, windowId: exact.window_id };
  return "desktop";
};

interface Ticket {
  readonly threadId: ThreadId;
  readonly call: Call;
  readonly resource: Resource;
}

const connectionKey = (threadId: ThreadId, call: ComputerUseCallReservation) =>
  JSON.stringify([threadId, call.controlId, call.connectionId]);
const overlaps = (a: Resource, b: Resource) =>
  a === "desktop" || b === "desktop" || (a.pid === b.pid && a.windowId === b.windowId);

/** Owned by the lease service; all operations run without a yield during admission. */
export const makeCallReservations = () => {
  const tickets = new Map<string, Ticket>();
  // A delayed POST must never reopen a driver generation already cut off by its proxy.
  const closed = new Map<string, { readonly threadId: ThreadId; readonly controlId: string }>();
  return {
    /**
     * Whether another control's ticket holds what this call would reserve. It takes nothing; a
     * window ticket answers before the app lease around it (D17), as the narrower refusal.
     */
    targetBusy(threadId: ThreadId, call: Call): boolean {
      const resource = callResource(call);
      if (resource === "invalid" || resource === "read") return false;
      for (const ticket of tickets.values())
        if (
          (ticket.threadId !== threadId || ticket.call.controlId !== call.controlId) &&
          overlaps(resource, ticket.resource)
        )
          return true;
      return false;
    },
    /**
     * Another control's call still running in this window call's app: the same process, or the
     * same app id. It holds the app whatever its control's state, until it answers or its driver
     * is closed, so a Stop cannot hand the app over before the driver is cut off (D17).
     */
    appTicket(
      threadId: ThreadId,
      call: Call,
      mayRun: (holder: ThreadId, controlId: string) => boolean,
    ) {
      const resource = callResource(call);
      if (typeof resource !== "object") return undefined;
      for (const ticket of tickets.values()) {
        if (ticket.threadId === threadId && ticket.call.controlId === call.controlId) continue;
        if (typeof ticket.resource !== "object") continue;
        const sameApp =
          call.app !== undefined &&
          ticket.call.app !== undefined &&
          call.app.toLowerCase() === ticket.call.app.toLowerCase();
        if (
          (ticket.resource.pid === resource.pid || sameApp) &&
          mayRun(ticket.threadId, ticket.call.controlId)
        )
          return {
            holderThreadId: ticket.threadId,
            app: ticket.call.app ?? call.app ?? `the app with pid ${resource.pid}`,
          };
      }
      return undefined;
    },
    /** The controls that still have a call outstanding. */
    ticketControls(): ReadonlySet<string> {
      return new Set([...tickets.values()].map((ticket) => ticket.call.controlId));
    },
    reserve(threadId: ThreadId, call: Call): ComputerUseCallAdmission {
      if (closed.has(connectionKey(threadId, call)))
        return { status: "refused", detail: "replaced" };
      const resource = callResource(call);
      if (resource === "invalid") return { status: "refused", detail: "invalid_target" };
      if (resource === "read") return { status: "admitted", reservationId: null };
      for (const ticket of tickets.values()) {
        const duplicate =
          connectionKey(threadId, call) === connectionKey(ticket.threadId, ticket.call) &&
          call.callId === ticket.call.callId;
        if (
          duplicate ||
          ((ticket.threadId !== threadId || ticket.call.controlId !== call.controlId) &&
            overlaps(resource, ticket.resource))
        )
          return { status: "refused", detail: "target_busy", holderThreadId: ticket.threadId };
      }
      const reservationId = NodeCrypto.randomUUID();
      tickets.set(reservationId, { threadId, call, resource });
      return { status: "admitted", reservationId };
    },
    lookup(
      threadId: ThreadId,
      call: Extract<ComputerUseCallReservation, { action: "validate" }>,
    ): Call | undefined {
      const ticket = tickets.get(call.reservationId);
      if (
        closed.has(connectionKey(threadId, call)) ||
        ticket === undefined ||
        connectionKey(ticket.threadId, ticket.call) !== connectionKey(threadId, call)
      )
        return undefined;
      return ticket.call;
    },
    forgetClosed(threadId: ThreadId, controlId: string) {
      for (const [key, owner] of closed)
        if (owner.threadId === threadId && owner.controlId === controlId) closed.delete(key);
    },
    release(
      threadId: ThreadId,
      call: Extract<ComputerUseCallReservation, { action: "release" | "close" }>,
      rememberClosed: boolean,
    ): ComputerUseCallAdmission {
      const key = connectionKey(threadId, call);
      if (call.action === "close" && rememberClosed)
        closed.set(key, { threadId, controlId: call.controlId });
      for (const [id, ticket] of tickets) {
        if (
          connectionKey(ticket.threadId, ticket.call) === key &&
          (call.action === "close" || call.reservationId === id)
        )
          tickets.delete(id);
      }
      return { status: "released" };
    },
  };
};
