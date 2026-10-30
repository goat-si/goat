import { migratingStorage } from "@goat/client-runtime/storage-migration";

/**
 * Network access and Tailscale HTTPS changes relaunch the desktop app, which drops every open
 * dialog. A one-shot note in localStorage brings the user back to the connect flow they started.
 */
export type ConnectFlow = "phone-qr" | "pairing-link" | "connections";

const STORAGE_KEY = "goat:connect-flow-resume:v1";
// Long enough for a slow relaunch, short enough that a later launch is not hijacked.
export const CONNECT_FLOW_RESUME_TTL_MS = 10 * 60_000;

const FLOW_HASH: Record<ConnectFlow, string> = {
  "phone-qr": "hub-device",
  "pairing-link": "authorized-clients",
  connections: "connections-environment",
};

let requested: ConnectFlow | null = null;
// A note only resumes in a later renderer load, so a relaunch that never happens cannot fire it here.
const LAUNCH_ID = String(performance.timeOrigin);

function storage() {
  try {
    return migratingStorage(window.localStorage as Storage);
  } catch {
    return null;
  }
}

function isConnectFlow(value: unknown): value is ConnectFlow {
  return value === "phone-qr" || value === "pairing-link" || value === "connections";
}

/** Records which flow opened a restart confirm; the plain switch leaves it as Connections. */
export function requestConnectFlowResume(flow: ConnectFlow): void {
  requested = flow;
}

/** Persists the requested flow just before the desktop bridge call that relaunches the app. */
export function armConnectFlowResume(now = Date.now(), launchId = LAUNCH_ID): void {
  const flow = requested ?? "connections";
  requested = null;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ flow, savedAt: now, launchId }));
  } catch {
    /* Without storage the app still restarts; the user reopens the flow by hand. */
  }
}

/** Drops the note when the user cancels or the change fails without a relaunch. */
export function cancelConnectFlowResume(): void {
  requested = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing was stored. */
  }
}

function readNote(): {
  readonly flow: ConnectFlow;
  readonly savedAt: number;
  readonly launchId: unknown;
} | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { flow, savedAt, launchId } = value as Record<string, unknown>;
    return isConnectFlow(flow) && typeof savedAt === "number" ? { flow, savedAt, launchId } : null;
  } catch {
    return null;
  }
}

export function peekConnectFlowResume(now = Date.now()): ConnectFlow | null {
  const note = readNote();
  if (note === null || note.launchId === LAUNCH_ID) return null;
  const age = now - note.savedAt;
  return age >= 0 && age <= CONNECT_FLOW_RESUME_TTL_MS ? note.flow : null;
}

/** Consumes the note once the resumed flow has been shown, so it reopens once. */
export function finishConnectFlowResume(flow: ConnectFlow): void {
  if (readNote()?.flow === flow) cancelConnectFlowResume();
}

export function connectFlowResumeHash(flow: ConnectFlow): string {
  return FLOW_HASH[flow];
}
