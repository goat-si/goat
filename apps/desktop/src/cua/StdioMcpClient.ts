// @effect-diagnostics globalTimers:off -- Deadlines belong to native stream callbacks outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- This client owns one native stdio transport.
import type { Readable, Writable } from "node:stream";
import type { ToolResult } from "@trycua/cua-driver";

import { readBoundedLines } from "./boundedJsonLines.ts";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 32;
const PROTOCOL_VERSION = "2025-06-18";

type ErrorCode = "closed" | "timeout" | "protocol_error" | "rpc_error" | "io_error" | "busy";
export class StdioMcpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StdioMcpError";
  }
}

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new StdioMcpError("protocol_error", "Expected an MCP object.");
  return value as Record<string, unknown>;
};

function toolResult(value: unknown): ToolResult {
  const result = object(value);
  if (
    !Array.isArray(result.content) ||
    (result.isError !== undefined && typeof result.isError !== "boolean")
  )
    throw new StdioMcpError("protocol_error", "Invalid MCP tool result.");
  const texts: string[] = [];
  const images: ToolResult["images"] = [];
  for (const item of result.content) {
    const content = object(item);
    if (content.type === "text" && typeof content.text === "string") texts.push(content.text);
    else if (
      content.type === "image" &&
      typeof content.data === "string" &&
      typeof content.mimeType === "string"
    )
      images.push({ dataBase64: content.data, mimeType: content.mimeType });
    else throw new StdioMcpError("protocol_error", "Unsupported MCP tool content.");
  }
  let structured = result.structuredContent;
  if (structured === undefined) {
    for (const text of texts) {
      try {
        structured = JSON.parse(text);
        break;
      } catch {
        /* A human-readable text item need not be JSON. */
      }
    }
  }
  return {
    text: texts.join("\n"),
    images,
    isError: result.isError === true,
    structuredJson: structured === undefined ? undefined : JSON.stringify(structured),
    degraded: false,
    rawJson: JSON.stringify(value),
  };
}

export function makeStdioMcpClient(transport: {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly exited: Promise<unknown>;
}) {
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: StdioMcpError) => void }
  >();
  let nextId = 0;
  let closed: StdioMcpError | undefined;
  let initialized = false;
  let initializing: Promise<void> | undefined;
  const ended = Promise.withResolvers<void>();
  let detach = () => {};
  const finish = (error: StdioMcpError) => {
    if (closed) return;
    closed = error;
    detach();
    transport.stdout.off("end", eof);
    transport.stdout.off("close", eof);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    ended.resolve();
  };
  const eof = () => finish(new StdioMcpError("closed", "The MCP peer closed its output."));
  const ioError = (error: Error) => finish(new StdioMcpError("io_error", error.message));
  const send = (message: object) => {
    if (closed) throw closed;
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES)
      throw new StdioMcpError("protocol_error", "MCP request exceeds the byte limit.");
    transport.stdin.write(line, (error) => {
      if (error) ioError(error);
    });
  };
  detach = readBoundedLines(
    transport.stdout,
    MAX_MESSAGE_BYTES,
    (line) => {
      const message = object(JSON.parse(line));
      if (message.jsonrpc !== "2.0")
        throw new StdioMcpError("protocol_error", "Invalid JSON-RPC version.");
      if (typeof message.method === "string") {
        if (message.id !== undefined)
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Client method not supported." },
          });
        return;
      }
      if (typeof message.id !== "number" || "result" in message === "error" in message)
        throw new StdioMcpError("protocol_error", "Invalid JSON-RPC response.");
      const call = pending.get(message.id);
      if (!call) return; // A response may arrive after its request's deadline.
      if ("error" in message) {
        const error = object(message.error);
        if (typeof error.code !== "number" || typeof error.message !== "string")
          throw new StdioMcpError("protocol_error", "Invalid JSON-RPC error.");
        call.reject(new StdioMcpError("rpc_error", error.message));
      } else call.resolve(message.result);
      pending.delete(message.id);
    },
    (error) => finish(new StdioMcpError("protocol_error", error.message)),
  );
  transport.stdout.once("end", eof);
  transport.stdout.once("close", eof);
  transport.stdout.on("error", ioError);
  transport.stdin.on("error", ioError);
  void transport.exited.then(eof, ioError);
  if (transport.stdout.destroyed || transport.stdout.readableEnded || transport.stdin.destroyed)
    eof();

  const request = (method: string, params: object): Promise<unknown> => {
    if (closed) return Promise.reject(closed);
    if (pending.size >= MAX_PENDING)
      return Promise.reject(new StdioMcpError("busy", "Too many pending MCP calls."));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new StdioMcpError("timeout", "MCP deadline expired for " + method + "."));
      }, 15_000);
      timer.unref?.();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };
  const initialize = () =>
    (initializing ??= (async () => {
      const result = object(
        await request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "GOAT readiness", version: "1" },
        }),
      );
      if (result.protocolVersion !== PROTOCOL_VERSION || !object(result.capabilities).tools)
        throw new StdioMcpError(
          "protocol_error",
          "The MCP peer did not negotiate the readiness protocol.",
        );
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      initialized = true;
    })());
  const close = () => {
    finish(new StdioMcpError("closed", "The MCP client closed."));
    transport.stdin.end();
  };
  return {
    initialize,
    callTool: async (name: string, argumentsJson: string) => {
      if (!initialized) await initialize();
      return toolResult(
        await request("tools/call", { name, arguments: object(JSON.parse(argumentsJson)) }),
      );
    },
    close,
    ended: ended.promise,
    uniffiDestroy: close,
    [Symbol.dispose]: close,
  };
}
