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

/**
 * How long a call of a control that can no longer act still holds its app: longer than any proxy
 * takes to cut its driver off (an overlay acknowledgement of at most 250 ms, then the kill).
 */
export const ORPHAN_CALL_GRACE_MS = 10_000;

/**
 * The longest any call holds its app, from its reservation: past the driver's longest call (100 s
 * for typed text in cua-driver 0.37.0), so an answer or release that never arrived frees it.
 */
export const MAX_CALL_MS = 120_000;

interface Ticket {
  readonly threadId: ThreadId;
  readonly call: Call;
  readonly resource: Resource;
  readonly reservedAt: number;
  /** Reservation order within the lease service; a driver runs one connection's calls in it. */
  readonly seq: number;
  /** When this call's control was first seen unable to act, or its proxy's stream ended. */
  stoppedAt?: number;
}

const connectionKey = (threadId: ThreadId, call: ComputerUseCallReservation) =>
  JSON.stringify([threadId, call.controlId, call.connectionId]);
const overlaps = (a: Resource, b: Resource) =>
  a === "desktop" || b === "desktop" || (a.pid === b.pid && a.windowId === b.windowId);

/** Owned by the lease service; all operations run without a yield during admission. */
export const makeCallReservations = () => {
  const tickets = new Map<string, Ticket>();
  let seq = 0;
  /** When each connection's driver last answered a call: the next queued call starts then. */
  const completedAt = new Map<string, number>();
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
      canAct: (holder: ThreadId, controlId: string) => boolean,
      now: number,
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
        if (ticket.resource.pid !== resource.pid && !sameApp) continue;
        const started = Math.max(
          ticket.reservedAt,
          completedAt.get(connectionKey(ticket.threadId, ticket.call)) ?? 0,
        );
        if (now - started >= MAX_CALL_MS) continue;
        // Marked per call, never per control: a later call of a reused control starts unmarked.
        if (ticket.stoppedAt === undefined && !canAct(ticket.threadId, ticket.call.controlId))
          ticket.stoppedAt = now;
        if (ticket.stoppedAt === undefined || now - ticket.stoppedAt < ORPHAN_CALL_GRACE_MS)
          return {
            holderThreadId: ticket.threadId,
            app: ticket.call.app ?? call.app ?? `the app with pid ${resource.pid}`,
          };
      }
      return undefined;
    },
    /** The control's proxy went away: the calls it has out now may only be stopping. */
    markStopped(threadId: ThreadId, controlId: string, now: number) {
      for (const ticket of tickets.values())
        if (ticket.threadId === threadId && ticket.call.controlId === controlId)
          ticket.stoppedAt ??= now;
    },
    reserve(threadId: ThreadId, call: Call, now: number): ComputerUseCallAdmission {
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
      tickets.set(reservationId, { threadId, call, resource, reservedAt: now, seq: seq++ });
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
      now: number,
    ): ComputerUseCallAdmission {
      const key = connectionKey(threadId, call);
      if (call.action === "close" && rememberClosed)
        closed.set(key, { threadId, controlId: call.controlId });
      const answered =
        call.action === "release" && call.completed === true
          ? tickets.get(call.reservationId)
          : undefined;
      const answeredHere =
        answered !== undefined && connectionKey(answered.threadId, answered.call) === key;
      if (answeredHere) completedAt.set(key, now);
      for (const [id, ticket] of tickets) {
        if (connectionKey(ticket.threadId, ticket.call) !== key) continue;
        // An answered call ends every earlier call of its connection, whose releases may be lost.
        if (
          call.action === "close" ||
          call.reservationId === id ||
          (answeredHere && ticket.seq < answered.seq)
        )
          tickets.delete(id);
      }
      if (
        ![...tickets.values()].some((ticket) => connectionKey(ticket.threadId, ticket.call) === key)
      )
        completedAt.delete(key);
      return { status: "released" };
    },
  };
};
