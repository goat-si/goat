import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fakeSdkPath, loadSdk } from "../../sdkLoader.ts";
import { HelperError, type LaunchSpec } from "../../protocol.ts";
import { resolveOpenCodeConfigContent } from "./openCodeConfigContent.ts";

export type Sdk = typeof import("@opencode-ai/sdk/v2") & {
  // Only the injected test SDK implements this process substitute.
  startFakeServer?: () => Promise<{ url: string; password?: string; close(): void; onExit?(callback: () => void): void }>;
};
export async function sdk(): Promise<Sdk> {
  return loadSdk<Sdk>("opencode", "@opencode-ai/sdk/v2");
}

export interface Server {
  url: string;
  password: string;
  close(): Promise<void>;
  onExit(callback: () => void): void;
}

// OpenCodeRuntime.ts:565-575: choose a free loopback port before starting the CLI.
async function freePort(): Promise<number> {
  const listener = createServer();
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") { listener.close(); reject(new Error("no port")); return; }
      listener.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

// Adapted from OpenCodeRuntime.ts:559-680 at 916b5ccc1b2. The child inherits the
// helper process group so the Rust driver's group cleanup also covers it.
export async function startServer(module: Sdk, cwd: string, launch: LaunchSpec | null): Promise<Server> {
  if (fakeSdkPath("opencode") && module.startFakeServer) {
    const server = await module.startFakeServer();
    return { url: server.url, password: server.password ?? "", close: async () => server.close(), onExit: (callback) => server.onExit?.(callback) };
  }
  const environment = { ...process.env, ...launch?.env };
  const password = environment.OPENCODE_SERVER_PASSWORD || randomBytes(32).toString("base64url");
  const port = await freePort().catch(() => { throw new HelperError("start_failed", "OpenCode could not select a loopback port"); });
  const child: ChildProcess = spawn(launch?.binary || "opencode", [
    ...(launch?.args ?? []), "serve", "--hostname=127.0.0.1", `--port=${port}`,
  ], {
    cwd, env: { ...environment, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: resolveOpenCodeConfigContent(launch?.env, process.env) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let closing = false;
  let exited = false;
  let onExit: (() => void) | undefined;
  child.on("exit", () => { exited = true; if (!closing) onExit?.(); });
  child.on("error", () => { if (!closing) onExit?.(); });
  child.stderr?.resume();
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("timeout")), 15_000);
      const done = (error?: Error, value?: string) => {
        clearTimeout(timer);
        child.stdout?.off("data", read);
        child.off("error", failed);
        child.off("exit", ended);
        if (error || !value) reject(error); else resolve(value);
      };
      const read = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString()).slice(-16_384);
        const match = /opencode server listening[^\n]*\bon\s+(https?:\/\/[^\s]+)/.exec(buffer);
        if (match?.[1]) done(undefined, match[1]);
      };
      const failed = () => done(new Error("spawn"));
      const ended = () => done(new Error("exit"));
      child.stdout?.on("data", read); child.once("error", failed); child.once("exit", ended);
    });
    child.stdout?.resume();
    return {
      url, password,
      onExit(callback) { onExit = callback; if (exited && !closing) callback(); },
      async close() {
        closing = true;
        if (exited) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
          child.kill("SIGTERM");
        });
      },
    };
  } catch {
    closing = true; child.kill("SIGKILL");
    throw new HelperError("start_failed", "OpenCode server could not start");
  }
}

export function client(module: Sdk, server: Server, cwd: string) {
  return module.createOpencodeClient({ baseUrl: server.url, directory: cwd, throwOnError: true,
    ...(server.password ? { headers: { Authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}` } } : {}),
  });
}

// OpenCodeRuntime.ts:160-195: trust the running server's health, not only the CLI probe.
export async function verifyServerVersion(api: ReturnType<typeof client>): Promise<string> {
  const health = await api.global.health({ signal: AbortSignal.timeout(5_000) });
  if (!health.data?.healthy || !/^1\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(health.data.version)) {
    throw new HelperError("start_failed", "OpenCode 1.x server version could not be verified");
  }
  return health.data.version;
}
