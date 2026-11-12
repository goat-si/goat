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
import { type Env, readLimits, type RelayLimits, tracksTraffic } from "./limits.ts";
import {
  addCounts,
  type Counts,
  flushTotals,
  isEmpty,
  NO_COUNTS,
  sqlTotalsStore,
  type TotalsStore,
  writableAt,
} from "./traffic.ts";

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
  /** Session counts the totals row does not hold yet (it is written at most once a minute). */
  carry?: Counts;
}

interface ClientState extends SocketState {
  readonly role: "client";
  readonly sid: number;
  readonly order?: number;
  pending: boolean;
  /** Uplink byte offset after this session's last DATA frame. */
  upEnd: number;
  /** This session's unacked DATA on the uplink; may overcount, never undercounts. */
  upUnacked: number;
  /**
   * The node id, when it was listed at admission: payload bytes relayed toward the node and from
   * it, and how much of them the totals hold. The list is checked again before anything is written.
   */
  track?: string;
  toNode?: number;
  fromNode?: number;
  countedTo?: number;
  countedFrom?: number;
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

/** The session's bytes the totals do not hold yet, now counted. */
function takeUncounted(state: ClientState): Counts {
  const toNode = (state.toNode ?? 0) - (state.countedTo ?? 0);
  const fromNode = (state.fromNode ?? 0) - (state.countedFrom ?? 0);
  state.countedTo = state.toNode ?? 0;
  state.countedFrom = state.fromNode ?? 0;
  return { ...NO_COUNTS, toNode, fromNode };
}

export class Room extends DurableObject<Env> {
  private readonly limits: RelayLimits;
  private readonly totals: TotalsStore;
  /** Counts not written yet while no authenticated uplink carries them (lost if the Room is evicted). */
  private unsaved: Counts = NO_COUNTS;
  /** The node id unsaved belongs to, kept with it in memory. */
  private unsavedNode: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.limits = readLimits(env);
    this.totals = sqlTotalsStore(ctx.storage.sql);
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
      order: this.nextOrder(),
      sent: 0,
      acked: 0,
      at: now,
      deadline: now + this.limits.pendingTimeoutMs,
      closed: false,
      pending: true,
      upEnd: 0,
      upUnacked: 0,
      ...(tracksTraffic(this.env, nodeId)
        ? { track: nodeId, toNode: 0, fromNode: 0, countedTo: 0, countedFrom: 0 }
        : {}),
    };
    save(server, state);
    const pending = this.clients()
      .filter(([, other]) => other.pending && other.sid !== sid)
      .sort(([, a], [, b]) => {
        if (a.order === undefined && b.order === undefined) return a.at - b.at || a.sid - b.sid;
        if (a.order === undefined) return -1;
        if (b.order === undefined) return 1;
        return a.order - b.order;
      });
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
    this.writeTotalsIfDue(now);
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
    if (this.hasUnwritten()) next = Math.min(next, this.nextWrite());
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

  private nextOrder(): number {
    const order = (this.ctx.storage.kv.get<number>("admissionOrder") ?? 0) + 1;
    this.ctx.storage.kv.put("admissionOrder", order);
    return order;
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
      // Counts a replaced or lost uplink carried move to this one, which survives hibernation.
      state.carry = addCounts(state.carry ?? NO_COUNTS, this.unsaved);
      this.unsaved = NO_COUNTS;
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
    if (session) this.closeClient(session[0], session[1], sendableCode(code));
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
    const fresh = state.track !== undefined && payload.length > 0 && !this.uncounted(state);
    state.sent += payload.length;
    if (state.track) state.fromNode = (state.fromNode ?? 0) + payload.length;
    save(ws, state);
    if (fresh) this.armTotals();
  }

  private onClientData([ws, state]: Entry<ClientState>, payload: Uint8Array): void {
    const uplink = this.uplink();
    if (!uplink) return this.closeClient(ws, state, CloseCode.Offline);
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
    const fresh = state.track !== undefined && payload.length > 0 && !this.uncounted(state);
    if (state.track) state.toNode = (state.toNode ?? 0) + payload.length;
    save(ws, state);
    if (fresh) this.armTotals();
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
    this.closeClient(ws, state, code);
    const uplink = this.uplink();
    if (uplink)
      this.sendRelayFrame(uplink, encodeFrame(FrameType.Close, state.sid, closePayload(code)));
  }

  private dropUplink(ws: WebSocket, state: UplinkState, code: number): void {
    const wasCurrent = state.authed;
    if (!isEmpty(state.carry ?? NO_COUNTS)) this.unsavedNode = state.nodeId;
    this.unsaved = addCounts(this.unsaved, state.carry ?? NO_COUNTS);
    state.carry = NO_COUNTS;
    closeSocket(ws, state, code);
    if (!wasCurrent) return;
    for (const [client, clientState] of this.clients())
      this.closeClient(client, clientState, CloseCode.Offline);
  }

