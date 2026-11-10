// @effect-diagnostics globalDate:off - A plain Cloudflare Worker with no Effect runtime.
import { DurableObject } from "cloudflare:workers";
import { fromHex, nodeIdFromSignPub, toHex } from "@goat/pen-protocol/identity";
import {
  challengeMessage,
  closePayload,
  CloseCode,
  decodeFrame,
  encodeFrame,
  FrameType,
  Limits,
  parseAck,
  readClose,
  relayOrigin,
} from "@goat/pen-protocol/wire";
import { type Env, readLimits, type RelayLimits } from "./limits.ts";

// Everything a socket needs lives in its attachment, so a hibernated Room wakes with it intact.
interface SocketState {
  /** Random per socket: handlers and getWebSockets may hand back different wrappers. */
  readonly uid: string;
  /** WebSocket message bytes sent on this socket, and the receiver's cumulative ack. */
  sent: number;
  acked: number;
  /** Accept time; idleness counts from it or the last auto-responded ping. */
  readonly at: number;
  /** Auth or pending deadline in ms since epoch, 0 when none. */
  deadline: number;
  closed: boolean;
}

interface UplinkState extends SocketState {
  readonly role: "node";
  readonly sid: 0;
  readonly nodeId: string;
  readonly origin: string;
  authed: boolean;
  challenge: string;
}

interface ClientState extends SocketState {
  readonly role: "client";
  readonly sid: number;
  pending: boolean;
  /** Uplink byte offset after this session's last DATA frame. */
  upEnd: number;
  /** This session's unacked DATA on the uplink; may overcount, never undercounts. */
  upUnacked: number;
}

type State = UplinkState | ClientState;
type Entry<S extends State = State> = readonly [WebSocket, S];

const UPLINK_TAG = "node";
const CLIENT_TAG = "client";
const READY_STATE_OPEN = 1;
const sessionTag = (sid: number) => `s:${sid}`;
const MAX_SID = 0xffffffff;

function sidStart(raw: string | undefined): number {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value >= 0 && value <= MAX_SID ? value : 0;
}
const randomId = () => toHex(crypto.getRandomValues(new Uint8Array(8)));

function read(ws: WebSocket): State | null {
  const state: State | null = ws.deserializeAttachment();
  return state && !state.closed && ws.readyState === READY_STATE_OPEN ? state : null;
}

function save(ws: WebSocket, state: State): void {
  ws.serializeAttachment(state);
}

function closeSocket(ws: WebSocket, state: State, code: number): void {
  state.closed = true;
  save(ws, state);
  try {
    ws.close(code);
  } catch {
    // Already closing.
  }
}

/** A code ws.close accepts. */
function sendableCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

export class Room extends DurableObject<Env> {
  private readonly limits: RelayLimits;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.limits = readLimits(env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const [, , kind, nodeId = ""] = new URL(request.url).pathname.split("/");
    const { 0: peer, 1: server } = new WebSocketPair();
    const now = Date.now();
    if (kind === "node") {
      const challenge = crypto.getRandomValues(new Uint8Array(Limits.CHALLENGE_LEN));
      this.ctx.acceptWebSocket(server, [UPLINK_TAG]);
      const state: UplinkState = {
        uid: randomId(),
        role: "node",
        sid: 0,
        nodeId,
        origin: relayOrigin(request.url),
        sent: challenge.length,
        acked: 0,
        at: now,
        deadline: now + this.limits.authTimeoutMs,
        closed: false,
        authed: false,
        challenge: toHex(challenge),
      };
      save(server, state);
      server.send(challenge);
      await this.armAlarm(Math.min(state.deadline, now + this.limits.idleTimeoutMs));
      return new Response(null, { status: 101, webSocket: peer });
    }

    const uplink = this.uplink();
    if (!uplink) {
      server.accept();
      server.close(CloseCode.Offline, "node offline");
      return new Response(null, { status: 101, webSocket: peer });
    }
    const sid = this.nextSid();
    this.ctx.acceptWebSocket(server, [CLIENT_TAG, sessionTag(sid)]);
    const state: ClientState = {
      uid: randomId(),
      role: "client",
      sid,
      sent: 0,
      acked: 0,
      at: now,
      deadline: now + this.limits.pendingTimeoutMs,
      closed: false,
      pending: true,
      upEnd: 0,
      upUnacked: 0,
    };
    save(server, state);
    const pending = this.clients()
      .filter(([, other]) => other.pending && other.sid !== sid)
      .sort(([, a], [, b]) => a.sid - b.sid);
    for (const [ws, other] of pending.slice(
      0,
      Math.max(0, pending.length - Limits.PENDING_MAX + 1),
    )) {
      this.endSession(ws, other, CloseCode.Caps);
    }
    const current = this.uplink();
    if (current) this.sendRelayFrame(current, encodeFrame(FrameType.Open, sid));
    await this.armAlarm(Math.min(state.deadline, now + this.limits.idleTimeoutMs));
    return new Response(null, { status: 101, webSocket: peer });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = read(ws);
    if (!state) return;
    const size =
      typeof message === "string"
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (size > Limits.MESSAGE_MAX) return this.fail(ws, state, CloseCode.TooBig);
    if (typeof message === "string") return this.onText(ws, state, message);
    const bytes = new Uint8Array(message);
    if (state.role === "client") return this.onClientData([ws, state], bytes);
    if (!state.authed) return this.authenticate(ws, bytes);
    this.onUplinkFrame([ws, state], bytes);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.onPeerGone(ws, code);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.onPeerGone(ws, 1006);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const state = read(ws);
      if (!state) continue;
      if (state.deadline !== 0 && state.deadline <= now) {
        this.fail(ws, state, state.role === "node" ? CloseCode.AuthFailed : CloseCode.Timeout);
      } else if (this.idleDeadline(ws, state) <= now) {
        this.fail(ws, state, CloseCode.Timeout);
      }
    }
    let next = Number.POSITIVE_INFINITY;
    for (const ws of this.ctx.getWebSockets()) {
      const state = read(ws);
      if (!state) continue;
      next = Math.min(
        next,
        this.idleDeadline(ws, state),
        state.deadline || Number.POSITIVE_INFINITY,
      );
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }

