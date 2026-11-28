import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCode, type V2Event } from "@opencode/client";
import type { LaunchSpec } from "../../protocol.ts";
import { classifyOpenCodeCliVersion } from "./select.ts";

export type OpenCode2Client = ReturnType<typeof OpenCode.make>;
export type OpenCode2Event = V2Event;

/** Test-only module contract. fetch serves the real SDK; makeClient may replace it. */
export interface OpenCode2FakeModule {
  startFakeServer(input: { cwd: string; launch: LaunchSpec | null; password: string; signal: AbortSignal }): Promise<OpenCode2FakeServer>;
  makeClient?: typeof OpenCode.make;
}
export interface OpenCode2FakeServer {
  url: string;
  fetch?: typeof globalThis.fetch;
  close(): void | Promise<void>;
  onExit(callback: () => void): void;
}

export interface OpenCode2Runtime {
  readonly client: OpenCode2Client;
  readonly version: string;
  /** Single-consumer stream, already subscribed before start resolves. */
  readonly events: AsyncIterable<OpenCode2Event>;
  /** Resolves on process exit, or with undefined on close. Stream failures throw from events. */
  readonly failure: Promise<Error | undefined>;
  /** Only after the preceding stream fails; resolves after the replacement is accepted. */
  reconnect(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<AsyncIterable<OpenCode2Event>>;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error || !address || typeof address === "string") reject(error ?? new Error("port"));
        else resolve(address.port);
      });
    });
  });
}

async function launchOwned(cwd: string, launch: LaunchSpec | null, password: string, signal: AbortSignal): Promise<OpenCode2FakeServer> {
  const port = await freePort();
  if (signal.aborted) throw new Error("cancelled");
  const { OPENCODE_SERVER_PASSWORD: _old, ...environment } = { ...process.env, ...launch?.env };
  const child: ChildProcess = spawn(launch?.binary || "opencode", [...(launch?.args ?? []), "serve", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd, env: { ...environment, OPENCODE_PASSWORD: password }, stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  let closing = false;
  let exitCallback: (() => void) | undefined;
  const exitedPromise = new Promise<void>((resolve) => {
    const ended = () => { if (exited) return; exited = true; resolve(); if (!closing) exitCallback?.(); };
    child.once("exit", ended);
    child.once("error", ended);
  });
  child.stderr?.resume();
  const close = async () => {
    closing = true;
    if (exited) return;
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.kill("SIGTERM");
    await exitedPromise;
    clearTimeout(timer);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const cleanup = () => { child.stdout?.off("data", read); signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(new Error("cancelled")); };
      const read = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16_384);
        if (/opencode server listening[^\n]*\bon\s+https?:\/\/[^\s]+/i.test(output)) { cleanup(); resolve(); }
      };
      child.stdout?.on("data", read);
      signal.addEventListener("abort", abort, { once: true });
      void exitedPromise.then(() => { cleanup(); reject(new Error("exit")); });
      if (signal.aborted) abort();
    });
    child.stdout?.resume();
    return { url: `http://127.0.0.1:${port}`, close, onExit(callback) { exitCallback = callback; if (exited && !closing) callback(); } };
  } catch (error) { await close(); throw error; }
}

