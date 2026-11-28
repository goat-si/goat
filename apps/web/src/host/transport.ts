// Transport to the host: JSON frames over WebSocket (structure/30_wire.md), or the in-page fake host.
import type { ClientFrame, HostFrame } from "./wire.ts";

export type ConnectionState = "connecting" | "open" | "closed";

export interface Transport {
  send(frame: ClientFrame): void;
  onFrame(cb: (frame: HostFrame) => void): () => void;
  onState(cb: (state: ConnectionState) => void): () => void;
  readonly state: ConnectionState;
  close(): void;
}

/** Real host: `{wsUrl, token}` from preload `window.goat2Host` or `?host=&token=`. Reconnects with backoff. */
export class WebSocketTransport implements Transport {
  state: ConnectionState = "connecting";
  private ws: WebSocket | null = null;
  private frameCbs = new Set<(f: HostFrame) => void>();
  private stateCbs = new Set<(s: ConnectionState) => void>();
  private backoff = 500;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
    this.open();
  }

  private open() {
    const u = new URL(this.url);
    u.searchParams.set("token", this.token);
    const ws = new WebSocket(u.toString());
    this.ws = ws;
    this.setState("connecting");
    ws.onopen = () => { this.backoff = 500; this.setState("open"); };
    ws.onmessage = (ev) => {
      let frame: HostFrame;
      try { frame = JSON.parse(String(ev.data)) as HostFrame; } catch { return; }
      for (const cb of this.frameCbs) cb(frame);
    };
    ws.onclose = () => {
      this.ws = null;
      this.setState("closed");
      if (this.closed) return;
      this.timer = setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
  }

  private setState(s: ConnectionState) {
    this.state = s;
    for (const cb of this.stateCbs) cb(s);
  }

  send(frame: ClientFrame) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }
  onFrame(cb: (f: HostFrame) => void) { this.frameCbs.add(cb); return () => { this.frameCbs.delete(cb); }; }
  onState(cb: (s: ConnectionState) => void) { this.stateCbs.add(cb); return () => { this.stateCbs.delete(cb); }; }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }
}