  private idleDeadline(ws: WebSocket, state: State): number {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return Math.max(state.at, pinged) + this.limits.idleTimeoutMs;
  }

  private async armAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  /**
   * Sids survive hibernation and uplink replacement. They are u32 (the frame header's width): past
   * 0xffffffff the counter wraps to 1 and skips 0 and every id still live, so a live id is never
   * handed out twice.
   */
  private nextSid(): number {
    let sid = this.ctx.storage.kv.get<number>("sid") ?? sidStart(this.env.SID_START);
    do {
      sid = sid >= MAX_SID || sid < 0 ? 1 : sid + 1;
    } while (this.session(sid) !== null);
    this.ctx.storage.kv.put("sid", sid);
    return sid;
  }

  private uplink(): Entry<UplinkState> | null {
    for (const ws of this.ctx.getWebSockets(UPLINK_TAG)) {
      const state = read(ws);
      if (state?.role === "node" && state.authed) return [ws, state];
    }
    return null;
  }

  private clients(): Array<Entry<ClientState>> {
    return this.ctx.getWebSockets(CLIENT_TAG).flatMap((ws) => {
      const state = read(ws);
      return state?.role === "client" ? [[ws, state] as const] : [];
    });
  }

  private session(sid: number): Entry<ClientState> | null {
    for (const ws of this.ctx.getWebSockets(sessionTag(sid))) {
      const state = read(ws);
      if (state?.role === "client") return [ws, state];
    }
    return null;
  }

