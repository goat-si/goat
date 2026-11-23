import { describe, expect, it } from "vite-plus/test";
import { createAcpAppContext } from "./acpAppContext.ts";

const note = (text: string, key = "mcp_app_item-1") => [{ key, text }];

describe("ACP app context", () => {
  it("formats safe external blocks, escapes XML, and commits only on success", () => {
    const delivery = createAcpAppContext();
    const input = { sessionId: "s", userText: "hello", appContext: note(`a & <b> "c" 'd'`) };
    const failed = delivery.prepare(input);
    expect(failed.blocks).toEqual([
      {
        type: "text",
        text: "<external_mcp_app_item-1>a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;</external_mcp_app_item-1>",
      },
    ]);
    const retry = delivery.prepare(input);
    expect(retry.blocks).toEqual(failed.blocks);
    retry.commit();
    expect(delivery.prepare(input).blocks).toEqual([]);
    expect(delivery.prepare({ ...input, sessionId: "other" }).blocks).toEqual(failed.blocks);
    expect(delivery.prepare({ ...input, appContext: note("changed") }).blocks).toHaveLength(1);
  });

  it("skips slash commands without marking context delivered", () => {
    const delivery = createAcpAppContext();
    delivery.prepare({ sessionId: "s", userText: "  /compact", appContext: note("x") }).commit();
    expect(
      delivery.prepare({
        sessionId: "s",
        userText: "/compact",
        appContext: note("x", "invalid key"),
      }).blocks,
    ).toEqual([]);
    expect(
      delivery.prepare({ sessionId: "s", userText: "hello", appContext: note("x") }).blocks,
    ).toHaveLength(1);
  });

  it("invalidates delivered and in-flight context after compaction", () => {
    const delivery = createAcpAppContext();
    const input = { sessionId: "s", userText: "hello", appContext: note("x") };
    const old = delivery.prepare(input);
    old.commit();
    const late = delivery.prepare({ ...input, appContext: note("y") });
    delivery.invalidate("s");
    late.commit();
    expect(delivery.prepare(input).blocks).toHaveLength(1);
    expect(delivery.prepare({ ...input, appContext: note("y") }).blocks).toHaveLength(1);
  });

  it("does not let older completions overwrite newer successful deliveries", () => {
    const delivery = createAcpAppContext();
    const input = { sessionId: "s", userText: "hello", appContext: note("old") };
    const old = delivery.prepare(input);
    const newer = delivery.prepare({ ...input, appContext: note("new") });
    newer.commit();
    old.commit();
    expect(delivery.prepare({ ...input, appContext: note("new") }).blocks).toEqual([]);
    expect(delivery.prepare(input).blocks).toHaveLength(1);
  });

  it("rejects unsafe keys, duplicate keys, invalid XML and oversized input", () => {
    const delivery = createAcpAppContext();
    const prepare = (appContext: ReturnType<typeof note>) =>
      delivery.prepare({ sessionId: "s", userText: "hello", appContext });
    expect(prepare(note("x", "goat_memory")).blocks).toEqual([]);
    for (const key of ["bad><tag", "bad key", ""]) expect(() => prepare(note("x", key))).toThrow();
    expect(() => prepare(note("\u0000"))).toThrow();
    expect(() => prepare([...note("a"), ...note("b")])).toThrow();
    expect(() =>
      prepare(Array.from({ length: 65 }, (_, i) => ({ key: `k${i}`, text: "x" }))),
    ).toThrow();
    expect(() => prepare(note("é".repeat(131073)))).toThrow();
    expect(() => prepare(note("&".repeat(60000)))).toThrow();
  });

  it("evicts bounded state and rejects stale completions from evicted sessions", () => {
    const delivery = createAcpAppContext();
    const input = { sessionId: "s0", userText: "hello", appContext: note("old") };
    const old = delivery.prepare(input);
    for (let i = 1; i <= 64; i++) delivery.prepare({ ...input, sessionId: `s${i}` }).commit();
    old.commit();
    expect(delivery.prepare(input).blocks).toHaveLength(1);
  });

  it("bounds total retained entries across sessions", () => {
    const delivery = createAcpAppContext();
    const input = { sessionId: "first", userText: "hello", appContext: note("x") };
    delivery.prepare(input).commit();
    delivery
      .prepare({
        ...input,
        sessionId: "second",
        appContext: Array.from({ length: 64 }, (_, i) => ({ key: `k${i}`, text: "x" })),
      })
      .commit();
    expect(delivery.prepare(input).blocks).toHaveLength(1);
  });

  it("clears state on runtime replacement and rejects old completions", () => {
    const delivery = createAcpAppContext();
    const input = { sessionId: "s", userText: "hello", appContext: note("x") };
    const old = delivery.prepare(input);
    delivery.clear();
    expect(old.commit()).toBe(false);
    expect(delivery.prepare(input).blocks).toHaveLength(1);
  });
});
