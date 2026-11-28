import type { OpenCode2FakeModule } from "../../src/engines/opencode2/runtime.ts";

export const state = {
  started: Promise.withResolvers<void>(),
  requested: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  password: "",
  authorizations: [] as (string | null)[],
  requests: [] as string[],
  version: "2.0.28",
  infoStatus: 200,
  eventStatus: 200,
  contentType: "text/event-stream; charset=utf-8",
  closeCount: 0,
  exited: undefined as (() => void) | undefined,
  stream: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
  cancelled: false,
  earlyEvent: false,
};

export function reset() {
  Object.assign(state, { started: Promise.withResolvers<void>(), requested: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), password: "", authorizations: [], requests: [], version: "2.0.28", infoStatus: 200, eventStatus: 200, contentType: "text/event-stream; charset=utf-8", closeCount: 0, exited: undefined, stream: undefined, cancelled: false, earlyEvent: false });
}

export const startFakeServer: OpenCode2FakeModule["startFakeServer"] = async (input) => {
  state.password = input.password;
  state.started.resolve();
  return {
    url: "http://127.0.0.1:9234",
    onExit(callback) { state.exited = callback; },
    close() { state.closeCount++; },
    async fetch(input, init) {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      state.requests.push(url.pathname);
      state.authorizations.push(new Headers(init?.headers).get("authorization"));
      if (url.pathname === "/api/info") return new Response(JSON.stringify({ version: state.version, pid: 42, urls: [], paths: { tmp: "/tmp" } }), { status: state.infoStatus, headers: { "content-type": "application/json" } });
      if (url.pathname !== "/api/event") throw new Error("unexpected request");
      state.requested.resolve();
      await Promise.race([state.release.promise, new Promise<never>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new Error("aborted"));
        else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })]);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          state.stream = controller;
          if (state.earlyEvent) controller.enqueue(new TextEncoder().encode('data: {"id":"evt-1","type":"server.connected","data":{}}\n\n'));
          init?.signal?.addEventListener("abort", () => { state.cancelled = true; try { controller.close(); } catch {} }, { once: true });
        },
        cancel() { state.cancelled = true; },
      });
      return new Response(stream, { status: state.eventStatus, headers: { "content-type": state.contentType } });
    },
  };
};

export function emit(value: object) {
  state.stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
}