  private async authenticate(ws: WebSocket, answer: Uint8Array): Promise<void> {
    // No other event may run between the check and the replacement it leads to.
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = read(ws);
      if (state?.role !== "node" || state.authed) return;
      if (!(await this.verify(state, answer))) return this.fail(ws, state, CloseCode.AuthFailed);
      for (const old of this.ctx.getWebSockets(UPLINK_TAG)) {
        const oldState = read(old);
        if (oldState?.role === "node" && oldState.authed && oldState.uid !== state.uid) {
          this.dropUplink(old, oldState, CloseCode.Replaced);
        }
      }
      state.authed = true;
      state.deadline = 0;
      state.challenge = "";
      save(ws, state);
    });
  }

  private async verify(state: UplinkState, answer: Uint8Array): Promise<boolean> {
    if (answer.length !== Limits.AUTH_ANSWER_LEN) return false;
    const signPub = answer.slice(0, 32);
    if ((await nodeIdFromSignPub(signPub)) !== state.nodeId) return false;
    try {
      const key = await crypto.subtle.importKey("raw", signPub, "Ed25519", false, ["verify"]);
      const message = challengeMessage(state.origin, state.nodeId, fromHex(state.challenge));
      return await crypto.subtle.verify("Ed25519", key, answer.slice(32), message);
    } catch {
      return false;
    }
  }

  private onText(ws: WebSocket, state: State, text: string): void {
    if (!text.startsWith("a:")) return this.fail(ws, state, CloseCode.Unsupported);
    const acked = parseAck(text);
    if (acked === null || acked < state.acked || acked > state.sent) {
      return this.fail(ws, state, CloseCode.Protocol);
    }
    state.acked = acked;
    save(ws, state);
  }

  private onUplinkFrame(uplink: Entry<UplinkState>, bytes: Uint8Array): void {
    const [ws, state] = uplink;
    const frame = decodeFrame(bytes);
    if (frame?.type === FrameType.Data) {
      const session = this.session(frame.sid);
      if (session) this.toClient(session, frame.payload);
      return;
    }
    const code = frame?.type === FrameType.Close ? readClose(frame.payload) : null;
    if (frame === null || code === null) return this.dropUplink(ws, state, CloseCode.Protocol);
    const session = this.session(frame.sid);
    if (session) closeSocket(session[0], session[1], sendableCode(code));
  }

  private toClient([ws, state]: Entry<ClientState>, payload: Uint8Array): void {
    if (state.pending) {
      const active = this.clients().filter(([, other]) => !other.pending).length;
      if (active >= Limits.ACTIVE_MAX) return this.endSession(ws, state, CloseCode.Caps);
      state.pending = false;
      state.deadline = 0;
    }
    if (state.sent - state.acked + payload.length > Limits.SOCKET_WINDOW) {
      return this.endSession(ws, state, CloseCode.Timeout);
    }
    ws.send(payload);
    state.sent += payload.length;
    save(ws, state);
  }

  private onClientData([ws, state]: Entry<ClientState>, payload: Uint8Array): void {
    const uplink = this.uplink();
    if (!uplink) return closeSocket(ws, state, CloseCode.Offline);
    const [up, upState] = uplink;
    const frame = encodeFrame(FrameType.Data, state.sid, payload);
    if (upState.acked >= state.upEnd) state.upUnacked = 0;
    const mine = state.upUnacked + frame.length;
    const others = Math.max(1, this.clients().length - 1);
    const limit =
      mine <= Limits.LIGHT_SESSION
        ? Limits.SOCKET_WINDOW
        : Limits.SOCKET_WINDOW - Limits.LIGHT_SESSION * others;
    if (upState.sent - upState.acked + frame.length > limit)
      return this.endSession(ws, state, CloseCode.Timeout);
    up.send(frame);
    upState.sent += frame.length;
    save(up, upState);
    state.upEnd = upState.sent;
    state.upUnacked = mine;
    save(ws, state);
  }

  /** OPEN and CLOSE may use RELAY_HEADROOM past the window; an uplink that leaves even that unacked is dropped. */
  private sendRelayFrame([ws, state]: Entry<UplinkState>, frame: Uint8Array): void {
    if (state.sent - state.acked + frame.length > Limits.SOCKET_WINDOW + Limits.RELAY_HEADROOM) {
      return this.dropUplink(ws, state, CloseCode.Timeout);
    }
    ws.send(frame);
    state.sent += frame.length;
    save(ws, state);
  }

  /** The relay ends a session: the client closes with code and the node hears CLOSE with it. */
  private endSession(ws: WebSocket, state: ClientState, code: number): void {
    closeSocket(ws, state, code);
    const uplink = this.uplink();
    if (uplink)
      this.sendRelayFrame(uplink, encodeFrame(FrameType.Close, state.sid, closePayload(code)));
  }

  private dropUplink(ws: WebSocket, state: UplinkState, code: number): void {
    const wasCurrent = state.authed;
    closeSocket(ws, state, code);
    if (!wasCurrent) return;
    for (const [client, clientState] of this.clients())
      closeSocket(client, clientState, CloseCode.Offline);
  }

  private fail(ws: WebSocket, state: State, code: number): void {
    if (state.role === "node") this.dropUplink(ws, state, code);
    else this.endSession(ws, state, code);
  }

  private onPeerGone(ws: WebSocket, code: number): void {
    const state: State | null = ws.deserializeAttachment();
    if (!state || state.closed) return;
    if (state.role === "node") return this.dropUplink(ws, state, CloseCode.Offline);
    closeSocket(ws, state, sendableCode(code));
    const uplink = this.uplink();
    const forwarded = code >= 1000 && code <= 4999 ? code : 1000;
    if (uplink)
      this.sendRelayFrame(uplink, encodeFrame(FrameType.Close, state.sid, closePayload(forwarded)));
  }
}
