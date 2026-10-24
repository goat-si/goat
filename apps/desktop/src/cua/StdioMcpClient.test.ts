// @effect-diagnostics nodeBuiltinImport:off -- In-memory pipes exercise the MCP wire contract.
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeStdioMcpClient, StdioMcpError } from "./StdioMcpClient.ts";

const peer = (answer?: (request: Record<string, unknown>) => unknown) => {
  const stdout = new PassThrough();
  const exited = Promise.withResolvers<void>();
  const received: Record<string, unknown>[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      received.push(request);
      if (request.method === "initialize")
        stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fake", version: "1" },
            },
          }) + "\n",
        );
      else if (request.id !== undefined) {
        const result = answer?.(request);
        if (result !== undefined)
          stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...result }) + "\n");
      }
      done();
    },
  });
  const client = makeStdioMcpClient({ stdin, stdout, exited: exited.promise });
  return { client, stdout, stdin, received, exited };
};

describe("stdio MCP client", () => {
  it("initializes before tools/call and preserves text, images, structured content and tool errors", async () => {
    const test = peer(({ params }) => ({
      result:
        (params as { name: string }).name === "capture"
          ? {
              content: [
                { type: "text", text: "capture" },
                { type: "image", data: "cGl4ZWxz", mimeType: "image/png" },
              ],
              structuredContent: { element_count: 42 },
            }
          : { content: [{ type: "text", text: "denied" }], isError: true },
    }));
    using client = test.client;
    await client.initialize();
    const capture = await client.callTool("capture", '{"window_id":77}');
    expect(test.received.map(({ method }) => method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(test.received[2]).toMatchObject({
      id: 2,
      params: { name: "capture", arguments: { window_id: 77 } },
    });
    expect(capture.text).toBe("capture");
    expect(capture.images).toEqual([{ mimeType: "image/png", dataBase64: "cGl4ZWxz" }]);
    expect(JSON.parse(capture.structuredJson ?? "null")).toEqual({ element_count: 42 });
    expect(capture.isError).toBe(false);
    expect(await client.callTool("denied", "{}")).toMatchObject({ text: "denied", isError: true });
    expect(test.received[3]?.id).toBe(3);
  });

  it("rejects a JSON-RPC error with a typed error", async () => {
    const test = peer(() => ({ error: { code: -32602, message: "invalid arguments" } }));
    using client = test.client;
    await client.initialize();
    await expect(client.callTool("bad", "{}")).rejects.toMatchObject({
      code: "rpc_error",
      message: "invalid arguments",
    });
  });

  it("expires a pending call on its deadline without real time waits", async (context) => {
    vi.useFakeTimers();
    context.onTestFinished(() => vi.useRealTimers());
    const test = peer();
    using client = test.client;
    await client.initialize();
    const result = client.callTool("stuck", "{}").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ code: "timeout" });
  });

  it.each(["eof", "exit"])(
    "rejects every pending call and future calls on peer %s",
    async (end) => {
      const test = peer();
      using client = test.client;
      await client.initialize();
      const first = client.callTool("one", "{}").catch((error: unknown) => error);
      const second = client.callTool("two", "{}").catch((error: unknown) => error);
      if (end === "eof") test.stdout.end();
      else test.exited.resolve();
      expect(await first).toBeInstanceOf(StdioMcpError);
      expect(await second).toMatchObject({ code: "closed" });
      await expect(client.callTool("late", "{}")).rejects.toMatchObject({ code: "closed" });
    },
  );

  it("accepts split lines and rejects an oversized unfinished response", async () => {
    const test = peer();
    using client = test.client;
    await client.initialize();
    const result = client.callTool("split", "{}");
    test.stdout.write(
      '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]',
    );
    test.stdout.write("}}\n");
    expect(JSON.parse((await result).structuredJson ?? "null")).toEqual({ ok: true });
    const pending = client.callTool("large", "{}").catch((error: unknown) => error);
    test.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 65));
    expect(await pending).toMatchObject({ code: "protocol_error" });
  });
});