  private fail(ws: WebSocket, state: State, code: number): void {
    if (state.role === "node") this.dropUplink(ws, state, code);
    else this.endSession(ws, state, code);
  }

  private onPeerGone(ws: WebSocket, code: number): void {
    const state: State | null = ws.deserializeAttachment();
    if (!state || state.closed) return;
    if (state.role === "node") return this.dropUplink(ws, state, CloseCode.Offline);
    this.closeClient(ws, state, sendableCode(code));
    const uplink = this.uplink();
    const forwarded = code >= 1000 && code <= 4999 ? code : 1000;
    if (uplink)
      this.sendRelayFrame(uplink, encodeFrame(FrameType.Close, state.sid, closePayload(forwarded)));
  }

  /** Closes a client socket and adds its session to the totals. */
  private closeClient(ws: WebSocket, state: ClientState, code: number): void {
    const ending = !state.closed;
    const bytes = takeUncounted(state);
    closeSocket(ws, state, code);
    if (!ending || !state.track) return;
    if (!tracksTraffic(this.env, state.track)) return this.discardTotals();
    this.unsavedNode = state.track;
    const answered = state.pending ? 0 : 1;
    this.keepTotals(
      addCounts(this.unwritten(), { ...bytes, sessions: answered, unanswered: 1 - answered }),
      Date.now(),
    );
  }

  /** What the uplink and the Room carry for the totals row, now taken from them. */
  private unwritten(): Counts {
    const uplink = this.uplink();
    const carried = addCounts(this.unsaved, uplink?.[1].carry ?? NO_COUNTS);
    this.unsaved = NO_COUNTS;
    if (uplink && !isEmpty(uplink[1].carry ?? NO_COUNTS)) {
      uplink[1].carry = NO_COUNTS;
      save(uplink[0], uplink[1]);
    }
    return carried;
  }

  /**
   * Writes pending to the totals row when a minute has passed since the last write, else carries
   * it on the authenticated uplink's attachment, which survives hibernation.
   */
  private keepTotals(pending: Counts, now: number): void {
    const left = flushTotals(this.totals, pending, now, this.limits.totalsEveryMs);
    if (isEmpty(left)) return;
    const uplink = this.uplink();
    if (uplink) {
      uplink[1].carry = left;
      save(uplink[0], uplink[1]);
    } else {
      this.unsaved = left;
    }
    this.ctx.waitUntil(this.armAlarm(this.nextWrite()));
  }

  /** On an alarm: once the minute has passed, writes what open sessions relayed and what is carried. */
  private writeTotalsIfDue(now: number): void {
    if (!this.hasUnwritten() || now < this.nextWrite()) return;
    if (!this.stillListed()) return this.discardTotals();
    let pending = this.unwritten();
    for (const [ws, state] of this.clients()) {
      pending = addCounts(pending, takeUncounted(state));
      save(ws, state);
    }
    this.keepTotals(pending, now);
  }

  /**
   * Whether this Room's node is still in the list this version runs with. Counts can outlive a
   * list change (in socket attachments, or on an object still running its previous version), so
   * every write checks again.
   */
  private stillListed(): boolean {
    const node =
      this.uplink()?.[1].nodeId ??
      this.clients().find(([, s]) => s.track)?.[1].track ??
      this.unsavedNode;
    return node !== undefined && tracksTraffic(this.env, node);
  }

  /** Drops every count not written yet, and stops counting open sessions: the node is no longer listed. */
  private discardTotals(): void {
    this.unsaved = NO_COUNTS;
    const uplink = this.uplink();
    if (uplink && !isEmpty(uplink[1].carry ?? NO_COUNTS)) {
      uplink[1].carry = NO_COUNTS;
      save(uplink[0], uplink[1]);
    }
    for (const [ws, state] of this.clients()) {
      if (state.track === undefined) continue;
      delete state.track;
      state.countedTo = state.toNode ?? 0;
      state.countedFrom = state.fromNode ?? 0;
      save(ws, state);
    }
  }

  private hasUnwritten(): boolean {
    if (!isEmpty(this.unsaved) || !isEmpty(this.uplink()?.[1].carry ?? NO_COUNTS)) return true;
    return this.clients().some(([, state]) => state.track !== undefined && this.uncounted(state));
  }

  private uncounted(state: ClientState): boolean {
    return (
      (state.toNode ?? 0) !== (state.countedTo ?? 0) ||
      (state.fromNode ?? 0) !== (state.countedFrom ?? 0)
    );
  }

  /** An open session has bytes the totals lack: wake when the next write is allowed. */
  private armTotals(): void {
    this.ctx.waitUntil(this.armAlarm(this.nextWrite()));
  }

  private nextWrite(): number {
    return writableAt(this.totals.read(), this.limits.totalsEveryMs);
  }
}
