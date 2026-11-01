// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process and owns the driver child directly.
// @effect-diagnostics globalTimers:off -- Request deadlines run at child-process callback boundaries.
// JSON-RPC lines from the driver are read field by field; their shapes are the driver's own.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

/**
 * The Linux helper's one engine: a `cua-driver mcp` child. On Linux bare `mcp` owns its runtime
 * and ends it when stdin closes, so the driver lives exactly as long as this helper holds it and
 * nothing is left behind when the helper dies.
 */

export interface DriverImage {
  readonly mimeType: string;
  readonly data: string;
}

export interface DriverToolResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: unknown;
  readonly images: ReadonlyArray<DriverImage>;
}

export interface DriverClient {
  readonly pid: number;
  readonly version: string;
  /**
   * "unsent" when the driver was already gone, so nothing reached it. "deadline" when it did not
   * answer in time and "lost" when it exited before answering: both may still have acted.
   */
  readonly call: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
    deadlineMs: number,
  ) => Promise<DriverToolResult | "deadline" | "lost" | "unsent">;
  /** Closes stdin, the driver's own end signal, and kills its process group after a grace period. */
  readonly close: () => Promise<void>;
  readonly exited: Promise<void>;
}

class DriverStartError extends Error {
  override readonly name = "DriverStartError";
}

const START_TIMEOUT_MS = 15_000;
const CLOSE_GRACE_MS = 3_000;

type Pending = (message: Record<string, unknown> | "gone") => void;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

function toolResult(value: unknown): DriverToolResult {
  const result = record(value);
  const content = Array.isArray(result.content) ? result.content.map(record) : [];
  return {
    isError: result.isError === true,
    text: content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n"),
    structured: result.structuredContent,
    images: content.flatMap((block) =>
      block.type === "image" && typeof block.data === "string"
        ? [
            {
              mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png",
              data: block.data,
            },
          ]
        : [],
    ),
  };
}

export async function startDriver(options: {
  readonly executable: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly expectedVersion: string;
}): Promise<DriverClient> {
  // Its own process group, so a forced stop reaches anything the driver started.
  const child = NodeChildProcess.spawn(options.executable, ["mcp"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...options.environment },
    detached: true,
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  child.stdin.on("error", () => undefined);
  const pending = new Map<number, Pending>();
  let gone = false;
  void exited.then(() => {
    gone = true;
    for (const resolve of pending.values()) resolve("gone");
    pending.clear();
  });
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = record(JSON.parse(line));
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  let serial = 0;
  const send = (value: object) => {
    if (!gone) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  };
  const rpc = (method: string, params: object, deadlineMs: number) =>
    new Promise<Record<string, unknown> | "gone" | "deadline" | "unsent">((resolve) => {
      if (gone) return resolve("unsent");
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        send({ method: "notifications/cancelled", params: { requestId: id, reason: "deadline" } });
        resolve("deadline");
      }, deadlineMs);
      timer.unref?.();
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      send({ id, method, params });
    });

  const kill = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  };
  const close = async () => {
    child.stdin.end();
    const timer = setTimeout(kill, CLOSE_GRACE_MS);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
  };

  const init = await rpc(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "goat-computer-use", version: "1" },
    },
    START_TIMEOUT_MS,
  );
  if (typeof init === "string" || child.pid === undefined) {
    await close();
    throw new DriverStartError(
      init === "deadline" ? "Cua Driver did not answer." : "Cua Driver exited before it answered.",
    );
  }
  const version = String(record(record(init.result).serverInfo).version ?? "");
  if (version !== options.expectedVersion) {
    await close();
    throw new DriverStartError(
      "The helper carries Cua Driver " +
        (version || "of an unknown version") +
        ", expected " +
        options.expectedVersion +
        ".",
    );
  }
  send({ method: "notifications/initialized" });

  return {
    pid: child.pid,
    version,
    call: async (tool, args, deadlineMs) => {
      const answer = await rpc("tools/call", { name: tool, arguments: args }, deadlineMs);
      if (answer === "deadline" || answer === "unsent") return answer;
      if (answer === "gone") return "lost";
      if (answer.error !== undefined)
        return {
          isError: true,
          text: String(record(answer.error).message ?? "Cua Driver failed."),
          structured: { code: "driver_error" },
          images: [],
        };
      return toolResult(answer.result);
    },
    close,
    exited,
  };
}
