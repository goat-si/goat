import { describe, expect, it } from "vitest";
import { Outbox, memoryStorage, type OutboxEntry } from "./outbox.ts";
import type { ClientFrame } from "./wire.ts";

let n = 0;
const ids = () => `id${++n}`;
const sentFrames = () => { const out: ClientFrame[] = []; return { out, send: (f: ClientFrame) => out.push(f) }; };
const toThread = () => "t1";

describe("outbox", () => {
  it("persists before sending and sends each entry once", () => {
    const store = memoryStorage();
    const box = new Outbox(store, ids);
    const e = box.add({ botId: "main" }, "hi", "followup");
    expect(store.saved[0]!.status).toBe("queued");
    const s = sentFrames();
    box.flush(toThread, (f) => { expect(store.saved[0]!.status).toBe("sending"); s.send(f); });
    box.flush(toThread, s.send);
    expect(s.out).toHaveLength(1);
    expect(s.out[0]).toMatchObject({ type: "send_input", clientRequestId: e.clientRequestId, threadId: "t1", text: "hi" });
  });
  it("turns sending into unconfirmed after a reload and never resends by itself", () => {
    const store = memoryStorage([{ clientRequestId: "c", target: { threadId: "t1" }, text: "x", mode: "followup", reqIds: ["r1"], status: "sending", error: null, createdAt: "" } satisfies OutboxEntry]);
    const box = new Outbox(store, ids);
    expect(box.list()[0]!.status).toBe("unconfirmed");
    const s = sentFrames();
    box.flush(toThread, s.send);
    expect(s.out).toHaveLength(0);
  });
  it("settles on command_result ok and is removed when input.accepted arrives (either order)", () => {
    const box = new Outbox(memoryStorage(), ids);
    const e = box.add({ threadId: "t1" }, "a", "followup");
    const s = sentFrames();
    box.flush(toThread, s.send);
    const reqId = (s.out[0] as { reqId: string }).reqId;
    box.onResult({ type: "command_result", reqId, ok: true });
    expect(box.list()[0]!.status).toBe("confirmed");
    box.onAccepted(new Set([e.clientRequestId]));
    expect(box.list()).toHaveLength(0);
    const e2 = box.add({ threadId: "t1" }, "b", "followup");
    box.flush(toThread, s.send);
    box.onAccepted(new Set([e2.clientRequestId]));
    box.onResult({ type: "command_result", reqId: (s.out[1] as { reqId: string }).reqId, ok: true });
    expect(box.list()).toHaveLength(0);
  });
  it("shows a failed reply and resends only on request with the same clientRequestId", () => {
    const box = new Outbox(memoryStorage(), ids);
    const e = box.add({ threadId: "t1" }, "a", "followup");
    const s = sentFrames();
    box.flush(toThread, s.send);
    box.onResult({ type: "command_result", reqId: (s.out[0] as { reqId: string }).reqId, ok: false, error: { code: "steer_refused", message: "Refused", retryable: true } });
    expect(box.list()[0]).toMatchObject({ status: "failed", error: "Refused" });
    box.resend(e.clientRequestId, true, toThread, s.send);
    expect(s.out).toHaveLength(2);
    expect(s.out[1]).toMatchObject({ clientRequestId: e.clientRequestId });
    expect((s.out[1] as { reqId: string }).reqId).not.toBe((s.out[0] as { reqId: string }).reqId);
  });
  it("correlates a deduplicated reply that carries the old reqId after a resend", () => {
    const box = new Outbox(memoryStorage(), ids);
    const e = box.add({ threadId: "t1" }, "a", "followup");
    const s = sentFrames();
    box.flush(toThread, s.send);
    box.onDisconnect();
    expect(box.list()[0]!.status).toBe("unconfirmed");
    box.resend(e.clientRequestId, true, toThread, s.send);
    box.onResult({ type: "command_result", reqId: (s.out[0] as { reqId: string }).reqId, ok: true, value: { deduped: true } });
    expect(box.list()[0]!.status).toBe("confirmed");
  });
  it("Delete removes; reconnect does not resend unconfirmed, failed or confirmed", () => {
    const box = new Outbox(memoryStorage(), ids);
    const a = box.add({ threadId: "t1" }, "a", "followup");
    const s = sentFrames();
    box.flush(toThread, s.send);
    box.onDisconnect();
    box.flush(toThread, s.send);
    expect(s.out).toHaveLength(1);
    box.remove(a.clientRequestId);
    expect(box.list()).toHaveLength(0);
  });
});
