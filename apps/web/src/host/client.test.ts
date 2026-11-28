import { describe, expect, it } from "vitest";
import { FakeHost } from "./fakeHost.ts";
import { HostClient } from "./client.ts";
import { memoryStorage } from "./outbox.ts";
import { demoWorld, withQueue } from "./demoWorld.ts";
import { botRows, deriveThread, workerThreads } from "./store.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const setup = (connect: "open" | "never" = "open", world = demoWorld()) => {
  const fake = new FakeHost(world, { connect, runStepMs: 5 });
  const client = new HostClient(fake, { outbox: memoryStorage(), cache: null, demo: "test" });
  return { fake, client };
};

describe("client + fake host", () => {
  it("subscribes to cards and bots, then replays a thread", async () => {
    const { client } = setup();
    await tick(5);
    const s = client.getSnapshot();
    expect(s.connection).toBe("open");
    expect(s.state.cardsCaughtUp).toBe(true);
    const rows = botRows(s.state);
    expect(rows.find((r) => r.botId === "reviewer")).toMatchObject({ name: "Reviewer", state: "needs-you", line: "Your call on #7712" });
    expect(workerThreads(s.state, "t-reviewer").map((c) => c.title)).toEqual(["Fix empty list fallback", "Review #7712", "Review #7709"]);
    const stop = client.watchThread("t-reviewer");
    await tick(5);
    const d = deriveThread(client.getSnapshot().state.threads["t-reviewer"]);
    expect(d.openRequests[0]!.kind).toBe("decision");
    expect(d.entries.map((e) => e.kind)).toEqual(["user", "bot", "child"]);
    stop();
  });
  it("send-first: holds the message while offline", async () => {
    const { client, fake } = setup("never");
    client.sendMessage({ botId: "main" }, "hello", "followup");
    await tick(5);
    expect(client.getSnapshot().outbox[0]!.status).toBe("queued");
    expect(fake.received).toHaveLength(0);
  });
  it("sends once connected; the log line replaces the outbox entry; dedupes a resend", async () => {
    const { client, fake } = setup();
    await tick(5);
    const stop = client.watchThread("t-main");
    client.sendMessage({ botId: "main" }, "hello", "followup");
    await tick(30);
    const snap = client.getSnapshot();
    expect(snap.outbox).toHaveLength(0);
    const d = deriveThread(snap.state.threads["t-main"]);
    expect(d.entries.filter((e) => e.kind === "user").map((e) => (e as { text: string }).text)).toEqual(["hello"]);
    const sent = fake.received.find((f) => f.type === "send_input")!;
    fake.send({ ...sent, reqId: "again" } as typeof sent);
    await tick(5);
    expect(fake.world.threads["t-main"]!.lines.filter((l) => l.type === "input.accepted")).toHaveLength(1);
    stop();
  });
  it("lost reply then explicit Resend settles via the deduplicated result", async () => {
    const { client, fake } = setup();
    await tick(5);
    client.sendMessage({ threadId: "t-main" }, "x", "followup");
    fake.drop();
    await tick(5);
    expect(client.getSnapshot().outbox[0]!.status).toBe("unconfirmed");
    fake.reconnect();
    await tick(5);
    expect(client.getSnapshot().outbox[0]!.status).toBe("unconfirmed");
    client.resend(client.getSnapshot().outbox[0]!.clientRequestId);
    await tick(10);
    const e = client.getSnapshot().outbox[0];
    expect(e === undefined || e.status === "confirmed").toBe(true);
    expect(fake.world.threads["t-main"]!.lines.filter((l) => l.type === "input.accepted")).toHaveLength(1);
  });
  it("resolve_request with an option clears needs-you; queue commands emit input.changed", async () => {
    const { client, fake } = setup("open", withQueue(demoWorld()));
    await tick(5);
    const r = await client.command({ type: "resolve_request", threadId: "t-reviewer", requestId: "req-merge", outcome: "answered", optionId: "fix" });
    expect(r.ok).toBe(true);
    await tick(5);
    expect(client.getSnapshot().state.cards["t-reviewer"]!.status).not.toBe("needs_you");
    const stop = client.watchThread("t-billing");
    await tick(5);
    client.sendMessage({ threadId: "t-billing" }, "second", "followup");
    await tick(10);
    const q = deriveThread(client.getSnapshot().state.threads["t-billing"]).queued;
    expect(q.map((x) => x.text)).toEqual(["Also add a regression test for the sidebar key change", "second"]);
    await client.command({ type: "reorder_queued", threadId: "t-billing", inputIds: [q[1]!.inputId, q[0]!.inputId] });
    await client.command({ type: "edit_queued", threadId: "t-billing", inputId: "in-q1", text: "edited" });
    await tick(5);
    expect(deriveThread(client.getSnapshot().state.threads["t-billing"]).queued.map((x) => x.text)).toEqual(["second", "edited"]);
    const bad = await client.command({ type: "cancel_queued", threadId: "t-billing", inputId: "nope" });
    expect(bad.error?.reason).toBe("not_queued");
    expect(fake.received.some((f) => f.type === "edit_queued")).toBe(true);
    stop();
  });
  it("same clientRequestId with different args is refused", async () => {
    const { client } = setup();
    await tick(5);
    await client.command({ type: "rename_thread", threadId: "t-main", title: "A" }, "fixed-id");
    const r = await client.command({ type: "rename_thread", threadId: "t-main", title: "B" }, "fixed-id");
    expect(r.error?.reason).toBe("idempotency_conflict");
  });
  it("an auth response is refused and its secrets never reach the received log", async () => {
    const { client, fake } = setup();
    await tick(5);
    const secret = "SECRET_SENTINEL_web";
    const cred = await client.command({ type: "provider_auth_respond", instanceId: "codex", flowId: "f", interactionId: "i", response: { type: "credentials", values: { apiKey: secret } } });
    expect(cred.ok).toBe(false);
    expect(cred.error?.reason).toBe("not_available");
    const term = await client.command({ type: "provider_auth_respond", instanceId: "codex", flowId: "f", interactionId: "i", response: { type: "terminal", data: secret } });
    expect(term.ok).toBe(false);
    const recorded = fake.received.filter((f) => f.type === "provider_auth_respond");
    expect(recorded).toHaveLength(2);
    expect(JSON.stringify(fake.received)).not.toContain(secret);
    expect(JSON.stringify(recorded[0])).toContain("apiKey");
  });
});