/** Starts one owned server, verifies its actual version, and accepts one SSE subscription. */
export async function startOpenCode2Runtime(options: {
  cwd: string;
  launch: LaunchSpec | null;
  signal?: AbortSignal;
  startupTimeoutMs?: number;
}): Promise<OpenCode2Runtime> {
  const controller = new AbortController();
  const abortExternal = () => controller.abort();
  options.signal?.addEventListener("abort", abortExternal, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), options.startupTimeoutMs ?? 15_000);
  const aborted = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(new Error("OpenCode 2 startup cancelled or timed out"));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  const password = randomBytes(32).toString("base64url");
  let server: OpenCode2FakeServer | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const failure = Promise.withResolvers<Error | undefined>();
  let processFailure: Error | undefined;
  let streamController: AbortController | undefined;
  const processExited = () => {
    if (closed || processFailure) return;
    processFailure = new Error("OpenCode 2 server exited unexpectedly");
    failure.resolve(processFailure);
    controller.abort();
  };
  const close = () => closing ??= (async () => {
    closed = true;
    controller.abort();
    streamController?.abort();
    failure.resolve(undefined);
    options.signal?.removeEventListener("abort", abortExternal);
    try { await server?.close(); }
    catch { throw new Error("OpenCode 2 server cleanup failed"); }
  })();
  try {
    const fakePath = options.launch?.env?.GOAT2_ENGINE_HELPER_SDK_OPENCODE2 ?? process.env.GOAT2_ENGINE_HELPER_SDK_OPENCODE2;
    let fake: OpenCode2FakeModule | undefined;
    if (fakePath) {
      if (!isAbsolute(fakePath)) throw new Error("Invalid OpenCode 2 fake module path");
      fake = await Promise.race([import(pathToFileURL(fakePath).href) as Promise<OpenCode2FakeModule>, aborted]);
      if (typeof fake.startFakeServer !== "function") throw new Error("Invalid OpenCode 2 fake module");
    }
    const pending = fake ? fake.startFakeServer({ cwd: options.cwd, launch: options.launch, password, signal: controller.signal }) : launchOwned(options.cwd, options.launch, password, controller.signal);
    // A fake may finish acquiring a process after cancellation; it still owns cleanup.
    void pending.then((late) => { if (controller.signal.aborted && !server) void Promise.resolve(late.close()).catch(() => {}); }, () => {});
    server = await Promise.race([pending, aborted]);
    server.onExit(processExited);
    if (controller.signal.aborted) throw processFailure ?? new Error("OpenCode 2 startup cancelled or timed out");
    type Attempt = { accepted: PromiseWithResolvers<void>; requests: number };
    let attempt: Attempt | undefined;
    let eventRequestInFlight = false;
    const transport = server.fetch ?? globalThis.fetch;
    const wrappedFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const isEvent = url.pathname === "/api/event" && (init?.method ?? (input instanceof Request ? input.method : "GET")) === "GET";
      const current = attempt;
      if (isEvent && (!current || ++current.requests !== 1)) throw new Error("Duplicate event subscription");
      if (isEvent && eventRequestInFlight) throw new Error("Previous event request is still closing");
      if (isEvent) eventRequestInFlight = true;
      try {
        const response = await transport(input, init);
        if (isEvent) {
          if (init?.signal?.aborted) {
            await response.body?.cancel().catch(() => {});
            throw new Error("Event subscription cancelled");
          }
          if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream" || !response.body) {
            await response.body?.cancel().catch(() => {});
            throw new Error("Event subscription rejected");
          }
          current!.accepted.resolve();
        }
        return response;
      } finally { if (isEvent) eventRequestInFlight = false; }
    };
    const client = (fake?.makeClient ?? OpenCode.make)({ baseUrl: server.url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}` }, fetch: wrappedFetch });
    const info = await Promise.race([client.server.info({ signal: controller.signal }), aborted]);
    const identified = typeof info?.version === "string" ? classifyOpenCodeCliVersion(info.version) : undefined;
    if (!identified || identified.generation !== "v2" || identified.version !== info.version) throw new Error("OpenCode 2 server version could not be verified");
    let active = false;
    let opened = false;
    let reconnectAllowed = false;
    const openStream = async (streamOptions?: { signal?: AbortSignal; timeoutMs?: number }): Promise<AsyncIterable<OpenCode2Event>> => {
      if (closed || processFailure || controller.signal.aborted) throw processFailure ?? new Error("OpenCode 2 runtime is closed");
      if (active || eventRequestInFlight) throw new Error("OpenCode 2 event stream is already active or closing");
      if (opened && !reconnectAllowed) throw new Error("OpenCode 2 event stream was stopped by its consumer");
      opened = true;
      reconnectAllowed = false;
      active = true;
      const local = new AbortController();
      streamController = local;
      const stop = () => local.abort();
      controller.signal.addEventListener("abort", stop, { once: true });
      streamOptions?.signal?.addEventListener("abort", stop, { once: true });
      if (streamOptions?.signal?.aborted || controller.signal.aborted) stop();
      const timeout = setTimeout(stop, streamOptions?.timeoutMs ?? options.startupTimeoutMs ?? 15_000);
      const cancelled = new Promise<never>((_, reject) => {
        const rejectAbort = () => reject(processFailure ?? new Error("OpenCode 2 event subscription cancelled or timed out"));
        local.signal.addEventListener("abort", rejectAbort, { once: true });
        if (local.signal.aborted) rejectAbort();
      });
      const thisAttempt: Attempt = { accepted: Promise.withResolvers<void>(), requests: 0 };
      attempt = thisAttempt;
      const iterator = client.event.subscribe({ signal: local.signal })[Symbol.asyncIterator]();
      let ended = false;
      let streamError: Error | undefined;
      const finish = async (message?: string, recoverable = true) => {
        if (ended) return;
        ended = true;
        if (message && !closed && !processFailure) streamError = new Error(message);
        await iterator.return?.();
        if (attempt === thisAttempt) attempt = undefined;
        if (streamController === local) streamController = undefined;
        controller.signal.removeEventListener("abort", stop);
        streamOptions?.signal?.removeEventListener("abort", stop);
        active = false;
        reconnectAllowed = recoverable;
      };
      const next = async () => {
        try {
          const item = await iterator.next();
          if (item.done) await finish("OpenCode 2 event stream ended unexpectedly");
          if (processFailure) throw processFailure;
          if (streamError) throw streamError;
          return item;
        } catch (error) {
          if (processFailure) { await finish(); throw processFailure; }
          if (closed) { await finish(); return { done: true as const, value: undefined }; }
          await finish("OpenCode 2 event stream failed");
          throw streamError ?? new Error("OpenCode 2 event stream failed");
        }
      };
      const first = next();
      void first.catch(() => {});
      try {
        await Promise.race([thisAttempt.accepted.promise, first.then((item) => { if (item.done) throw new Error("OpenCode 2 event stream ended unexpectedly"); return new Promise<never>(() => {}); }), cancelled]);
        if (ended || local.signal.aborted) throw processFailure ?? streamError ?? new Error("OpenCode 2 event subscription cancelled or timed out");
      } catch (error) {
        local.abort();
        await finish();
        throw processFailure ?? new Error("OpenCode 2 event subscription could not be accepted");
      } finally {
        clearTimeout(timeout);
        streamOptions?.signal?.removeEventListener("abort", stop);
      }
      let consumed = false;
      return {
        async *[Symbol.asyncIterator]() {
          if (consumed) throw new Error("OpenCode 2 events have a single consumer");
          consumed = true;
          try {
            let item = await first;
            while (!item.done) {
              if (processFailure) throw processFailure;
              yield item.value;
              item = await next();
            }
          } finally {
            if (!ended) { local.abort(); await finish("OpenCode 2 event stream stopped unexpectedly", false); }
          }
        },
      };
    };
    const events = await openStream();
    options.signal?.removeEventListener("abort", abortExternal);
    return { client, version: info.version, events, failure: failure.promise, reconnect: openStream, close };
  } catch {
    await close().catch(() => {});
    throw processFailure ?? new Error("OpenCode 2 runtime could not start or verify its event subscription");
  } finally { clearTimeout(timer); }
}
